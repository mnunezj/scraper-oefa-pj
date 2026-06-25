/**
 * Parsing de la tabla de resultados (PrimeFaces DataTable).
 *
 * Convierte el HTML de la tabla en registros tipados y descubre:
 *  - el id de la tabla (necesario para los POST de paginación),
 *  - los encabezados de columna (se usan como claves de cada registro),
 *  - el control que dispara la descarga del PDF en cada fila,
 *  - el total de registros / páginas (cuando el sitio lo muestra).
 */
import * as cheerio from 'cheerio';
import { DocumentRecord } from './types';
import { sanitizeFileName } from './utils';

export interface ParsedTable {
  /** id del contenedor de la DataTable (div.ui-datatable o la <table>). */
  tableId: string | null;
  /** Encabezados de columna en orden. */
  headers: string[];
  /** Filas extraídas. */
  records: DocumentRecord[];
  /** Total de registros si se pudo determinar. */
  totalRecords: number | null;
}

/**
 * Localiza la DataTable dentro de un fragmento/página HTML y extrae sus datos.
 * @param html        HTML que contiene la tabla (página completa o update AJAX)
 * @param pageNumber  número de página actual (para etiquetar los registros)
 */
export function parseTable(
  html: string,
  pageNumber: number,
  knownHeaders?: string[]
): ParsedTable {
  // Las respuestas de paginación de PrimeFaces traen <tr> sueltos (sin <table>).
  // El parser de HTML descarta los <tr> fuera de una tabla, así que los
  // envolvemos en <table> para que no se pierdan.
  let normalized = html;
  if (/<tr[\s>]/i.test(html) && !/<table[\s>]/i.test(html)) {
    normalized = `<table>${html}</table>`;
  }
  const $ = cheerio.load(normalized);

  // 1) Encontrar el contenedor de la DataTable de PrimeFaces.
  let $container = $('.ui-datatable').first();
  if ($container.length === 0) {
    // Fallback: cualquier <table> que tenga filas.
    $container = $('table').filter((_, el) => $(el).find('tr').length > 0).first();
  }
  // Último recurso: usar todo el fragmento.
  if ($container.length === 0) $container = $.root() as any;
  const tableId = $container.attr ? $container.attr('id') || null : null;

  // 2) Encabezados: del <thead> si existe; si no, reutilizar los ya conocidos.
  //    (Las respuestas de paginación a veces no incluyen el thead.)
  let headers: string[] = [];
  $container.find('thead th').each((_, el) => {
    headers.push($(el).text().trim());
  });
  if (headers.length === 0 && knownHeaders) headers = [...knownHeaders];

  // 3) Filas del cuerpo. Si no hay <tbody>, usar todos los <tr>
  //    (las filas de cabecera se descartan más abajo porque no tienen <td>).
  const records: DocumentRecord[] = [];
  let $rows = $container.find('tbody tr');
  if ($rows.length === 0) $rows = $container.find('tr');
  $rows.each((rowIndex, tr) => {
    const $tr = $(tr);

    // Saltar filas "vacías" que PrimeFaces usa cuando no hay datos.
    if ($tr.hasClass('ui-datatable-empty-message')) return;

    const cells = $tr.find('td').toArray();
    if (cells.length === 0) return;

    const fields: Record<string, string> = {};
    cells.forEach((td, colIndex) => {
      const key = headers[colIndex] || `col_${colIndex}`;
      fields[key] = $(td).text().trim();
    });

    // Localizar el enlace de descarga en la fila (el <a> que envuelve el icono PDF).
    const dl = extractDownloadInfo($, $tr);

    records.push({
      pageNumber,
      rowIndex,
      fields,
      downloadSourceId: dl.sourceId,
      paramUuid: dl.uuid,
      downloadHref: dl.href,
      pdfFileName: buildPdfName(fields, pageNumber, rowIndex),
    });
  });

  const totalRecords = extractTotalRecords($.root().text());
  return { tableId, headers, records, totalRecords };
}

/**
 * Extrae la info de descarga de una fila. Soporta dos formas:
 *  - href directo a un PDF.
 *  - <a> de PrimeFaces con onclick que contiene el id del control y el UUID.
 */
function extractDownloadInfo(
  $: cheerio.CheerioAPI,
  $row: cheerio.Cheerio<any>
): { sourceId?: string; uuid?: string; href?: string } {
  // Preferir el <a> que envuelve una imagen (el icono de PDF); si no, cualquiera.
  let $a = $row.find('a').filter((_, el) => $(el).find('img').length > 0).first();
  if ($a.length === 0) $a = $row.find('a').first();
  if ($a.length === 0) return {};

  const href = $a.attr('href');
  if (href && href !== '#' && !href.toLowerCase().startsWith('javascript')) {
    return { href };
  }

  const onclick = $a.attr('onclick') || '';
  // El id del control suele ser el del propio <a>; si no, se busca en el onclick
  // un client-id de JSF con forma "...:dt:<fila>:...".
  let sourceId = $a.attr('id') || undefined;
  const srcMatch = onclick.match(/'([^']*:dt:\d+:[^']*)'/);
  if (srcMatch) sourceId = srcMatch[1];

  // El param_uuid es el único UUID presente en el onclick.
  const uuidMatch = onclick.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/
  );
  const uuid = uuidMatch ? uuidMatch[0] : undefined;

  return { sourceId, uuid };
}

/** Construye un nombre de archivo descriptivo a partir de los campos de la fila. */
function buildPdfName(
  fields: Record<string, string>,
  pageNumber: number,
  rowIndex: number
): string {
  // Preferimos columnas identificadoras típicas (resolución / expediente).
  const candidateKeys = Object.keys(fields).filter((k) =>
    /resoluci|expediente|n[ro\.]*|número/i.test(k)
  );
  const parts = candidateKeys
    .map((k) => fields[k])
    .filter((v) => v && v.length > 0);

  const base = parts.length
    ? parts.join('_')
    : `pagina${pageNumber}_fila${rowIndex}`;
  return `${sanitizeFileName(base)}.pdf`;
}

/** Intenta extraer el número total de registros del texto "(N registros)". */
function extractTotalRecords(text: string): number | null {
  const m = text.match(/\(([\d.,]+)\s*registros?\)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/[.,]/g, ''));
  return Number.isNaN(n) ? null : n;
}
