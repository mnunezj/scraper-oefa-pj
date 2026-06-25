/**
 * Utilidades genéricas reutilizables en todo el scraper.
 */

/** Pausa la ejecución `ms` milisegundos. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calcula el tiempo de espera para un reintento usando backoff exponencial
 * con "jitter" (aleatoriedad) para evitar que varios reintentos coincidan.
 *
 * Fórmula: base * 2^intento, recortado a `maxMs`, +/- 25% de jitter.
 *
 * @param attempt  número de intento (0 = primer reintento)
 * @param baseMs   espera base en ms (p.ej. 1000)
 * @param maxMs    tope máximo de espera en ms (p.ej. 60000)
 */
export function expBackoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxMs);
  // Jitter: +/- 25% del valor para desincronizar reintentos.
  const jitter = capped * 0.25 * (Math.random() * 2 - 1);
  return Math.round(capped + jitter);
}

/**
 * Convierte un texto en un nombre de archivo seguro para el sistema de
 * archivos (sin / \ : * ? " < > | ni espacios problemáticos).
 */
export function sanitizeFileName(name: string, maxLength = 150): string {
  const cleaned = name
    .normalize('NFKD')                 // separa acentos
    .replace(/[\u0300-\u036f]/g, '')   // elimina marcas de acento
    .replace(/[/\\:*?"<>|]/g, '_')     // caracteres prohibidos
    .replace(/\s+/g, '_')              // espacios -> _
    .replace(/_+/g, '_')               // colapsa _ repetidos
    .replace(/^_+|_+$/g, '')           // recorta _ al inicio/fin
    .trim();
  return (cleaned || 'documento').slice(0, maxLength);
}

/** Convierte un valor desconocido en un mensaje de error legible. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
