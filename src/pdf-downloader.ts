/**
 * Descarga de los PDFs asociados a cada documento.
 *
 * Dos estrategias según cómo exponga el PDF el sitio:
 *   A) Enlace directo (href) -> GET del recurso.
 *   B) Control de PrimeFaces (fileDownload) -> POST completo que devuelve los
 *      bytes con Content-Disposition.
 *
 * Reintentos ante 429 con backoff los aporta HttpClient.requestWithRetry.
 * Las descargas que fallan definitivamente se registran para reintento.
 */
import * as fs from 'fs';
import * as path from 'path';
import { HttpClient, RetryExhaustedError } from './http-client';
import { config } from './config';
import { logger } from './logger';
import { sleep, errorMessage, sanitizeFileName } from './utils';
import { DocumentRecord, FailedDownload } from './types';
import { JsfFormState, buildAjaxBody } from './jsf';

export class PdfDownloader {
  private failed: FailedDownload[] = [];

  constructor(private http: HttpClient) {
    fs.mkdirSync(config.paths.pdfDir, { recursive: true });
  }

  /**
   * Descarga el PDF de un registro.
   * @param record  documento a descargar
   * @param state   estado JSF actual (necesario para la descarga vía POST)
   * @returns true si se guardó, false si falló (y quedó registrado)
   */
  async download(record: DocumentRecord, state: JsfFormState): Promise<boolean> {
    const fileName = record.pdfFileName || `doc_p${record.pageNumber}_r${record.rowIndex}.pdf`;
    const dest = path.join(config.paths.pdfDir, fileName);

    // Evitar volver a descargar si ya existe (reanudación idempotente).
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      logger.debug(`Ya existe, se omite: ${fileName}`);
      return true;
    }

    try {
      const bytes = record.downloadHref
        ? await this.downloadViaHref(record.downloadHref)
        : record.downloadSourceId
        ? await this.downloadViaPost(record, state)
        : null;

      if (!bytes || bytes.length === 0) {
        throw new Error('No se obtuvo contenido (¿falta downloadHref/downloadSourceId?).');
      }

      // Validación básica: los PDFs empiezan por "%PDF".
      const header = bytes.subarray(0, 4).toString('latin1');
      if (!header.startsWith('%PDF')) {
        logger.warn(`El contenido de "${fileName}" no parece un PDF (cabecera "${header}").`);
      }

      fs.writeFileSync(dest, bytes);
      logger.info(`PDF guardado: ${fileName} (${bytes.length} bytes).`);
      return true;
    } catch (err) {
      const attempts = err instanceof RetryExhaustedError ? config.retry.maxRetries + 1 : 1;
      this.recordFailure(record, errorMessage(err), attempts);
      logger.error(`Falló la descarga de "${fileName}": ${errorMessage(err)}`);
      return false;
    }
  }

  /** Estrategia A: GET de un enlace directo. */
  private async downloadViaHref(href: string): Promise<Buffer> {
    const url = new URL(href, config.site.origin).toString();
    const res = await this.http.requestWithRetry(
      { url, method: 'GET', responseType: 'arraybuffer' },
      `GET PDF ${path.basename(url)}`
    );
    if (res.status >= 400) throw new Error(`HTTP ${res.status} al descargar el PDF.`);
    return Buffer.from(res.data as ArrayBuffer);
  }

  /**
   * Estrategia B: descarga vía POST de formulario COMPLETO (no-AJAX), tal como
   * hace el navegador al pulsar el icono de PDF. Incluye:
   *   - el control pulsado (downloadSourceId), enviado como name=name,
   *   - el param_uuid que identifica el documento,
   *   - el ViewState válido para la página de esa fila.
   */
  private async downloadViaPost(record: DocumentRecord, state: JsfFormState): Promise<Buffer> {
    const sourceId = record.downloadSourceId!;

    // Usar el ViewState "estampado" en la fila (coherente con su página).
    const perRecordState: JsfFormState = {
      ...state,
      viewState: record.viewState || state.viewState,
    };

    const extra: Record<string, string> = {};
    if (record.paramUuid) extra['param_uuid'] = record.paramUuid;
    extra[`${state.formId}:dt_scrollState`] = '0,0';

    // ajax:false -> submit de formulario completo (sin parámetros partial/ajax).
    const body = buildAjaxBody(perRecordState, sourceId, { ajax: false, extra });

    const res = await this.http.requestWithRetry(
      {
        url: state.action,
        method: 'POST',
        data: body.toString(),
        responseType: 'arraybuffer',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      `POST PDF ${sourceId}`
    );
    if (res.status >= 400) throw new Error(`HTTP ${res.status} al descargar el PDF.`);
    return Buffer.from(res.data as ArrayBuffer);
  }

  /** Descarga una lista de documentos en serie, con delay entre cada uno. */
  async downloadAll(records: DocumentRecord[], state: JsfFormState): Promise<void> {
    let ok = 0;
    for (let i = 0; i < records.length; i++) {
      const success = await this.download(records[i], state);
      if (success) ok++;
      logger.info(`Progreso descargas: ${i + 1}/${records.length} (ok: ${ok}, fallos: ${this.failed.length}).`);
      if (i < records.length - 1) await sleep(config.delays.betweenDownloads);
    }
    this.persistFailures();
  }

  /** Añade un documento a la lista de fallos. */
  private recordFailure(record: DocumentRecord, reason: string, attempts: number) {
    this.failed.push({ record, reason, attempts, timestamp: new Date().toISOString() });
  }

  /** Guarda en disco los documentos que fallaron, para reintentarlos luego. */
  persistFailures(): void {
    if (this.failed.length === 0) {
      logger.info('No hubo descargas fallidas. 🎉');
      return;
    }
    fs.mkdirSync(path.dirname(config.paths.failedFile), { recursive: true });
    fs.writeFileSync(config.paths.failedFile, JSON.stringify(this.failed, null, 2), 'utf-8');
    logger.warn(`${this.failed.length} descargas fallidas registradas en ${config.paths.failedFile}`);
  }

  /** Devuelve los registros que fallaron (para el modo --retry-failed). */
  getFailures(): FailedDownload[] {
    return this.failed;
  }
}
