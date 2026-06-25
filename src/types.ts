/**
 * Tipos de datos del scraper.
 */

/** Un documento (fila) extraído de la tabla de resultados. */
export interface DocumentRecord {
  /** Número de página (1-indexado) en el que apareció esta fila. */
  pageNumber: number;
  /** Índice de la fila dentro de la página (0-indexado). */
  rowIndex: number;
  /**
   * Datos de la fila como mapa columna -> valor.
   * Las claves provienen de los encabezados (<th>) de la tabla,
   * por lo que funciona para OEFA y para el Poder Judicial por igual.
   * Ej: { "Número de expediente": "123-2023", "Administrado": "ACME S.A.", ... }
   */
  fields: Record<string, string>;
  /**
   * Identificador del control de PrimeFaces que dispara la descarga del PDF
   * (el `id` del <a>/<button> en la columna "Archivo"). Se usa como
   * `javax.faces.source` en el POST de descarga.
   */
  downloadSourceId?: string;
  /**
   * UUID del documento (param_uuid). PrimeFaces lo incrusta en el onclick del
   * enlace de descarga; el servidor lo usa para saber qué PDF entregar.
   */
  paramUuid?: string;
  /**
   * ViewState válido para la página en la que apareció esta fila. Se guarda
   * porque la descarga (un POST de formulario) necesita un ViewState coherente
   * con el estado de la vista en ese momento.
   */
  viewState?: string;
  /** URL directa del PDF, si la fila expone un enlace href en vez de un POST. */
  downloadHref?: string;
  /** Nombre sugerido para guardar el PDF. */
  pdfFileName?: string;
}

/** Registro de una descarga que falló tras agotar los reintentos. */
export interface FailedDownload {
  record: DocumentRecord;
  reason: string;
  attempts: number;
  timestamp: string;
}

/**
 * Criterios opcionales de búsqueda. Si todos van vacíos, se envía una
 * búsqueda "en blanco" para traer todos los resultados disponibles.
 * Las claves deben coincidir con el `name`/`id` de los <input> del formulario.
 */
export type SearchCriteria = Record<string, string>;
