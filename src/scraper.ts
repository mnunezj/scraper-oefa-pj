/**
 * Scraper principal: orquesta la navegación por el sitio JSF.
 *
 * Flujo:
 *   1. GET inicial -> ViewState + cookie de sesión.
 *   2. POST "Buscar" -> primera página de resultados.
 *   3. POST paginación (página 2, 3, ...) hasta agotar resultados.
 * Tras cada POST AJAX se actualiza el ViewState con el de la respuesta.
 */
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { HttpClient } from './http-client';
import { config } from './config';
import { logger } from './logger';
import { sleep, errorMessage } from './utils';
import { DocumentRecord, SearchCriteria } from './types';
import {
  JsfFormState,
  extractFormState,
  buildAjaxBody,
  parsePartialResponse,
  applyViewState,
} from './jsf';
import { parseTable, ParsedTable } from './parser';

export class Scraper {
  private state!: JsfFormState;
  private tableId: string | null = null;
  /** Encabezados de la tabla, capturados en la página 1 y reutilizados después. */
  private knownHeaders: string[] | undefined;

  constructor(private http: HttpClient) {}

  /** Paso 1: cargar la página inicial y capturar el estado del formulario. */
  async init(): Promise<void> {
    logger.info(`Cargando página inicial: ${config.site.pageUrl}`);
    const html = await this.http.getHtml(config.site.pageUrl, 'GET página inicial');
    this.state = extractFormState(html, config.site.pageUrl);
    logger.info(
      `Estado capturado. formId="${this.state.formId}", ViewState de ${this.state.viewState.length} chars.`
    );
  }

  /**
   * Localiza el id del botón "Buscar" dentro del HTML inicial.
   * En PrimeFaces suele ser un <button>/<input> cuyo texto/value es "Buscar".
   */
  private findSearchButtonId(html: string): string | null {
    const $ = cheerio.load(html);
    let found: string | null = null;
    $('button, input[type="submit"], input[type="button"], a').each((_, el) => {
      if (found) return;
      const $el = $(el);
      const text = ($el.text() || $el.attr('value') || '').trim().toLowerCase();
      if (/buscar|consultar/.test(text)) found = $el.attr('id') || null;
    });
    return found;
  }

  /**
   * Paso 2: ejecuta la búsqueda. Devuelve la primera página parseada.
   * @param criteria criterios de filtro (vacío = todos los resultados)
   */
  async search(criteria: SearchCriteria = {}): Promise<ParsedTable> {
    // Releer el HTML inicial para localizar el botón (no se guardó completo).
    const html = await this.http.getHtml(config.site.pageUrl, 'GET para botón');
    this.state = extractFormState(html, config.site.pageUrl);
    const buttonId = this.findSearchButtonId(html);

    if (!buttonId) {
      logger.warn(
        'No se detectó automáticamente el botón "Buscar". ' +
          'Revisa el HTML y define su id manualmente (ver README, sección "Puntos a confirmar").'
      );
    }
    logger.info(`Ejecutando búsqueda (botón="${buttonId ?? 'desconocido'}")...`);

    const formId = this.state.formId;

    // Construir el "render" con los componentes reales del sitio (relativos al form).
    // En OEFA: "formId:pgLista formId:txtNroexp". Si no hay config, usar "@form".
    const render = config.site.search.renderComponents.length
      ? config.site.search.renderComponents.map((c) => `${formId}:${c}`).join(' ')
      : '@form';
    const execute = config.site.search.execute || '@all';

    // Criterios + parámetros auxiliares que envía el navegador (scrollState del dataTable).
    const extra: Record<string, string> = {
      ...this.mapCriteriaToInputs(html, criteria),
    };
    if (config.site.dataTableId) {
      extra[`${formId}:${config.site.dataTableId}_scrollState`] = '0,0';
    }

    const body = buildAjaxBody(this.state, buttonId || this.state.formId, {
      render,
      execute,
      extra,
      ajax: true,
    });

    const res = await this.http.postForm(
      this.state.action,
      body,
      { 'Faces-Request': 'partial/ajax', 'X-Requested-With': 'XMLHttpRequest' },
      'POST búsqueda'
    );

    const parsed = this.handleTableResponse(res.data, 1);
    // Fijar el id de la tabla desde la configuración (más fiable para paginar).
    if (config.site.dataTableId) this.tableId = `${formId}:${config.site.dataTableId}`;
    return parsed;
  }

  /**
   * Paso 3: navega a una página específica del paginador de PrimeFaces.
   * @param pageNumber  número de página (1-indexado)
   */
  async goToPage(pageNumber: number): Promise<ParsedTable> {
    if (!this.tableId) throw new Error('No se conoce el id de la tabla; ejecuta search() primero.');

    const rows = config.site.rowsPerPage;
    const first = (pageNumber - 1) * rows; // offset del primer registro

    // Parámetros que envía el paginador de PrimeFaces.
    const extra: Record<string, string> = {
      [`${this.tableId}_pagination`]: 'true',
      [`${this.tableId}_first`]: String(first),
      [`${this.tableId}_rows`]: String(rows),
      [`${this.tableId}_skipChildren`]: 'true',
      [`${this.tableId}_encodeFeature`]: 'true',
      [`${this.tableId}_scrollState`]: '0,0',
    };

    const body = buildAjaxBody(this.state, this.tableId, {
      render: this.tableId,
      execute: this.tableId,
      extra,
      ajax: true,
    });

    const res = await this.http.postForm(
      this.state.action,
      body,
      { 'Faces-Request': 'partial/ajax', 'X-Requested-With': 'XMLHttpRequest' },
      `POST página ${pageNumber}`
    );

    return this.handleTableResponse(res.data, pageNumber);
  }

