/**
 * Utilidades para hablar el "protocolo" de JSF + PrimeFaces por HTTP.
 *
 * Conceptos clave:
 *  - javax.faces.ViewState: token de estado del servidor. Hay que reenviarlo
 *    en CADA POST y actualizarlo con el que devuelve cada respuesta.
 *  - PrimeFaces AJAX: al pulsar un botón/enlace, el navegador manda un POST
 *    con parámetros especiales (javax.faces.partial.ajax=true, source, etc.)
 *    y el servidor responde un XML <partial-response> con el HTML actualizado.
 */
import * as cheerio from 'cheerio';

/** Estado del formulario JSF necesario para reconstruir un POST. */
export interface JsfFormState {
  /** id del <form> (atributo id, que en JSF coincide con el name del marcador). */
  formId: string;
  /** action del formulario (URL a la que se hace POST). */
  action: string;
  /** Valor actual de javax.faces.ViewState. */
  viewState: string;
  /** Todos los campos del formulario (name -> value), inputs y selects. */
  inputs: Record<string, string>;
}

/** Nombre del campo oculto del ViewState en JSF. */
export const VIEWSTATE_FIELD = 'javax.faces.ViewState';

/**
 * Extrae el estado del formulario principal a partir del HTML de la página.
 * Si hay varios <form>, toma el que contenga el ViewState (el de JSF).
 */
export function extractFormState(html: string, baseUrl: string): JsfFormState {
  const $ = cheerio.load(html);

  // Buscar el form que contiene el ViewState.
  let $form = $('form').filter((_, el) =>
    $(el).find(`input[name="${VIEWSTATE_FIELD}"]`).length > 0
  ).first();
  if ($form.length === 0) $form = $('form').first();
  if ($form.length === 0) throw new Error('No se encontró ningún <form> en la página.');

  const formId = $form.attr('id') || $form.attr('name') || '';
  const actionAttr = $form.attr('action') || baseUrl;
  const action = new URL(actionAttr, baseUrl).toString();

  const inputs: Record<string, string> = {};
  // Inputs (text, hidden, etc.).
  $form.find('input[name]').each((_, el) => {
    const name = $(el).attr('name')!;
    const type = ($(el).attr('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      if ($(el).attr('checked') !== undefined) inputs[name] = $(el).attr('value') || 'on';
    } else {
      inputs[name] = $(el).attr('value') || '';
    }
  });
  // Selects (toma la opción marcada como selected, o la primera).
  $form.find('select[name]').each((_, el) => {
    const name = $(el).attr('name')!;
    const $selected = $(el).find('option[selected]').first();
    const $opt = $selected.length ? $selected : $(el).find('option').first();
    inputs[name] = $opt.attr('value') ?? $opt.text() ?? '';
  });

  const viewState = inputs[VIEWSTATE_FIELD] || $(`input[name="${VIEWSTATE_FIELD}"]`).attr('value') || '';
  if (!viewState) throw new Error('No se encontró javax.faces.ViewState en la página.');

  return { formId, action, viewState, inputs };
}

/**
 * Construye el cuerpo de un POST AJAX de PrimeFaces para "activar" un control
 * (p.ej. el botón Buscar o un enlace de descarga).
 *
 * @param state        estado actual del formulario
 * @param sourceId     id del control que dispara la acción (javax.faces.source)
 * @param opts.render  qué re-renderizar (javax.faces.partial.render)
 * @param opts.execute qué procesar en el servidor (javax.faces.partial.execute)
 * @param opts.extra   parámetros adicionales (criterios de búsqueda, paginación)
 * @param opts.ajax    si es petición AJAX parcial (true) o POST completo (false)
 */
export function buildAjaxBody(
  state: JsfFormState,
  sourceId: string,
  opts: {
    render?: string;
    execute?: string;
    extra?: Record<string, string>;
    ajax?: boolean;
  } = {}
): URLSearchParams {
  const { render = '@form', execute = '@form', extra = {}, ajax = true } = opts;
  const params = new URLSearchParams();

  // 1) Reenviar todos los campos actuales del formulario (incluye ViewState).
  for (const [name, value] of Object.entries(state.inputs)) {
    params.set(name, value);
  }

  // 2) Parámetros específicos de PrimeFaces para la acción AJAX.
  if (ajax) {
    params.set('javax.faces.partial.ajax', 'true');
    params.set('javax.faces.partial.execute', execute);
    params.set('javax.faces.partial.render', render);
    // En peticiones AJAX el control activado se indica con javax.faces.source.
    params.set('javax.faces.source', sourceId);
  }
  // El control siempre se envía a sí mismo como name=value (así JSF dispara su acción).
  params.set(sourceId, sourceId);

  // 3) Marcador del formulario (JSF espera form_id=form_id).
  if (state.formId) params.set(state.formId, state.formId);

  // 4) Parámetros extra (criterios, paginación...). Sobrescriben lo anterior.
  for (const [name, value] of Object.entries(extra)) {
    params.set(name, value);
  }

  // 5) Asegurar que el ViewState va presente y actualizado.
  params.set(VIEWSTATE_FIELD, state.viewState);

  return params;
}

/** Resultado de parsear un <partial-response> de PrimeFaces. */
export interface PartialResponse {
  /** Mapa id -> HTML de cada bloque <update>. */
  updates: Record<string, string>;
  /** Nuevo ViewState (si vino en la respuesta). */
  viewState?: string;
  /** URL de redirección, si el servidor pidió una. */
  redirect?: string;
}

/**
 * Parsea la respuesta XML de PrimeFaces:
 *   <partial-response>
 *     <changes>
 *       <update id="form:tabla"><![CDATA[ ...HTML... ]]></update>
 *       <update id="javax.faces.ViewState"><![CDATA[ ...token... ]]></update>
 *     </changes>
 *   </partial-response>
 */
export function parsePartialResponse(xml: string): PartialResponse {
  const $ = cheerio.load(xml, { xmlMode: true });
  const updates: Record<string, string> = {};
  let viewState: string | undefined;

  $('update').each((_, el) => {
    const id = $(el).attr('id') || '';
    const content = $(el).text(); // cheerio ya extrae el contenido del CDATA
    if (id.includes('ViewState')) {
      viewState = content;
    } else {
      updates[id] = content;
    }
  });

  const redirect = $('redirect').attr('url') || undefined;
  return { updates, viewState, redirect };
}

/**
 * Aplica una PartialResponse al estado del formulario: actualiza el ViewState
 * para la siguiente petición. (Los inputs no cambian salvo que re-parseemos
 * el HTML actualizado, lo cual hace el scraper cuando hace falta.)
 */
export function applyViewState(state: JsfFormState, partial: PartialResponse): void {
  if (partial.viewState) state.viewState = partial.viewState;
}
