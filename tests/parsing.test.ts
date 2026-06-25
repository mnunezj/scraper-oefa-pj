import { extractFormState, parsePartialResponse, buildAjaxBody } from '../src/jsf';
import { parseTable } from '../src/parser';

const initialHtml = `
<html><body>
<form id="formBusqueda" action="/repdig/consulta/consultaTfa.xhtml" method="post">
  <input type="hidden" name="formBusqueda" value="formBusqueda">
  <input type="text" id="formBusqueda:expediente" name="formBusqueda:expediente" value="">
  <select id="formBusqueda:sector" name="formBusqueda:sector">
    <option value="" selected>--Todos--</option>
    <option value="MINERIA">MINERIA</option>
  </select>
  <button id="formBusqueda:btnBuscar" type="submit">Buscar</button>
  <input type="hidden" name="javax.faces.ViewState" value="VIEWSTATE-INICIAL-123">
</form>
</body></html>`;

const state = extractFormState(initialHtml, 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml');
console.log('formId:', state.formId);
console.log('action:', state.action);
console.log('viewState:', state.viewState);
console.log('inputs:', JSON.stringify(state.inputs));

const body = buildAjaxBody(state, 'formBusqueda:btnBuscar', { render: '@form', execute: '@form' });
console.log('\nBODY busqueda:');
console.log(body.toString());

const partialXml = `<?xml version="1.0" encoding="UTF-8"?>
<partial-response><changes>
<update id="formBusqueda:tablaResultados"><![CDATA[
<div id="formBusqueda:tablaResultados" class="ui-datatable">
 <table><thead><tr>
   <th>Nro.</th><th>Numero de expediente</th><th>Administrado</th><th>Sector</th><th>Nro. Resolucion de Apelacion</th><th>Archivo</th>
 </tr></thead>
 <tbody>
   <tr><td>1</td><td>123-2023</td><td>ACME S.A.</td><td>MINERIA</td><td>RES-001-2023</td><td><a id="formBusqueda:tablaResultados:0:descargar" href="#">PDF</a></td></tr>
   <tr><td>2</td><td>124-2023</td><td>BETA EIRL</td><td>HIDROCARBUROS</td><td>RES-002-2023</td><td><a href="/repdig/files/res002.pdf">PDF</a></td></tr>
 </tbody></table>
 <span>Pagina 1 de 13 (125 registros)</span>
</div>
]]></update>
<update id="javax.faces.ViewState"><![CDATA[VIEWSTATE-NUEVO-456]]></update>
</changes></partial-response>`;

const partial = parsePartialResponse(partialXml);
console.log('\nNuevo ViewState:', partial.viewState);
const htmls: string[] = Object.values(partial.updates);
const tableHtml = htmls.sort((a, b) => b.length - a.length)[0];
const parsed = parseTable(tableHtml, 1);
console.log('tableId:', parsed.tableId);
console.log('headers:', parsed.headers);
console.log('totalRecords:', parsed.totalRecords);
console.log('records:');
parsed.records.forEach((r) => console.log('  ', JSON.stringify({
  exp: r.fields['Numero de expediente'],
  adm: r.fields['Administrado'],
  src: r.downloadSourceId,
  href: r.downloadHref,
  file: r.pdfFileName,
})));