  /**
   * Procesa la respuesta de un POST (AJAX parcial o HTML completo), actualiza
   * el ViewState y parsea la tabla.
   */
  private handleTableResponse(data: unknown, pageNumber: number): ParsedTable {
    const text = typeof data === 'string' ? data : String(data);

    let tableHtml = text;
    // Si es una respuesta AJAX (XML), extraer el HTML del <update> y el ViewState.
    if (text.trimStart().startsWith('<?xml') || text.includes('<partial-response')) {
      const partial = parsePartialResponse(text);
      applyViewState(this.state, partial);
      // Concatenar todos los <update> con HTML (así no perdemos la tabla aunque
      // venga partida en varios bloques).
      tableHtml = Object.values(partial.updates).join('\n') || '';
    } else {
      // Respuesta HTML completa: re-extraer estado del formulario.
      try {
        this.state = extractFormState(text, config.site.pageUrl);
      } catch {
        /* puede que el fragmento no traiga form completo; seguimos */
      }
    }

    const parsed = parseTable(tableHtml, pageNumber, this.knownHeaders);
    if (parsed.tableId) this.tableId = parsed.tableId;
    // Recordar encabezados de la primera página con datos.
    if (parsed.headers.length && !this.knownHeaders) this.knownHeaders = parsed.headers;

    // "Estampar" en cada fila el ViewState vigente (lo necesita la descarga).
    for (const r of parsed.records) r.viewState = this.state.viewState;

    // Si una página viene vacía, volcar el HTML recibido para poder inspeccionarlo.
    if (parsed.records.length === 0) {
      try {
        fs.mkdirSync(config.paths.outputDir, { recursive: true });
        const dump = path.join(config.paths.outputDir, `debug_pagina${pageNumber}.html`);
        fs.writeFileSync(dump, tableHtml || text, 'utf-8');
        logger.warn(`Página ${pageNumber} sin filas. HTML volcado en ${dump} para revisión.`);
      } catch {
        /* no bloquear por el volcado */
      }
    }

    return parsed;
  }

  /**
   * Mapea criterios "humanos" (por etiqueta de columna) a los names reales de
   * los inputs del formulario. Si una clave ya es un name real, se usa tal cual.
   */
  private mapCriteriaToInputs(html: string, criteria: SearchCriteria): Record<string, string> {
    if (Object.keys(criteria).length === 0) return {};
    const $ = cheerio.load(html);
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(criteria)) {
      // ¿La clave ya es el name de un input existente?
      if ($(`[name="${key}"]`).length) {
        result[key] = value;
        continue;
      }
      // Si no, intentar localizar por la etiqueta <label> de texto similar.
      let matchedName: string | null = null;
      $('label').each((_, lbl) => {
        if (matchedName) return;
        if ($(lbl).text().trim().toLowerCase().includes(key.toLowerCase())) {
          const forId = $(lbl).attr('for');
          if (forId) matchedName = $(`#${forId}`).attr('name') || null;
        }
      });
      if (matchedName) result[matchedName] = value;
      else logger.warn(`No se pudo mapear el criterio "${key}" a un input del formulario.`);
    }
    return result;
  }

  /**
   * Recorre TODAS las páginas de resultados y devuelve todos los registros.
   * Respeta `config.maxPages` (0 = sin límite) y aplica delay entre páginas.
   */
  async scrapeAll(criteria: SearchCriteria = config.site.defaultCriteria): Promise<DocumentRecord[]> {
    const all: DocumentRecord[] = [];

    // Página 1 (vía búsqueda).
    let parsed = await this.search(criteria);
    all.push(...parsed.records);
    logger.info(
      `Página 1: ${parsed.records.length} registros` +
        (parsed.totalRecords ? ` (total declarado: ${parsed.totalRecords})` : '')
    );

    // Estimar número de páginas.
    const rows = config.site.rowsPerPage;
    const totalPages = parsed.totalRecords ? Math.ceil(parsed.totalRecords / rows) : Infinity;

    let page = 2;
    while (page <= totalPages) {
      if (config.maxPages && page > config.maxPages) {
        logger.info(`Alcanzado el límite MAX_PAGES=${config.maxPages}. Deteniendo.`);
        break;
      }
      await sleep(config.delays.betweenPages);

      try {
        parsed = await this.goToPage(page);
      } catch (err) {
        logger.error(`Error al obtener la página ${page}: ${errorMessage(err)}. Deteniendo paginación.`);
        break;
      }

      if (parsed.records.length === 0) {
        logger.info(`Página ${page} sin registros. Fin de la paginación.`);
        break;
      }

      all.push(...parsed.records);
      logger.info(`Página ${page}: ${parsed.records.length} registros (acumulado: ${all.length}).`);
      page++;
    }

    return all;
  }

  /** Expone el estado actual (útil para el descargador de PDFs). */
  getState(): JsfFormState {
    return this.state;
  }
}
