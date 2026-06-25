/**
 * Configuración central del scraper.
 *
 * Todo lo "ajustable" vive aquí: URLs de los sitios, tiempos de espera,
 * política de reintentos y rutas de salida. Para cambiar de sitio basta
 * con la variable de entorno SITE=oefa | pj
 */
import * as path from 'path';

/** Descripción de un sitio JSF/PrimeFaces a scrapear. */
export interface SiteConfig {
  /** Nombre legible. */
  name: string;
  /** Origen (protocolo + host). Se usa para resolver URLs relativas. */
  origin: string;
  /** URL completa de la página de consulta (.xhtml). */
  pageUrl: string;
  /**
   * Criterios de búsqueda por defecto. Vacío = traer todo.
   * Si el sitio exige al menos un filtro, complétalo aquí.
   * (Ej. del OEFA: { "Sector": "MINERIA" } si quisieras filtrar.)
   */
  defaultCriteria: Record<string, string>;
  /** Filas por página que pide el paginador de PrimeFaces (suele ser 10). */
  rowsPerPage: number;
  /**
   * Parámetros del POST de búsqueda, descubiertos inspeccionando la petición
   * real en DevTools (pestaña Network).
   */
  search: {
    /** Valor de javax.faces.partial.execute (p.ej. "@all" o "@form"). */
    execute: string;
    /**
     * IDs de los componentes a re-renderizar, RELATIVOS al formulario.
     * El scraper les antepone "formId:". Si está vacío, usa "@form".
     * En OEFA, la petición real renderiza el panel de la lista "pgLista".
     */
    renderComponents: string[];
  };
  /**
   * ID del dataTable de PrimeFaces RELATIVO al formulario (se usa para la
   * paginación y para localizar la tabla). En OEFA es "dt" (visto en
   * "...:dt_scrollState"). Vacío = autodetectar desde el HTML.
   */
  dataTableId: string;
}

/** Presets de sitios soportados. */
const SITES: Record<string, SiteConfig> = {
  // Sitio alternativo: NO requiere VPN. Ideal para desarrollo/pruebas.
  oefa: {
    name: 'OEFA - Resoluciones del Tribunal de Fiscalización Ambiental',
    origin: 'https://publico.oefa.gob.pe',
    pageUrl: 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml',
    defaultCriteria: {},
    rowsPerPage: 10,
    // Valores confirmados con DevTools sobre la petición real de "Buscar".
    search: { execute: '@all', renderComponents: ['pgLista', 'txtNroexp'] },
    dataTableId: 'dt',
  },
  // Sitio principal del desafío: REQUIERE VPN a Perú.
  pj: {
    name: 'Poder Judicial - Jurisprudencia',
    origin: 'https://jurisprudencia.pj.gob.pe',
    pageUrl: 'https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml',
    defaultCriteria: {},
    rowsPerPage: 10,
    // Por confirmar con DevTools en el sitio del PJ (vacío = comportamiento genérico).
    search: { execute: '@all', renderComponents: [] },
    dataTableId: '',
  },
};

const selected = (process.env.SITE || 'oefa').toLowerCase();
if (!SITES[selected]) {
  throw new Error(`SITE desconocido: "${selected}". Opciones: ${Object.keys(SITES).join(', ')}`);
}

export const site: SiteConfig = SITES[selected];

/** Carpeta raíz de salidas. */
const OUTPUT_DIR = path.resolve(process.cwd(), 'output', selected);

export const config = {
  site,

  /** Rutas de salida. */
  paths: {
    outputDir: OUTPUT_DIR,
    pdfDir: path.join(OUTPUT_DIR, 'pdfs'),
    dataFile: path.join(OUTPUT_DIR, 'documentos.json'),
    failedFile: path.join(OUTPUT_DIR, 'descargas_fallidas.json'),
    logFile: path.join(OUTPUT_DIR, 'scraper.log'),
  },

  /** Tiempos de cortesía entre peticiones (para no sobrecargar el servidor). */
  delays: {
    /** Espera entre páginas de resultados (ms). */
    betweenPages: 1500,
    /** Espera entre descargas de PDF (ms). */
    betweenDownloads: 1000,
  },

  /** Política de reintentos ante 429 / errores transitorios. */
  retry: {
    maxRetries: 5,        // intentos extra tras el primer fallo
    baseDelayMs: 2000,    // espera base del backoff exponencial
    maxDelayMs: 60000,    // tope de espera por reintento
    /** Códigos HTTP que se consideran reintentables. */
    retryableStatus: [429, 502, 503, 504] as number[],
  },

  /** Límite de páginas a recorrer (0 = sin límite, recorre todas). */
  maxPages: Number(process.env.MAX_PAGES || 0),

  /** Cabeceras que imitan a un navegador real (User-Agent, etc.). */
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
  },
};
