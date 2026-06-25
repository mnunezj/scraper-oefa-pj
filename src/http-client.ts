/**
 * Cliente HTTP centralizado.
 *
 * Responsabilidades:
 *  1. Mantener una sesión con cookies (JSESSIONID) entre peticiones — JSF
 *     deja de responder bien si pierdes la cookie de sesión.
 *  2. Reintentar automáticamente ante errores 429 (Too Many Requests) y
 *     otros transitorios, usando backoff exponencial + jitter, respetando
 *     la cabecera `Retry-After` si el servidor la envía.
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { config } from './config';
import { logger } from './logger';
import { sleep, expBackoffDelay, errorMessage } from './utils';

/** Error lanzado cuando se agotan los reintentos. */
export class RetryExhaustedError extends Error {
  constructor(message: string, public readonly lastStatus?: number) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

export class HttpClient {
  private client: AxiosInstance;
  public readonly jar: CookieJar;

  constructor() {
    this.jar = new CookieJar();
    // wrapper() hace que axios use el cookie jar automáticamente.
    this.client = wrapper(
      axios.create({
        jar: this.jar,
        withCredentials: true,
        // No lanzamos excepción por status >= 400: queremos inspeccionar 429.
        validateStatus: () => true,
        // Algunos PDFs son grandes; sin timeout demasiado corto.
        timeout: 60000,
        maxRedirects: 5,
        headers: { ...config.headers },
      })
    );
  }

  /**
   * Ejecuta una petición con reintentos ante 429 / errores transitorios.
   *
   * @param cfg          configuración de axios (url, method, data, etc.)
   * @param label        etiqueta para los logs (ej. "GET página", "PDF #12")
   */
  async requestWithRetry(cfg: AxiosRequestConfig, label = 'request'): Promise<AxiosResponse> {
    const { maxRetries, baseDelayMs, maxDelayMs, retryableStatus } = config.retry;

    let attempt = 0;
    let lastStatus: number | undefined;

    while (true) {
      try {
        const res = await this.client.request(cfg);
        lastStatus = res.status;

        // Éxito o error NO reintentable -> devolver tal cual.
        if (!retryableStatus.includes(res.status)) {
          return res;
        }

        // Status reintentable (típicamente 429).
        if (attempt >= maxRetries) {
          throw new RetryExhaustedError(
            `${label}: se agotaron los reintentos (último status ${res.status})`,
            res.status
          );
        }

        const wait = this.computeWait(res, attempt, baseDelayMs, maxDelayMs);
        logger.warn(
          `${label}: status ${res.status}. Reintento ${attempt + 1}/${maxRetries} en ${wait}ms...`
        );
        await sleep(wait);
        attempt++;
      } catch (err) {
        // Errores de red (ECONNRESET, timeout, etc.): también reintentables.
        if (err instanceof RetryExhaustedError) throw err;
        if (attempt >= maxRetries) {
          throw new RetryExhaustedError(
            `${label}: error de red tras ${maxRetries} reintentos: ${errorMessage(err)}`,
            lastStatus
          );
        }
        const wait = expBackoffDelay(attempt, baseDelayMs, maxDelayMs);
        logger.warn(
          `${label}: error de red (${errorMessage(err)}). Reintento ${attempt + 1}/${maxRetries} en ${wait}ms...`
        );
        await sleep(wait);
        attempt++;
      }
    }
  }

  /**
   * Decide cuánto esperar antes del siguiente reintento.
   * Prioriza la cabecera `Retry-After` del servidor; si no, usa backoff.
   */
  private computeWait(
    res: AxiosResponse,
    attempt: number,
    baseMs: number,
    maxMs: number
  ): number {
    const retryAfter = res.headers['retry-after'];
    if (retryAfter) {
      // Retry-After puede ser segundos o una fecha HTTP.
      const asNumber = Number(retryAfter);
      if (!Number.isNaN(asNumber)) return Math.min(asNumber * 1000, maxMs);
      const asDate = new Date(retryAfter).getTime();
      if (!Number.isNaN(asDate)) return Math.min(Math.max(asDate - Date.now(), 0), maxMs);
    }
    return expBackoffDelay(attempt, baseMs, maxMs);
  }

  /** GET simple con reintentos. Devuelve el cuerpo como string (HTML). */
  async getHtml(url: string, label = 'GET'): Promise<string> {
    const res = await this.requestWithRetry({ url, method: 'GET' }, label);
    return typeof res.data === 'string' ? res.data : String(res.data);
  }

  /**
   * POST de formulario (application/x-www-form-urlencoded) con reintentos.
   * Devuelve la respuesta cruda para que el llamador decida cómo parsearla.
   */
  async postForm(
    url: string,
    body: URLSearchParams,
    extraHeaders: Record<string, string> = {},
    label = 'POST'
  ): Promise<AxiosResponse> {
    return this.requestWithRetry(
      {
        url,
        method: 'POST',
        data: body.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          ...extraHeaders,
        },
      },
      label
    );
  }
}
