# Scraper de Jurisprudencia / Resoluciones (JSF + PrimeFaces) — TypeScript

Scraper en **TypeScript** que navega un sitio **JSF/PrimeFaces**, extrae todos
los documentos de la tabla de resultados (recorriendo toda la paginación) y
descarga los PDFs asociados, con **manejo de errores 429 (Too Many Requests)**
mediante reintentos con backoff exponencial.

> **Sin automatización de navegador.** No usa Puppeteer/Playwright/Selenium.
> Todo se resuelve con peticiones HTTP (`axios`) y parsing de HTML/XML (`cheerio`),
> replicando a mano el protocolo de JSF (ViewState + AJAX parcial de PrimeFaces).

Sitios soportados:

| Sitio | URL | VPN |
| ----- | --- | --- |
| OEFA (Tribunal de Fiscalización Ambiental) | `https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml` | No |
| Poder Judicial (Jurisprudencia) | `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml` | Sí (Perú) |

---

## ¿Por qué este sitio no es un scraping "normal"?

Ambos sitios usan **JavaServer Faces (JSF) + PrimeFaces**. Eso implica:

1. **Estado en el servidor (`ViewState`).** Cada página entrega un token oculto
   `javax.faces.ViewState`. Hay que reenviarlo en cada POST y **actualizarlo** con
   el que devuelve cada respuesta. Si reusas uno viejo, el servidor responde error.
2. **Navegación por POST, no por GET.** "Buscar" y "página N" son peticiones POST
   con AJAX parcial; la URL nunca cambia. No existe `?page=2`.
3. **Respuestas en XML.** PrimeFaces responde un `<partial-response>` con el HTML
   de la tabla dentro de un `<![CDATA[ ... ]]>` y el nuevo ViewState.
4. **Cookie de sesión.** Hay que conservar `JSESSIONID` entre peticiones.

Este scraper implementa ese protocolo en `src/jsf.ts` y `src/scraper.ts`.

---

## Requisitos

- Node.js 18+ (probado con Node 22)
- npm

## Instalación

```bash
git clone <URL-DE-TU-REPO>
cd scraper-challenge
npm install
```

## Uso

```bash
# Scrapea el sitio OEFA (por defecto, sin VPN) y descarga PDFs
npm run scrape

# Usar el sitio del Poder Judicial (requiere VPN a Perú)
SITE=pj npm run scrape

# Limitar a las primeras 3 páginas (recomendado para una primera prueba)
MAX_PAGES=3 npm run scrape

# Reintentar SOLO las descargas que fallaron antes
npm run retry-failed

# Más detalle en logs
LOG_LEVEL=DEBUG npm run scrape

# Ejecutar el test de la lógica de parsing (sin red)
npm test
```

### Variables de entorno

| Variable | Valores | Por defecto | Descripción |
| -------- | ------- | ----------- | ----------- |
| `SITE` | `oefa` \| `pj` | `oefa` | Sitio a scrapear |
| `MAX_PAGES` | número | `0` (todas) | Límite de páginas |
| `LOG_LEVEL` | `DEBUG`/`INFO`/`WARN`/`ERROR` | `INFO` | Verbosidad |

---

## Estructura del proyecto

```
src/
├── config.ts         Configuración: sitios, delays, reintentos, rutas
├── types.ts          Tipos (DocumentRecord, FailedDownload, ...)
├── utils.ts          sleep, backoff exponencial con jitter, nombres seguros
├── logger.ts         Logging con niveles y timestamps (consola + archivo)
├── http-client.ts    axios + cookie jar + reintentos 429 (backoff)
├── jsf.ts            "Cerebro" JSF/PrimeFaces: ViewState, body AJAX, partial-response
├── parser.ts         Parsing de la DataTable: encabezados, filas, descarga
├── scraper.ts        Orquestación: init -> buscar -> paginar -> recolectar
├── pdf-downloader.ts Descarga de PDFs (href o POST) + registro de fallos
└── index.ts          Punto de entrada (scrape / retry-failed, guardado JSON/CSV)
tests/
└── parsing.test.ts   Prueba la lógica JSF/parsing con HTML simulado
```

## Salidas

Todo se guarda en `output/<sitio>/`:

```
output/oefa/
├── documentos.json          Todos los registros extraídos
├── documentos.csv           Lo mismo en CSV
├── pdfs/                     PDFs descargados (nombres descriptivos)
├── descargas_fallidas.json  Documentos cuya descarga falló (para reintentar)
└── scraper.log              Log de la ejecución
```

---

## Manejo de errores 429 (requisito clave)

Implementado en `src/http-client.ts` (`requestWithRetry`):

- **Detección:** se consideran reintentables los status `429, 502, 503, 504`.
- **Backoff exponencial con jitter:** espera `base * 2^intento` (recortada a un
  máximo), más/menos 25% de aleatoriedad para desincronizar reintentos.
- **`Retry-After`:** si el servidor envía esa cabecera, se respeta su valor.
- **Continuar tras fallo definitivo:** si se agotan los reintentos para un PDF,
  el documento se registra en `descargas_fallidas.json` y el scraper **sigue con
  el siguiente** (no se detiene).
- **Reintento posterior:** `npm run retry-failed` reprocesa esa lista.

También hay **delays de cortesía** entre páginas y entre descargas (`config.delays`)
para no sobrecargar el servidor.

---

## Puntos a confirmar en el sitio real (importante)

El scraper **descubre dinámicamente** el formulario, el ViewState, el id de la
tabla y el control de descarga, por lo que debería funcionar sin tocar nada.
Aun así, los sitios JSF varían en detalles. Si algo no extrae datos, confirma
estos puntos abriendo el sitio real con **DevTools → pestaña Network** (filtro
`Fetch/XHR`) y observando la petición que dispara cada acción:

1. **Render/execute de la búsqueda.** Al pulsar "Buscar", mira en el body del
   POST los valores de `javax.faces.partial.render` y `javax.faces.source`.
   Si difieren, ajústalos en `src/scraper.ts → search()`.

2. **Descarga del PDF.** Pulsa el enlace de descarga de una fila y observa:
   - Si es un **GET a una URL** (p.ej. `.../descargar?id=123`): el parser ya lo
     captura como `downloadHref` y funciona solo.
   - Si es un **POST de PrimeFaces** (`fileDownload`): se usa `downloadSourceId`.
     Confirma en `src/pdf-downloader.ts → downloadViaPost()` que los parámetros
     coinciden (algunos sitios añaden `<id>_input` o similares).

3. **Filas por página.** Si el paginador no usa 10 filas, ajusta `rowsPerPage`
   en `src/config.ts`.

Con esos 1–3 ajustes (normalmente ninguno), el scraper queda 100% operativo.

---

## Notas de diseño

- **Código modular:** cada responsabilidad en su archivo; fácil de mantener.
- **Robustez:** reintentos, validación de cabecera `%PDF`, reanudación idempotente
  (no vuelve a descargar PDFs ya presentes), y manejo de errores por página/fila
  sin abortar todo el proceso.
- **Genérico entre sitios:** los registros usan los encabezados de la tabla como
  claves, así el mismo código sirve para OEFA y Poder Judicial.

## Licencia

MIT
