/**
 * Punto de entrada del scraper.
 *
 * Uso:
 *   npm run scrape                 -> scrapea y descarga PDFs
 *   npm run retry-failed           -> reintenta solo las descargas fallidas
 *   SITE=pj npm run scrape         -> usa el sitio del Poder Judicial (requiere VPN)
 *   MAX_PAGES=3 npm run scrape     -> limita a 3 páginas (útil para probar)
 */
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { HttpClient } from './http-client';
import { Scraper } from './scraper';
import { PdfDownloader } from './pdf-downloader';
import { DocumentRecord, FailedDownload } from './types';
import { errorMessage } from './utils';

/** Guarda los registros en JSON y en CSV. */
function saveData(records: DocumentRecord[]): void {
  fs.mkdirSync(config.paths.outputDir, { recursive: true });

  // JSON (estructurado y completo).
  fs.writeFileSync(config.paths.dataFile, JSON.stringify(records, null, 2), 'utf-8');
  logger.info(`Datos guardados en ${config.paths.dataFile} (${records.length} registros).`);

  // CSV (a partir de las claves de campos de la primera fila).
  if (records.length > 0) {
    const headers = Object.keys(records[0].fields);
    const escape = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['pagina', 'fila', ...headers, 'pdfFileName'].map(escape).join(','),
      ...records.map((r) =>
        [
          String(r.pageNumber),
          String(r.rowIndex),
          ...headers.map((h) => r.fields[h] ?? ''),
          r.pdfFileName ?? '',
        ]
          .map(escape)
          .join(',')
      ),
    ];
    const csvPath = config.paths.dataFile.replace(/\.json$/, '.csv');
    fs.writeFileSync(csvPath, lines.join('\n'), 'utf-8');
    logger.info(`Datos guardados también en CSV: ${csvPath}`);
  }
}

/** Modo normal: scrapear todo y descargar. */
async function runScrape(): Promise<void> {
  const http = new HttpClient();
  const scraper = new Scraper(http);

  await scraper.init();
  const records = await scraper.scrapeAll();
  saveData(records);

  logger.info(`Iniciando descarga de ${records.length} PDFs...`);
  const downloader = new PdfDownloader(http);
  await downloader.downloadAll(records, scraper.getState());

  logger.info('Proceso completado.');
}

/** Modo --retry-failed: reintentar solo lo que falló antes. */
async function runRetryFailed(): Promise<void> {
  if (!fs.existsSync(config.paths.failedFile)) {
    logger.info('No hay archivo de descargas fallidas. Nada que reintentar.');
    return;
  }
  const failed: FailedDownload[] = JSON.parse(fs.readFileSync(config.paths.failedFile, 'utf-8'));
  const records = failed.map((f) => f.record);
  logger.info(`Reintentando ${records.length} descargas fallidas...`);

  const http = new HttpClient();
  const scraper = new Scraper(http);
  // Necesitamos un ViewState fresco y válido para las descargas vía POST.
  await scraper.init();
  await scraper.search(); // refresca estado/cookies

  const downloader = new PdfDownloader(http);
  await downloader.downloadAll(records, scraper.getState());
  logger.info('Reintento completado.');
}

async function main() {
  // Configurar logging (consola + archivo).
  logger.configure({
    level: (process.env.LOG_LEVEL as any) || 'INFO',
    logFile: config.paths.logFile,
  });

  logger.info(`=== Scraper iniciado | Sitio: ${config.site.name} ===`);

  const retryMode = process.argv.includes('--retry-failed');
  try {
    if (retryMode) await runRetryFailed();
    else await runScrape();
  } catch (err) {
    logger.error(`Error fatal: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
}

main();
