// Pruebas de restep-check: el servidor de referencia tiene que pasar entero, y cada versión con un
// fallo metido a propósito (una mutación) tiene que hacer fallar la comprobación que lo cubre.
//   node tools/restep-check/test.mjs            (desde projects/restep)
//   node tools/restep-check/test.mjs cursor     (solo las mutaciones cuyo nombre contiene «cursor»)
// La misma prueba va en github.com/restep-spec/restep-check (test/test.mjs, con el servidor al lado):
// allí busca el servidor y el comprobador junto a ella y se salta lo generado de la web.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const inSite = existsSync(join(here, 'tabla.mjs'));
const SERVER = readFileSync(inSite ? join(here, '../../public/ref/restep-server.mjs') : join(here, 'restep-server.mjs'), 'utf8');
const CHECKER = inSite ? join(here, '../../public/tools/restep-check.mjs') : join(here, '../restep-check.mjs');
const OAUTH = 'oauth';
const TOKEN = 'restep-check-test';

// [nombre, comprobación que debe fallar, [[texto del servidor, reemplazo], ...], modo, resultado, argumentos]
// Con resultado ('fail' o 'warn'), la comprobación tiene que dar justo ese. Los argumentos se añaden al
// comprobador (por ejemplo, --fixture).
// Con el modo OAUTH, el servidor arranca con RESTEP_TOKEN (extensión oauth) y el comprobador manda el token.
// Variante con un campo calculado (5.1): rating de books pasa a ser readOnly en el esquema item, y
// el servidor ignora su valor actual y da read_only a otro. RATING_SCHEMA solo lo declara.
const RATING_SCHEMA = ['    const s = inherited(f, json(f, kind));\n',
  "    const s = { ...inherited(f, json(f, kind)), ...(kind === 'item' && c === db.books && f === 'rating' && { readOnly: true }) };\n"];
const RATING_RULE = ['  errors.push(...relationErrors(coll, patch, id, current), ...inheritErrors(coll, patch, current));',
  "  if (coll === db.books && 'rating' in patch) { if (same(patch.rating, current.rating)) delete patch.rating; else errors.push({ pointer: '/rating', code: 'read_only', detail: t('rating is computed.', 'rating se calcula.') }); }\n  errors.push(...relationErrors(coll, patch, id, current), ...inheritErrors(coll, patch, current));"];

// Y lo pone el servidor: un ítem nuevo empieza con rating 0.
const RATING_SET = ["const row = withMaps(coll, { ...body, id: 'id' in body ? body.id : newId(coll) });",
  "const row = withMaps(coll, { ...body, ...(coll === db.books && { rating: 0 }), id: 'id' in body ? body.id : newId(coll) });"];

// _etag en los ítems de una colección (7.2). ETAG_LIST es la línea que lo pone.
const ETAG_LIST = 'items: page.map((r) => ({ ...pick(expand(r, coll, include), fields), _etag: etag(r) })), next,';
// Una colección que responde :changes (9): state en cada página y un :changes mínimo que responde 200.
// Desde el borrador 6 lo que obliga es la declaración sync de la colección (7.2, 10).
const CHANGES = [["...(c.deprecations && { deprecations: c.deprecations }), // 5.5", "...(c.deprecations && { deprecations: c.deprecations }), sync: {},"],
  ["...(count === 'true' && { total: items.length }),", "state: hash(JSON.stringify([...coll.rows.values()])),\n    ...(count === 'true' && { total: items.length }),"],
  ['  if (url.pathname === shop.path) return handleShop(req, res, params);\n',
    "  if (read && segments.length === 1 && name.endsWith(':changes') && Object.hasOwn(db, name.slice(0, -8))) {\n" +
    "    const c = db[name.slice(0, -8)];\n" +
    "    return send(res, 200, { since: params.get('since'), state: hash(JSON.stringify([...c.rows.values()])), has_more: false, created: [], updated: [], destroyed: [] }, { 'Cache-Control': 'no-store' }, method === 'HEAD');\n" +
    "  }\n  if (url.pathname === shop.path) return handleShop(req, res, params);\n"]];
// CORS (5.8): repite el Origin, expone las cabeceras de Restep, añade Origin a Vary en toda respuesta y
// responde los preflight sin reglas de Restep.
const CORS_FN = [
  'const cors = (req, res) => {',
  '  const origin = req.headers.origin;',
  '  const writeHead = res.writeHead.bind(res);',
  '  res.writeHead = (status, headers = {}) => writeHead(status, { ...headers, Vary: headers.Vary ? `${headers.Vary}, Origin` : \'Origin\',',
  "    ...(origin && { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'ETag, Location, Link, Allow, Accept-Patch, Retry-After, Deprecation, Sunset, Idempotent-Replayed, Preference-Applied, Accept-Query' }) });",
  "  if (req.method !== 'OPTIONS' || !origin) return false;",
  "  res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, If-Match, If-None-Match, Idempotency-Key, Prefer, Authorization, DPoP', 'Access-Control-Max-Age': '600' });",
  '  res.end();',
  '  return true;',
  '};',
  ''].join('\n');
const CORS = [['createServer((req, res) => handle(req, res).catch(', 'createServer((req, res) => cors(req, res) || handle(req, res).catch('],
  ['refresh();\nconst port = Number', `${CORS_FN}refresh();\nconst port = Number`]];
const CORS_CREDENTIALS = ["'Access-Control-Allow-Origin': origin,", "'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true',"];
// 4.3: authors declara una lista de métodos sin GET, en la colección o en sus ítems. La referencia la cumple:
// GET y HEAD dan 405 con el Allow de lo declarado.
const AUTHORS = "description: t('The authors of the books.', 'Los autores de los libros.'),\n    methods: ['GET', 'POST'], item_methods: ['GET', 'PATCH', 'DELETE'],";
const AUTHORS_POST_ONLY = [AUTHORS, AUTHORS.replace("methods: ['GET', 'POST'],", "methods: ['POST'],")];
const AUTHORS_ITEMS_NO_GET = [AUTHORS, AUTHORS.replace("item_methods: ['GET', 'PATCH', 'DELETE'],", "item_methods: ['PATCH', 'DELETE'],")];
// La repetición de un POST con la misma Idempotency-Key, como si la primera siguiera en curso (7.1).
const IN_PROGRESS = "      return send(res, ...live.response.slice(0, 2), { ...live.response[2], 'Idempotent-Replayed': 'true' });";

const MUTATIONS = [
  ['next ausente al final', 'core.collection.shape',
    [[ETAG_LIST, 'items: page.map((r) => ({ ...pick(expand(r, coll, include), fields), _etag: etag(r) })), ...(next && { next }),']]],
  ['parámetro reservado ignorado', 'core.reserved.item',
    [['if (!allowed.includes(base)) throw unsupported(key);', 'if (!allowed.includes(base)) continue;']]],
  ['400 antes que 404', 'core.error-order',
    [["  if (id !== undefined && !coll.rows.has(id)) throw missing(url);\n", '']]],
  ['400 antes que 405', 'core.error-order',
    [["  if (!methods.includes(method))\n    throw new Problem(405, 'method_not_allowed', t(`Supports ${methods.join(', ')}.`, `Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') });\n\n  // 5.3", '  // 5.3'],
      ["    if (!allowed.includes(base)) throw unsupported(key);", "    if (!allowed.includes(base)) throw unsupported(key);\n    if (!methods.includes(method)) continue;"]]],
  ['$ sin reservar', 'core.reserved.dollar',
    [["const isReserved = (base) => RESERVED.includes(base) || base.startsWith('$');", 'const isReserved = (base) => RESERVED.includes(base);']]],
  ['404 con otro código', 'core.not-found',
    [['code: p.code, detail: text(p.detail, lang),', "code: p.status === 404 ? 'missing' : p.code, detail: text(p.detail, lang),"]]],
  ['405 sin Allow', 'passive.error.405',
    [["`Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') }", "`Admite ${methods.join(', ')}.`), {}, {}"]]],
  ['errores como application/json', 'passive.error.media-type',
    [["status >= 400 ? 'application/problem+json' : 'application/json'", "'application/json'"]]],
  ['status distinto en el cuerpo', 'passive.error.members',
    [["title: text(TITLES[p.status] ?? 'Error', lang), status: p.status,", "title: text(TITLES[p.status] ?? 'Error', lang), status: 400,"]]],
  ['errores sin Cache-Control', 'cache.cache-control',
    [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language',", "{ Vary: 'Accept-Language',"]]],
  ['sin cabecera de perfil', 'passive.profile-link',
    [['res.writeHead(status, { Link: link,', 'res.writeHead(status, {']]],
  ['perfiles listados en la cabecera', 'passive.profile-link',
    [['const link = `<${PROFILE}>; rel="profile"`;', 'const link = `<${PROFILE}>; rel="profile", <${PROFILE}core>; rel="profile"`;']]],
  ['sin service-doc', 'discovery.service-doc',
    [["Link: `${link}, ${DOCS}` };", '};']]],
  // El analizador de Link respeta las comillas: un rel dentro de otro parámetro no cuenta.
  ['service-doc solo dentro de un title', 'discovery.service-doc',
    [['const DOCS = `<${SPEC}>; rel="service-doc"; hreflang="en"; title="Restep 1, the specification", <https://restep.wubytes.com/es/1/>; rel="service-doc"; hreflang="es"`;',
      'const DOCS = `<${SPEC}>; title="docs, rel=service-doc"; rel="help"`;']]],
  ['razón con código imposible', 'discovery.reasons',
    [['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { sold_out: { code: 'http_409' } }, collections, singletons };"]]],
  ['razón sin declarar', 'passive.error.reason',
    [["code: p.code, detail: text(p.detail, lang), ...extra,", "code: p.code, reason: 'sold_out', detail: text(p.detail, lang), ...extra,"]]],
  ['razón con otro código', 'passive.error.reason',
    [['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { sold_out: { code: 'conflict' } }, collections, singletons };"],
      ["code: p.code, detail: text(p.detail, lang), ...extra,", "code: p.code, reason: 'sold_out', detail: text(p.detail, lang), ...extra,"]]],
  // sold_out está declarada con el code de los 404: solo falla porque el reason es una lista.
  ['razón que no es una cadena', 'passive.error.reason',
    [['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { sold_out: { code: 'not_found' } }, collections, singletons };"],
      ["code: p.code, detail: text(p.detail, lang), ...extra,", "code: p.code, ...(p.status === 404 && { reason: ['sold_out'] }), detail: text(p.detail, lang), ...extra,"]]],
  ['raíz en error con anchor vacío', 'discovery.service-doc',
    [['  if (!name) { // Discovery document, at the API root\n', "  if (!name) { // Discovery document, at the API root\n    if (read) throw new Problem(404, 'not_found', t('No discovery.', 'Sin descubrimiento.'), {}, { Link: `${link}, <${SPEC}>; rel=\"service-doc\"; anchor` });\n"]]],
  ['service-doc con destino mal formado', 'discovery.service-doc',
    [['const DOCS = `<${SPEC}>; rel="service-doc"; hreflang="en"; title="Restep 1, the specification", <https://restep.wubytes.com/es/1/>; rel="service-doc"; hreflang="es"`;',
      'const DOCS = `<http://[>; rel="service-doc"`;']]],
  ['service-doc con un escape no válido', 'discovery.service-doc',
    [['const DOCS = `<${SPEC}>; rel="service-doc"; hreflang="en"; title="Restep 1, the specification", <https://restep.wubytes.com/es/1/>; rel="service-doc"; hreflang="es"`;',
      'const DOCS = `<https://docs.example.test/%ZZ>; rel="service-doc"`;']]],
  ['1.1 con http_409 en una razón', 'discovery.reasons',
    [["const doc = { restep: RESTEP,", "const doc = { restep: '1.1',"],
      ['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { sold_out: { code: 'http_409' } }, collections, singletons };"]]],
  ['service-doc con la comilla sin cerrar', 'discovery.service-doc',
    [['const DOCS = `<${SPEC}>; rel="service-doc"; hreflang="en"; title="Restep 1, the specification", <https://restep.wubytes.com/es/1/>; rel="service-doc"; hreflang="es"`;',
      'const DOCS = `<${SPEC}>; rel="service-doc`;']]],
  ['service-doc anclado en otra API', 'discovery.service-doc',
    [['const DOCS = `<${SPEC}>; rel="service-doc"; hreflang="en"; title="Restep 1, the specification", <https://restep.wubytes.com/es/1/>; rel="service-doc"; hreflang="es"`;',
      'const DOCS = `<${SPEC}>; rel="service-doc"; anchor="https://other.example/api/"`;']]],
  // Sin descubrimiento, la raíz responde 404: el contexto de su Link no es la raíz salvo con anchor (RFC 8288, 3.2).
  ['raíz en error con service-doc sin anchor', 'discovery.service-doc',
    [['  if (!name) { // Discovery document, at the API root\n', "  if (!name) { // Discovery document, at the API root\n    if (read) throw new Problem(404, 'not_found', t('No discovery.', 'Sin descubrimiento.'), {}, { Link: `${link}, ${DOCS}` });\n"]]],
  ['raíz en error con anchor mal formado', 'discovery.service-doc',
    [['  if (!name) { // Discovery document, at the API root\n', "  if (!name) { // Discovery document, at the API root\n    if (read) throw new Problem(404, 'not_found', t('No discovery.', 'Sin descubrimiento.'), {}, { Link: `${link}, <${SPEC}>; rel=\"service-doc\"; anchor=\"http://[\"` });\n"]]],
  ['limit recortado en silencio', 'query.limit.range',
    [['if (!/^\\d+$/.test(params.get(\'limit\') ?? \'1\') || !Number.isInteger(limit) || limit < 1 || limit > coll.max_limit)',
      "if (!/^\\d+$/.test(params.get('limit') ?? '1') || !Number.isInteger(limit) || limit < 1)"]]],
  ['cursor sin firmar', 'query.cursor.tampered',
    [['if (parts.length === 2 && mac === sign(payload)) {', 'if (parts.length === 2) {']]],
  ['cursor sin ligar a la consulta', 'query.cursor.other-query',
    [['c.q !== print) throw', 'false) throw']]],
  // En los datos solo falta rating (en el libro 50), y rating admite ge.
  ['ge devuelve ausentes', 'query.filter.absent',
    [['items = items.filter((r) => at(r, field, coll) != null && OPS[op](compare(type, at(r, field, coll), v, collation)));',
      "items = items.filter((r) => (at(r, field, coll) == null && op === 'ge') || (at(r, field, coll) != null && OPS[op](compare(type, at(r, field, coll), v, collation))));"]]],
  ['le como lt', 'query.filter.match',
    [['le: (c) => c <= 0,', 'le: (c) => c < 0,']]],
  ['ausentes primero al ordenar', 'query.sort.order',
    [['return x == null ? 1 : -1; } // missing values last', 'return x == null ? -1 : 1; }']]],
  ['orden sin desempate', 'query.sort.stable',
    [["for (const s of [...sort, 'id']) {", 'for (const s of sort) {'],
      ['let items = applyFilters(coll, params);', 'let items = applyFilters(coll, params).sort(() => Math.random() - 0.5);']]],
  ['filtro repetido aceptado', 'query.filter.bad-value',
    [["if (seen.has(`${field}[${op}]`)) throw bad(key, SAME_FILTER);", ''],
      ["if (params.getAll(key).length > 1) throw once(key);", '']]],
  ['rango tomado por repetido', 'query.filter.same-field',
    [["if (seen.has(`${field}[${op}]`)) throw bad(key, SAME_FILTER);\n    seen.add(`${field}[${op}]`);",
      "if (seen.has(field)) throw bad(key, SAME_FILTER);\n    seen.add(field);"]]],
  ['filter[f] y filter[f][eq] como distintos', 'query.filter.bad-value',
    [["if (seen.has(`${field}[${op}]`)) throw bad(key, SAME_FILTER);\n    seen.add(`${field}[${op}]`);",
      "if (seen.has(key)) throw bad(key, SAME_FILTER);\n    seen.add(key);"]]],
  // Filtros con nombre (6.1): featured (interruptor) y search (string) en books.
  ['filtro con nombre que añade ítems', 'query.named-filter.narrows',
    [['items = items.filter((r) => named.apply(r, v));', "items = [...items, { id: 'restep-check-ghost', title: 'x' }];"]]],
  ['filtro con nombre ignorado junto a otro', 'query.named-filter.and',
    [['items = items.filter((r) => named.apply(r, v));', 'if ([...params.keys()].length === 1) items = items.filter((r) => named.apply(r, v));']]],
  ['filtro con nombre con operador', 'query.named-filter.operator',
    [["if (m[2] !== undefined) throw unsupported(key, t(`${field} is a named filter: it takes no operator.`, `${field} es un filtro con nombre: no lleva operador.`));", '']]],
  ['interruptor con valor aceptado', 'query.named-filter.bad-value',
    [["if (!named.type && value !== '') throw bad(key, t(`${field} is a switch: it takes no value.`, `${field} es un interruptor: no lleva valor.`));", '']]],
  ['filtro con nombre sin valor aceptado', 'query.named-filter.bad-value',
    [["if (named.type && value === '') throw bad(key, t(`${field} needs a ${named.type} value.`, `${field} necesita un valor ${named.type}.`));", '']]],
  ['filtro con nombre que se llama como un filtro', 'discovery.named-filters',
    [["      featured: { description:", "      price: { description: t('x', 'x'), apply: () => true },\n      featured: { description:"]]],
  ['filtro con nombre sin descripción', 'discovery.named-filters',
    [["[f, { ...(n.type && { type: n.type }), description: text(n.description, lang) }]", "[f, { ...(n.type && { type: n.type }) }]"]]],
  ['cursor ligado a limit', 'query.cursor.page-params',
    [["const PAGE_ONLY = ['cursor', 'limit', 'fields', 'include', 'count'];", "const PAGE_ONLY = ['cursor', 'count'];"]]],
  ['fields devuelve de más', 'query.fields',
    [['const out = { id: row.id };', 'const out = { id: row.id, year: row.year };']]],
  ['count sin declarar ignorado', 'query.count',
    [["...(count === 'true' && { total: items.length }),", '']]],
  ['ETag débil', 'writes.etag.strong',
    [['const etag = (value) => `"${hash(JSON.stringify(value))}"`;', 'const etag = (value) => `W/"${hash(JSON.stringify(value))}"`;']]],
  ['If-None-Match ignorado en GET', 'cache.if-none-match',
    [["if (weakMatch(req.headers['if-none-match'], tag)) return send(res, 304, undefined, headers);", '']]],
  ['If-Match ignorado', 'writes.if-match.stale',
    [["if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))\n    throw", 'if (false)\n    throw']]],
  ['If-Match no atómico', 'writes.if-match.race',
    [["    throw new Problem(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));",
      "    throw new Problem(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));\n  await new Promise((r) => setTimeout(r, 30));"]]],
  ['Idempotency-Key ignorada', 'writes.idempotency.replay',
    [['const live = saved && saved.expires > Date.now() ? saved : null;', 'const live = null;']]],
  ['precondición antes de repetir', 'writes.idempotency.replay-precondition',
    [['    if (live && live.print === print)\n', '    if (live && live.print === print && req.headers[\'if-none-match\'] === undefined)\n']]],
  ['huella con el texto literal', 'writes.idempotency.json-equality',
    [['const print = scope && hash(canonical([query, sent]));', 'const print = scope && hash(JSON.stringify([query, sent]));']]],
  ['clave mal formada aceptada', 'writes.idempotency.malformed',
    [["  if (!m) throw new Problem(400, 'bad_request',", "  if (!m) return null;\n  if (false) throw new Problem(400, 'bad_request',"]]],
  ['clave con parámetros aceptada', 'writes.idempotency.malformed',
    [["const m = raw.trim().match(/^\"((?:[\\x20\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\"\\\\])*)\"$/);", "const m = raw.trim().replace(/;.*$/, '').match(/^\"((?:[\\x20\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\"\\\\])*)\"$/);"]]],
  ['clave mal formada sin entrada', 'writes.idempotency.malformed',
    [["    { errors: [{ header: 'Idempotency-Key', code: 'format',", "    { errors: [{ pointer: '/', code: 'format',"]]],
  ['POST acepta id', 'core.post.id',
    [["  if (from === 'server') return [{ pointer: '/id', code: 'read_only'", "  if (false) return [{ pointer: '/id', code: 'read_only'"]]],
  ['PATCH guarda los _', 'core.patch.underscore',
    [["const body = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));", 'const body = v;'],
      ['if (!Object.hasOwn(coll.types, f)) { errors.push(', "if (!Object.hasOwn(coll.types, f) && !f.startsWith('_')) { errors.push("]]],
  ['null no borra', 'core.patch.merge',
    [['if (v === null) delete out[k];', 'if (v === null) out[k] = out[k];']]],
  ['DELETE con 200', 'core.delete',
    [["    return send(res, 204, undefined, invalidation);\n  }", "    return send(res, 200, { deleted: true });\n  }"]]],
  ['resource sin la barra final', 'oauth.metadata',
    [["const meta = { resource: `http://${req.headers.host}/`,", "const meta = { resource: `http://${req.headers.host}`,"]], OAUTH],
  ['metadatos con credenciales', 'oauth.metadata',
    [["if (TOKEN && url.pathname === METADATA) {", "if (TOKEN && url.pathname === METADATA && req.headers.authorization === `Bearer ${TOKEN}`) {"]], OAUTH],
  ['metadatos sin caché pública', 'oauth.metadata.recommended',
    [["'Cache-Control': 'public, max-age=3600' });", "'Cache-Control': 'no-store' });"]], OAUTH],
  ['401 de la raíz sin resource_metadata', 'oauth.challenge',
    [[', resource_metadata="http://${req.headers.host}${METADATA}"${sent}`;', '${sent}`;']], OAUTH],
  ['401 de una colección que apunta a la raíz', 'oauth.challenge.elsewhere',
    [["const challenge = req.url !== '/' ? `Bearer realm=\"restep\"${sent}`", "const challenge = false ? ''"]], OAUTH],
  ['emisor que no es una URL https', 'oauth.metadata',
    [["authorization_servers: ['https://auth.example.com'],", "authorization_servers: [''],"]], OAUTH],
  ['invalid_parameter sin parameter', 'passive.error.parameter',
    [["const bad = (parameter, detail) => new Problem(400, 'invalid_parameter', detail, { parameter });", "const bad = (parameter, detail) => new Problem(400, 'invalid_parameter', detail, {});"]]],
  ['errores sin detail', 'passive.error.detail',
    [['code: p.code, detail: text(p.detail, lang), ...extra,', 'code: p.code, ...extra,']]],
  ['descripción vacía en el descubrimiento', 'discovery.describing',
    [['description: text(c.description, lang), methods: c.methods,', "description: '', methods: c.methods,"]]],
  ['colección que sirve el GET que no declara', 'core.methods.left-out',
    [['methods: c.methods, item_methods: c.item_methods,', "methods: c === db.authors ? ['POST'] : c.methods, item_methods: c.item_methods,"]]],
  ['HEAD servido aunque methods no declara GET', 'core.methods.left-out',
    [AUTHORS_POST_ONLY, ["const withHead = (methods) => (methods.includes('GET') ? [...methods, 'HEAD'] : methods);", "const withHead = (methods) => [...methods, 'HEAD'];"]]],
  ['ítem que sirve el GET que no declara', 'core.methods.left-out',
    [['methods: c.methods, item_methods: c.item_methods,', "methods: c.methods, item_methods: c === db.authors ? ['PATCH', 'DELETE'] : c.item_methods,"]]],
  ['colección con sync sin in en el filtro de id', 'discovery.sync-id',
    [...CHANGES, ["filter: { id: ['eq', 'in'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],", "filter: { id: ['eq'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],"]]],
  ['methods declarados que no coinciden con Allow', 'core.methods.allow',
    [['description: text(c.description, lang), methods: c.methods,', "description: text(c.description, lang), methods: ['GET', 'POST', 'DELETE'],"]]],
  ['item_methods declarados que no coinciden con Allow', 'core.methods.allow',
    [['item_methods: c.item_methods,', "item_methods: ['GET', 'POST', 'PATCH', 'DELETE'],"]]],
  ['el esquema create exige lo que el servidor no comprueba', 'core.schema.create',
    [['for (const f of coll.required) if', 'for (const f of []) if']]],
  ['estado del servicio en caché', 'core.status',
    [["res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' });", "res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'max-age=60' });"]]],
  ['estado del servicio que no responde a HEAD', 'core.status',
    [["res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' });", "res.writeHead(method === 'HEAD' ? 404 : 200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' });"]]],
  ['PATCH con un campo desconocido a null', 'core.schema.update',
    [["  if (unknown.length) throw invalid(", "  if (false) throw invalid("]]],
  // Idioma (3, 5.6, 6.1): los textos de la API siguen a Accept-Language, los datos nunca; mapas de idioma.
  ['406 a un Accept-Language que no ofrece', 'core.language.fallback',
    [["  const method = req.method;\n", "  const method = req.method;\n  if (/qaa/i.test(req.headers['accept-language'] ?? '')) throw new Problem(406, 'not_acceptable', 'Only en and es.');\n"]]],
  ['400 a un Accept-Language mal formado', 'core.language.fallback',
    [["  const method = req.method;\n", "  const method = req.method;\n  if (/q=abc/.test(req.headers['accept-language'] ?? '')) throw bad('Accept-Language', 'Malformed.');\n"]]],
  ['errores sin Vary', 'core.language.vary',
    [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang,", "{ 'Cache-Control': 'no-store', 'Content-Language': lang,"]]],
  ['descubrimiento sin Vary en el idioma por defecto', 'core.language.vary',
    [["'Cache-Control': 'public, max-age=300', Vary: 'Accept-Language',", "'Cache-Control': 'public, max-age=300', ...(lang !== 'en' && { Vary: 'Accept-Language' }),"]]],
  ['la misma ETag del descubrimiento en todos los idiomas', 'core.language.vary',
    [['ETag: etag([lang, doc]),', 'ETag: etag(Object.keys(doc)),']]],
  ['ETag del ítem según el idioma', 'core.language.data',
    [["      tag = fields || included.length ? etag(data) : etag(row);", "      tag = etag([data, req.headers['accept-language']]);"]]],
  ['claves de un mapa con la región en mayúsculas', 'core.language.maps',
    [["'es-es': 'Goma de borrar', 'es-mx': 'Goma' },", "'es-es': 'Goma de borrar', 'es-MX': 'Goma' },"]]],
  ['etiqueta en mayúsculas pasada a minúsculas', 'core.language.format',
    [['  const errors = languageErrors(coll, patch, current);',
      '  for (const f of maps(coll)) if (isObject(patch[f])) patch[f] = Object.fromEntries(Object.entries(patch[f]).map(([k, v]) => [k.toLowerCase(), v]));\n  const errors = languageErrors(coll, patch, current);']]],
  ['claves que se borran sin validar', 'core.language.format',
    [['      if (!wellFormed) errors.push(', '      if (!wellFormed && s !== null) errors.push(']]],
  ['mapa vaciado como ausente', 'core.language.merge',
    [['  const row = withMaps(coll, { ...mergePatch(current, patch), id });', '  const row = { ...mergePatch(current, patch), id };']]],
  ['mapa reemplazado entero en un PATCH', 'core.language.merge',
    [['  const row = withMaps(coll, { ...mergePatch(current, patch), id });',
      '  const row = withMaps(coll, { ...mergePatch(current, patch), ...Object.fromEntries(maps(coll).filter((f) => isObject(patch[f])).map((f) => [f, patch[f]])), id });']]],
  ['mapa de idioma declarado en filter', 'query.language.declared',
    [["'name.es-mx': ['eq', 'in'], 'name.en-gb': ['eq', 'in'] },", "'name.es-mx': ['eq', 'in'], 'name.en-gb': ['eq', 'in'], name: ['null'] },"]]],
  ['traducción que cae al idioma sin región', 'query.language.exact',
    [["  return row[m]?.[rest];\n};", "  return row[m]?.[rest] ?? row[m]?.[rest.split('-')[0]];\n};"]]],
  ['languages sin reservar', 'core.reserved.get',
    [["'cursor', 'since', 'languages'];", "'cursor', 'since'];"]]],
  ['fields con una ruta dentro de un mapa como no admitido', 'query.fields.unknown',
    [["      throw bad('fields', t(`${f.split('.')[0]} is a language map", "      throw unsupported('fields', t(`${f.split('.')[0]} is a language map"]]],
  ['language_maps con valores que no son objetos', 'discovery.language-maps',
    [['language_maps: Object.fromEntries(maps(c).map((f) => [f, {}]))', 'language_maps: Object.fromEntries(maps(c).map((f) => [f, true]))']]],
  // Valores heredados (5.7): products y categories toman tax_rate de su categoría, de su padre o del valor por defecto.
  ['inherit con una relación sin declarar', 'discovery.inherit',
    [['{ own: i.own, from: i.from, default:', "{ own: i.own, from: [...i.from, 'shelf'], default:"]]],
  ['el efectivo no sale del propio', 'inherit.read',
    [['if (row[coll.inherit[f].own] == null) why[f] =', 'why[f] ='],
      ['  if (row[rule.own] != null) return { value: row[rule.own], href:', '  if (false) return { value: row[rule.own], href:']]],
  ['href al padre inmediato', 'inherit.read',
    [['return to.inherit?.[f] ? source(to, target, f, seen) :', 'return to.inherit?.[f] ? { ...source(to, target, f, seen), href: `/${nameOf(to)}/${target.id}` } :']]],
  ['devolver lo leído fija el heredado', 'inherit.roundtrip',
    [['    delete body[f];\n  }\n  return errors;', '    if (current && same(body[f], now)) body[rule.own] = body[f];\n    delete body[f];\n  }\n  return errors;']]],
  ['otro valor en el efectivo se ignora', 'inherit.read-only',
    [['    if (!same(body[f], now)) errors.push(', '    if (false) errors.push(']]],
  ['null en el propio no vuelve a heredar', 'inherit.own',
    [['  errors.push(...relationErrors(coll, patch, id, current), ...inheritErrors(coll, patch, current));',
      '  errors.push(...relationErrors(coll, patch, id, current), ...inheritErrors(coll, patch, current));\n  for (const i of Object.values(coll.inherit ?? {})) if (patch[i.own] === null) delete patch[i.own];']]],
  ['POST con otro valor en el efectivo', 'inherit.post',
    [['    if (!same(body[f], now)) errors.push(', '    if (current && !same(body[f], now)) errors.push(']]],
  ['_inherited entero con fields', 'inherit.fields',
    [['Object.entries(row._inherited).filter(([f]) => f in out) : [];', 'Object.entries(row._inherited) : [];']]],
  ['ciclo aceptado', 'inherit.cycle',
    [['    if (rel.to === nameOf(coll.base ?? coll) && id !== undefined && isObject(body[r])) {', '    if (false) {']]],
  ['los hijos no se recalculan', 'inherit.source',
    [['  refresh(); // 11.6: effective values, after any write (a DELETE may have unlinked items)\n', ''],
      ['  coll.rows.set(id, row);\n  refresh();', '  coll.rows.set(id, row);\n  refresh(row);']]],
  ['efectivo desfasado aceptado', 'inherit.stale',
    [['now = current ? current[f] :', 'now = current ? body[f] :']]],
  // Campos de solo lectura (5.1).
  ['otro id sin entrada read_only', 'core.patch.id',
    [["throw invalid([{ pointer: '/id', code: 'read_only', detail: t('id cannot change.'", "throw invalid([{ pointer: '/id', code: 'range', detail: t('id cannot change.'"]]],
  ['el id actual también se rechaza', 'core.patch.roundtrip',
    [["if ('id' in patch && patch.id !== id) throw invalid(", "if ('id' in patch) throw invalid("]]],
  ['campo readOnly que se guarda', 'core.patch.read-only', [RATING_SCHEMA, RATING_SET]],
  // _etag en los ítems de una colección (7.2): SHOULD sin :changes, MUST con él.
  ['colección sin _etag', 'writes.etag.collection', [[ETAG_LIST, 'items: page.map((r) => pick(expand(r, coll, include), fields)), next,']], undefined, 'warn'],
  ['colección con un _etag que no es el del ítem', 'writes.etag.collection', [[ETAG_LIST, 'items: page.map((r) => ({ ...pick(expand(r, coll, include), fields), _etag: etag([r]) })), next,']], undefined, 'warn'],
  ['colección con :changes sin _etag', 'writes.etag.collection', [...CHANGES, [ETAG_LIST, 'items: page.map((r) => pick(expand(r, coll, include), fields)), next,']], undefined, 'fail'],
  ['colección con :changes y un _etag que no es el del ítem', 'writes.etag.collection',
    [...CHANGES, [ETAG_LIST, 'items: page.map((r) => ({ ...pick(expand(r, coll, include), fields), _etag: etag([r]) })), next,']], undefined, 'fail'],
  ['colección con :changes sin _etag cuando se pide fields', 'writes.etag.collection',
    [...CHANGES, [ETAG_LIST, 'items: page.map((r) => ({ ...pick(expand(r, coll, include), fields), ...(!fields && { _etag: etag(r) }) })), next,']], undefined, 'fail'],
  // 409 request_in_progress (5.4, 7.1).
  ['request_in_progress sin Retry-After', 'passive.error.request-in-progress',
    [[IN_PROGRESS, "      throw new Problem(409, 'request_in_progress', 'The first request is still running.');"]]],
  // CORS (5.8).
  ['CORS sin exponer ETag', 'core.cors.expose', [...CORS, ["'Access-Control-Expose-Headers': 'ETag, Location,", "'Access-Control-Expose-Headers': 'Location,"]]],
  ['CORS sin Vary: Origin', 'core.cors.vary', [...CORS, ["Vary: headers.Vary ? `${headers.Vary}, Origin` : 'Origin',", '']]],
  ['CORS sin Access-Control-Allow-Origin en los errores', 'core.cors.errors', [...CORS, ['...(origin && {', '...(origin && status < 400 && {']]],
  ['preflight sin If-Match', 'core.cors.preflight', [...CORS, ['Content-Type, If-Match, If-None-Match', 'Content-Type, If-None-Match']]],
  ['preflight sin PATCH', 'core.cors.preflight', [...CORS, ["'GET, POST, PATCH, DELETE'", "'GET, POST, DELETE'"]]],
  ['preflight con * y credenciales', 'core.cors.preflight', [...CORS, CORS_CREDENTIALS,
    ["'Access-Control-Allow-Headers': 'Content-Type, If-Match, If-None-Match, Idempotency-Key, Prefer, Authorization, DPoP'", "'Access-Control-Allow-Headers': '*'"]]],
  ['CORS con * y credenciales', 'core.cors.credentials',
    [...CORS, ["'Access-Control-Allow-Origin': origin,", "'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true',"]]],  // Borrador 6.
  // Tipos de medio (3): las 2xx con cuerpo son application/json; un POST con otro tipo, sin él o con otro charset da 415.
  ['2xx que no son application/json', 'passive.json-type', [["const type = status >= 400 ? 'application/problem+json' : 'application/json';", "const type = status >= 400 ? 'application/problem+json' : 'text/json';"]]],
  ['POST sin Content-Type aceptado', 'core.post.media-type', [["  if (!mediaTypeOk(req.headers['content-type'], types))", "  if (req.headers['content-type'] !== undefined && !mediaTypeOk(req.headers['content-type'], types))"]]],
  ['POST con text/plain aceptado', 'core.post.media-type', [["  if (!types.includes(type.trim().toLowerCase())) return false;", "  if (!types.includes(type.trim().toLowerCase()) && type.trim() !== 'text/plain') return false;"]]],
  ['charset=UTF-8 rechazado', 'core.post.charset', [["    if (value.toLowerCase() !== 'utf-8') return false;", "    if (value !== 'utf-8') return false;"]]],
  ['PATCH con text/plain aceptado', 'core.415', [["method === 'PATCH' ? await readJson(req, ['application/merge-patch+json', 'application/json']", "method === 'PATCH' ? await readJson(req, ['application/merge-patch+json', 'application/json', 'text/plain']"]]],
  ['415 sin Accept-Patch', 'core.415.accept-patch', [["types.includes('application/merge-patch+json') ? { 'Accept-Patch': 'application/merge-patch+json' } : {});", '{});']], undefined, 'warn'],
  // Respuestas privadas (5.1).
  ['401 que se puede guardar', 'passive.error.private', [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang, ...req.extra,", "{ 'Cache-Control': p.status === 401 ? 'public, max-age=60' : 'no-store', Vary: 'Accept-Language', 'Content-Language': lang, ...req.extra,"],
    ["if (TOKEN && cc && !cc.includes('no-store'))", "if (TOKEN && cc && !cc.includes('no-store') && status !== 401)"]], OAUTH],
  ['respuestas con token sin private', 'core.private', [["if (TOKEN && cc && !cc.includes('no-store'))", 'if (false)']], OAUTH],
  // Descubrimiento (1.1, 3, 4.2, 5.1, 5.5, 5.9, 6.1, 11.6).
  ['restep sin el punto del sufijo', 'discovery.version', [["const RESTEP = '1.0-draft.6';", "const RESTEP = '1.0-draft6';"]]],
  ['descubrimiento distinto en cada lectura', 'discovery.same', [["const doc = { restep: RESTEP, version: '1',", "const doc = { restep: RESTEP, 'x-served': String(process.hrtime.bigint()), version: '1',"]]],
  ['razón con un nombre fuera de la gramática', 'discovery.names', [['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { 'Sold out': { code: 'conflict' } }, collections, singletons };"]]],
  ['miembro propio sin x-', 'discovery.members', [["const doc = { restep: RESTEP, version: '1',", "const doc = { restep: RESTEP, opening_hours: '9-21', version: '1',"]]],
  ['filtro de id con lt', 'discovery.ops', [["filter: { id: ['eq', 'in'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],", "filter: { id: ['eq', 'in', 'lt'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],"]]],
  ['id_from desconocido', 'discovery.id-from', [["    id_from: 'either',", "    id_from: 'mixed',"]]],
  ['colación en id', 'discovery.collations', [["    collations: { name: 'server' },", "    collations: { name: 'server', id: 'server' },"]]],
  ['subcolección sin parent', 'discovery.subcollections', [['    const singletons = { shop:', "    collections.reviews = { path: '/books/{id}/reviews' };\n    const singletons = { shop:"]]],
  ['recurso suelto con la ruta de un ítem', 'discovery.singletons', [["  path: '/shop',", "  path: '/books/shop',"]]],
  ['aviso sin announced', 'discovery.deprecations', [["deprecations: [{ kind: 'sort', name: 'year', announced: '2026-11-20T00:00:00Z', sunset:", "deprecations: [{ kind: 'sort', name: 'year', sunset:"]]],
  ['announced que cambia', 'evolution.announced', [["announced: '2026-11-20T00:00:00Z', sunset:", "get announced() { return new Date(Date.now() - Math.floor(Math.random() * 1e9)).toISOString(); }, sunset:"]]],
  ['orden retirado sin Deprecation', 'evolution.deprecation-header', [['return used.length ? { Deprecation: epoch(used[0].announced), Link:', 'return used.length ? { Link:']]],
  ['inherit sin anunciar la extensión', 'discovery.inherit', [["const EXTENSIONS = TOKEN ? ['actions', 'inherit', 'oauth'] : ['actions', 'inherit'];", "const EXTENSIONS = TOKEN ? ['actions', 'oauth'] : ['actions'];"]]],
  // Rutas e id (3, 5.1).
  ['/books/07 es /books/7', 'core.not-found.id-form', [["segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);", "segments = url.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x).replace(/^0+(?=\\d)/, ''));"]]],
  ['filter con tres corchetes aceptado', 'core.reserved.forms', [["const m = key.match(/^filter\\[([^\\]]+)\\](?:\\[([^\\]]+)\\])?$/);", "const m = key.match(/^filter\\[([^\\]]+)\\](?:\\[([^\\]]+)\\])?(?:\\[[^\\]]*\\])*$/);"]]],
  ['POST con id sin entrada read_only', 'core.post.id', [["  if (from === 'server') return [{ pointer: '/id', code: 'read_only'", "  if (from === 'server') return [{ pointer: '/id', code: 'type'"]]],
  ['id del cliente ignorado', 'core.client-id', [["const row = withMaps(coll, { ...body, id: 'id' in body ? body.id : newId(coll) });", 'const row = withMaps(coll, { ...body, id: newId(coll) });']]],
  ['id del cliente obligatorio sin exigir', 'core.client-id.required', [["    id_from: 'either',", "    id_from: 'client',"], ["  if (!('id' in body)) return from === 'client' ? [{", "  if (!('id' in body)) return false ? [{"]]],
  ['id mal formado aceptado', 'core.client-id.format', [["  if (!ID.test(body.id) || body.id === '.' || body.id === '..')", '  if (false)']]],
  ['id de un ítem borrado reutilizado', 'core.client-id.taken', [['  if (self === undefined && coll.used.has(row.id))', '  if (self === undefined && coll.rows.has(row.id))']]],
  // Recurso suelto (5.9).
  ['recurso suelto que no es un objeto', 'core.singleton', [[': withEtag(shop.row);', ': [withEtag(shop.row)];']]],
  ['recurso suelto con POST', 'core.singleton.methods', [["  if (!allow.split(', ').includes(method))", "  if (method === 'PUT')"]]],
  ['recurso suelto que acepta include', 'core.singleton.params', [["    if (!read || base !== 'fields' || key !== base) throw unsupported(key);", "    if (!read || !['fields', 'include'].includes(base) || key !== base) throw unsupported(key);"]]],
  ['PATCH {} que cambia el recurso suelto', 'core.singleton.patch', [['  const row = mergePatch(current, patch);', '  const row = { ...mergePatch(current, patch), max_reservations: current.max_reservations + 1 };']]],
  // Relaciones en una escritura (5.1).
  ['relación inexistente sin entrada en su id', 'core.relation.unknown', [["errors.push({ pointer: `${where}/id`, code: 'unknown',", "errors.push({ pointer: where, code: 'unknown',"]]],
  ['relación que guarda lo que trae', 'core.relation.replace', [['  return linkOf(rel, v);\n}', '  return v;\n}']]],
  // query (5.2, 5.3, 6.1, 6.3, 6.5).
  ['+ literal en la query', 'query.plus', [['  const params = url.searchParams;', "  const params = new URLSearchParams(url.search.replace(/\\+/g, '%2B'));"]]],
  ['cursor ligado al orden de los parámetros', 'query.reencode', [['  const q = [...params].filter(([k]) => !PAGE_ONLY.includes(k)).sort();', '  const q = [...params].filter(([k]) => !PAGE_ONLY.includes(k));']]],
  ['in recortado en silencio', 'query.limits', [['      if (values.length > MAX_IN) throw bad(', '      if (values.length > MAX_IN) values.length = MAX_IN;\n      if (false) throw bad(']]],
  ['fields=id rechazado', 'query.fields', [['  return fields;\n}', "  if (fields.length === 1 && fields[0] === 'id') throw bad('fields', 'id alone is not a list.');\n  return fields;\n}"]]],
  ['fields aceptado en escrituras', 'query.fields.writes', [['  const allowed = !read ? [] :', "  const allowed = !read ? ['fields'] :"]]],
  ['ruta por una relación a muchos en filter', 'query.filter.lists', [["{ to: rel.to, ...(rel.many && { many: true }),", "{ to: rel.to, ...((rel.many || c === db.products) && { many: true }),"],
    ["tax_rate_own: ['null'], 'name.es-mx'", "tax_rate_own: ['null'], 'category.id': ['eq'], 'name.es-mx'"]]],
  ['count=false sin count declarado', 'query.count.undeclared', [["    count: 'exact',\n    // 5.5: sorting by year", '    // 5.5: sorting by year'], ["  if (count !== null && !coll.count) throw unsupported('count');", "  if (count === 'true' && !coll.count) throw unsupported('count');"]]],
  // writes (7.1, 7.2).
  ['ítem completo sin _etag', 'writes.etag.member', [['data = fields || included.length ? { ...pick(expand(row, coll, included), fields), _etag: etag(row) } : withEtag(row);', 'data = fields || included.length ? { ...pick(expand(row, coll, included), fields), _etag: etag(row) } : row;']]],
  ['PATCH sin _etag en la respuesta', 'writes.etag.write', [['prefer ? undefined : withEtag(row), { ETag: etag(row), ...invalidation, ...applied });', 'prefer ? undefined : row, { ETag: etag(row), ...invalidation, ...applied });']]],
  ['If-Match ignorado en un POST', 'writes.if-match.post', [["    if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], collTag))", '    if (false)']]],
  ['412 a un ítem recién borrado', 'writes.if-match.deleted', [['  if (id !== undefined && !coll.rows.has(id)) throw missing(url);', "  if (id !== undefined && !coll.rows.has(id)) { if (req.headers['if-match'] && coll.used.has(id)) throw new Problem(412, 'precondition_failed', 'Gone.'); throw missing(url); }"]]],
  ['la query no cuenta en la clave', 'writes.idempotency.mismatch', [['const print = scope && hash(canonical([query, sent]));', 'const print = scope && hash(canonical([[], sent]));']]],
  ['dos POST a la vez con la misma clave', 'writes.idempotency.concurrent', [["    if (live) throw new Problem(422, 'idempotency_mismatch',", "    await new Promise((r) => setTimeout(r, 30));\n    if (live) throw new Problem(422, 'idempotency_mismatch',"]]],
  ['anonymous false sin rechazar', 'writes.idempotency.anonymous', [['idempotency: { ttl: TTL / 1000 },', 'idempotency: { ttl: TTL / 1000, anonymous: false },']]],
  // cache (8) y enlaces (3).
  ['ítem sin ETag', 'cache.etag', [["const headers = { ETag: tag, 'Cache-Control': 'no-cache', 'Cache-Groups': groups(paths), ...req.extra };", "const headers = { ...(id === undefined && { ETag: tag }), 'Cache-Control': 'no-cache', 'Cache-Groups': groups(paths), ...req.extra };"]]],
  ['recurso suelto que ignora If-Match', 'core.singleton.patch', [["  if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], etag(current)))", '  if (false)']]],
  ['colación en un enum que no es clave de orden', 'discovery.collations', [["    sort: ['id', 'title', 'price', 'rating', 'year'],", "    sort: ['id', 'title', 'price', 'rating', 'year'],\n    collations: { category: 'server' },"]]],
  // Subcolecciones (4.2, 5.1, 6.1): las reseñas de cada libro, en /books/{book_id}/reviews.
  ['subcolección bajo un padre que no existe', 'core.subcollection.parent', [['  if (!subName || !top.rows.has(id)) throw missing(url);', '  if (!subName) throw missing(url);']]],
  ['subcolección que sobrevive a su padre', 'core.subcollection.delete', [['  if (!subName || !top.rows.has(id)) throw missing(url);', '  if (!subName) throw missing(url);'],
    ['      db[sub].byParent.delete(id);\n', '']]],
  ['subcolección sin parent declarado', 'discovery.subcollections', [['      path: c.path ?? `/${n}`, ...(c.parent && { parent: c.parent }), description:', '      path: c.path ?? `/${n}`, description:']]],
  ['filtro por el id de un ítem de subcolección', 'query.filter.lists', [["      'author.id': ['eq', 'in'],", "      'author.id': ['eq', 'in'], 'highlight.id': ['eq'],"]]],
  // relations (9).
  ['relación a una colección no declarada', 'discovery.relations', [['{ to: rel.to, ...(rel.many && { many: true }),', "{ to: rel.to === 'authors' ? 'writers' : rel.to, ...(rel.many && { many: true }),"]]],
  ['relación a una subcolección sin href', 'relations.objects', [["highlight: { id: '1', href: '/books/7/reviews/1' } },", "highlight: { id: '1' } },"]]],
  ['relación a varias colecciones sin type', 'relations.objects', [["showcase: { type: 'books', id: '7' }", "showcase: { id: '7' }"]]],
  ['href a otro ítem', 'relations.href', [["highlight: { id: '1', href: '/books/7/reviews/1' } },", "highlight: { id: '1', href: '/books/7/reviews/2' } },"]]],
  ['include ignorado', 'relations.include', [['  if (!here.length) return row;\n  const out = { ...row };', '  return row;\n  const out = { ...row };']]],
  ['include más hondo que include_depth', 'relations.include.unsupported', [['    if (segs.length > (coll.include_depth ?? 1))', '    if (false)']]],
  ['include_depth sin respetar', 'relations.include.depth', [['    if (segs.length > (coll.include_depth ?? 1))', '    if (segs.length > 1)']]],
  ['fields con punto sin include', 'relations.fields', [['  if (!include.includes(`${prefix}${m}`)) throw bad(', '  if (false) throw bad(']]],
  ['filtro por author.name que no mira al autor', 'query.filter.match', [["return rest === 'id' ? row[m]?.id : lookup(rel.to, row[m])?.[rest];", "return rest === 'id' ? row[m]?.id : undefined;"]]],
  ['href de subcolección sin comprobar', 'core.relation.href', [['  if (to.parent && (typeof v.href !== \'string\' ||', '  if (false && (typeof v.href !== \'string\' ||'],
    ['  if (!to.parent) return to.rows.get(v.id);\n', '  if (!to.parent) return to.rows.get(v.id);\n  for (const m of to.byParent.values()) if (m.has(v.id)) return m.get(v.id);\n']]],
  // actions (11.1): restock y low_stock en products, inherit_tax en categories, find_or_create en authors.
  ['acción con un on desconocido', 'discovery.actions', [['[a, { on: d.on, safe: d.safe,', "[a, { on: d.on === 'item' ? 'element' : d.on, safe: d.safe,"]]],
  ['acción de ítem pedida en la colección', 'actions.undeclared', [["decl.on !== (id === undefined ? 'collection' : 'item') || ", '']]],
  ['acción con otro método sin 405', 'actions.method', [["  if (!allow.includes(req.method))\n    throw new Problem(405, 'method_not_allowed', t(`Supports ${allow.join(', ')}.`", "  if (!allow.includes(req.method))\n    throw missing(url);\n  if (false) throw new Problem(405, 'method_not_allowed', t(`Supports ${allow.join(', ')}.`"]]],
  ['acción con %3A sin reconocer', 'actions.colon', [["const last = segments.at(-1), colon = last.indexOf(':');", "const last = segments.at(-1), colon = url.pathname.split('/').at(-1).indexOf(':');"]]],
  ['acción GET sin HEAD', 'actions.get', [["const allow = decl.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];", "const allow = decl.method === 'GET' ? ['GET'] : ['POST'];"]]],
  ['_actions con otro método', 'actions.listed', [["{ method: a.method ?? 'POST', href:", "{ method: 'GET', href:"]]],
  ['acción con cuerpo vacío como no JSON', 'actions.empty-body', [['    if (!Buffer.concat(raw).length) return [{}, {}];\n', '']]],
  ['acción que responde 202', 'actions.response', [['row.stock = (row.stock ?? 0) + body.quantity; return [200, row];', 'row.stock = (row.stock ?? 0) + body.quantity; return [202, row];']]],
  ['acción idempotente que rechaza la clave', 'actions.idempotency-key', [['  const scope = decl.idempotent ? null : idempotencyScope(req, url.pathname);',
    "  if (decl.idempotent && req.headers['idempotency-key']) throw new Problem(400, 'bad_request', 'No keys here.');\n  const scope = decl.idempotent ? null : idempotencyScope(req, url.pathname);"]]],
  ['next con un esquema ajeno', 'passive.links', [['    next = `${path}?${q}`;', '    next = `ftp://localhost${path}?${q}`;']]],
];

// Variantes correctas: cada comprobación de la lista tiene que pasar (sin fallo ni aviso) y el comprobador no puede romperse.
const VARIANTS = [
  ['campo calculado readOnly', ['core.patch.roundtrip', 'core.patch.read-only', 'core.patch.merge'], [RATING_SCHEMA, RATING_SET, RATING_RULE]],
  ['raíz en error con service-doc anclado a la raíz', ['discovery.service-doc'],
    [['  if (!name) { // Discovery document, at the API root\n', "  if (!name) { // Discovery document, at the API root\n    if (read) throw new Problem(404, 'not_found', t('No discovery.', 'Sin descubrimiento.'), {}, { Link: `${link}, <${SPEC}>; rel=\"service-doc\"; anchor=\"/\"` });\n"]]],
  // 1.1: un código nuevo, desconocido para el comprobador, no se juzga; su razón declarada sí.
  ['1.1 con un código y una razón nuevos', ['discovery.reasons', 'passive.error.code', 'passive.error.reason'],
    [["const doc = { restep: RESTEP,", "const doc = { restep: '1.1',"],
      ['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { gone_fishing: { code: 'out_to_lunch', description: 'Back soon.' } }, collections, singletons };"],
      ["code: p.code, detail: text(p.detail, lang), ...extra,", "code: p.status === 404 ? 'out_to_lunch' : p.code, ...(p.status === 404 && { reason: 'gone_fishing' }), detail: text(p.detail, lang), ...extra,"]]],
  ['colección con :changes y _etag', ['writes.etag.collection'], CHANGES],
  // 10: discovery.sync-id se informa como las demás declaraciones, también cuando pasa.
  ['colección con sync que declara id con in', ['discovery.sync-id'], CHANGES],
  // 4.3: lo que no se puede ejercitar sin GET se omite; el 405 con su Allow es un acierto. Nada falla ni avisa.
  ['colección sin GET declarado', ['core.methods.left-out', 'core.method-not-allowed', 'core.methods.allow'], [AUTHORS_POST_ONLY], undefined, [], true],
  ['ítems sin GET declarado', ['core.methods.left-out', 'core.collection.shape', 'core.reserved.get'], [AUTHORS_ITEMS_NO_GET], undefined, [], true],
  ['request_in_progress con Retry-After', ['passive.error.request-in-progress', 'passive.error.code'],
    [[IN_PROGRESS, "      throw new Problem(409, 'request_in_progress', 'The first request is still running.', {}, { 'Retry-After': '1' });"]]],
  ['CORS completo', ['core.cors.expose', 'core.cors.errors', 'core.cors.preflight', 'core.cors.vary'], CORS],
  ['CORS con credenciales', ['core.cors.expose', 'core.cors.errors', 'core.cors.preflight', 'core.cors.vary', 'core.cors.credentials'], [...CORS, CORS_CREDENTIALS]],
  ['CORS con * sin credenciales', ['core.cors.expose', 'core.cors.errors', 'core.cors.preflight'],
    [...CORS, ["'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'ETag, Location, Link, Allow, Accept-Patch, Retry-After, Deprecation, Sunset, Idempotent-Replayed, Preference-Applied, Accept-Query'",
      "'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': '*'"],
      ["'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, If-Match, If-None-Match, Idempotency-Key, Prefer, Authorization, DPoP'",
        "'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*'"]]],
  // Borrador 6: ids elegidos por el cliente, campos únicos con --fixture y recursos que exigen cabeceras al escribir.
  ['id del cliente obligatorio', ['core.post', 'core.client-id', 'core.client-id.required', 'core.client-id.format', 'core.client-id.taken'], [["    id_from: 'either',", "    id_from: 'client',"]]],
  ['fixture con plantilla {{n}}', ['core.post', 'core.client-id', 'core.client-id.taken', 'core.post.charset', 'writes.idempotency.replay', 'writes.minimal', 'inherit.cycle'], [], undefined,
    ['--fixture', 'categories={"name":"Restep check {{n}}","tax_rate_own":null}'], true],
  ['varios fixtures sin plantilla', ['core.post'], [], undefined, ['--fixture', 'categories={"name":"Restep uno"}', '--fixture', 'categories={"name":"Restep dos"}'], true],
  // 6.1: un enum de cadenas que es clave de orden puede llevar colación.
  ['colación en un enum que es clave de orden', ['discovery.collations', 'query.sort.order'], [["    sort: ['id', 'title', 'price', 'rating', 'year'],", "    sort: ['id', 'title', 'price', 'rating', 'year', 'category'],\n    collations: { category: 'server' },"]]],
  // 1.2: el texto de la 1.0 aún no existe, así que bajo "1.0" inherit, experimental, no se usa (skip: debe omitirse).
  ['1.0 sin texto: inherit no se usa', ['skip:inherit.read', 'skip:inherit.roundtrip'], [["const RESTEP = '1.0-draft.6';", "const RESTEP = '1.0';"]]],
  // 6.4: sin max_limit, limit da unsupported_parameter; el orden estable se comprueba sin limit, con el tamaño
  // de página del servidor, y nada falla por ese 400, que es lo que el texto exige.
  ['colección sin max_limit', ['query.limit', 'query.sort.stable'],
    [['schemas: schemas(c, lang), max_limit: c.max_limit,', 'schemas: schemas(c, lang), max_limit: c === db.books ? undefined : c.max_limit,'],
      ["id === undefined ? ['filter', 'sort', 'fields', 'count', 'limit', 'cursor', ...include]", "id === undefined ? ['filter', 'sort', 'fields', 'count', ...(coll === db.books ? [] : ['limit']), 'cursor', ...include]"]], undefined, [], true],
  // 11.6: sin la extensión anunciada, inherit no se usa (como actions): sus comprobaciones ni se ejecutan ni se
  // listan como omitidas; ya lo señala discovery.inherit. none:id: esa comprobación no aparece en el informe.
  ['inherit declarado sin anunciar la extensión', ['none:inherit.read', 'none:inherit.roundtrip', 'none:inherit.own', 'none:inherit.stale'],
    [["const EXTENSIONS = TOKEN ? ['actions', 'inherit', 'oauth'] : ['actions', 'inherit'];", "const EXTENSIONS = TOKEN ? ['actions', 'oauth'] : ['actions'];"]]],
  ['exige Idempotency-Key e If-Match',['core.post', 'core.post.media-type', 'core.patch', 'core.patch.merge', 'core.delete', 'core.reserved.writes', 'writes.idempotency.replay', 'writes.if-match.stale'],
    [['    const scope = idempotencyScope(req, url.pathname);\n', "    const scope = idempotencyScope(req, url.pathname);\n    if (!scope && coll === db.books) throw new Problem(400, 'idempotency_key_required', 'Send Idempotency-Key.');\n"],
      ['  const ifMatch = req.headers[\'if-match\'];\n', "  const ifMatch = req.headers['if-match'];\n  if (ifMatch === undefined && coll === db.books) throw new Problem(428, 'precondition_required', 'Send If-Match.');\n"]], undefined, [], true],
];

function mutate(changes) {
  let src = SERVER;
  for (const [from, to] of changes) {
    if (src.split(from).length !== 2) throw new Error(`El texto no aparece exactamente una vez en el servidor:\n${from}`);
    src = src.replace(from, () => to);
  }
  return src;
}

// Puertos, uno por ejecución: RESTEP_CHECK_PORTS=8140-8159 para otro rango (8900-8949 por defecto).
const [PORT_FROM, PORT_TO] = (process.env.RESTEP_CHECK_PORTS ?? '8900-8949').split('-').map(Number);
let runs = 0;
async function run(src, mode, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'restep-check-'));
  const file = join(dir, 'server.mjs');
  writeFileSync(file, src);
  const p = PORT_FROM + (runs++ % (PORT_TO - PORT_FROM + 1));
  const env = { ...process.env, PORT: String(p), RESTEP_TOKEN: mode === OAUTH ? TOKEN : '' };
  const server = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, ko) => { server.stdout.once('data', ok); server.once('exit', () => ko(new Error('El servidor no arrancó'))); });
  try {
    const out = await new Promise((ok) => {
      const auth = mode === OAUTH ? ['--header', `Authorization: Bearer ${TOKEN}`] : [];
      const c = spawn(process.execPath, [CHECKER, `http://localhost:${p}/`, '--writes', '--json', ...auth, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '', err = '';
      c.stdout.on('data', (d) => { text += d; });
      c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (code) => ok({ code, text, err }));
    });
    if (out.code === 2) throw new Error(`El comprobador no pudo ejecutarse: ${out.err.split('\n').filter((l) => l.startsWith('restep-check:')).join(' ')}`);
    return { code: out.code, results: JSON.parse(out.text).results };
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const only = process.argv[2];
let failed = 0;
for (const mode of only ? [] : [undefined, OAUTH]) {
  const label = mode ? `referencia con ${mode}` : 'referencia';
  const baseline = await run(SERVER, mode);
  const bad = baseline.results.filter((r) => r.status === 'fail' || r.status === 'warn');
  const skipped = mode === OAUTH ? baseline.results.filter((r) => r.id.startsWith('oauth.') && r.status === 'skip') : [];
  if (baseline.code !== 0 || bad.length || skipped.length) {
    failed++;
    console.log(`FALLA  ${label}: ${[...bad, ...skipped].map((r) => `${r.id} (${r.message})`).join('; ')}`);
  } else console.log(`ok     ${label}: ${baseline.results.filter((r) => r.status === 'pass').length} comprobaciones pasan`);
}

for (const [name, id, changes, mode, want, args] of MUTATIONS.filter(([n]) => !only || n.includes(only))) {
  const { code, results } = await run(mutate(changes), mode, args);
  const hit = results.filter((r) => r.id === id && (r.status === 'fail' || r.status === 'warn'));
  const right = want ? hit.length && hit[0].status === want && (want === 'warn' || code === 1) : hit.length && (hit[0].status === 'warn' || code === 1);
  if (right) console.log(`ok     ${name} → ${id}${want ? ` (${want})` : ''}`);
  else {
    failed++;
    const mine = results.filter((r) => r.id === id).map((r) => `${r.status}${r.message ? `: ${r.message}` : ''}`);
    console.log(`FALLA  ${name}: ${id} no falla (${mine.join('; ') || 'no se ejecutó'})`);
  }
}
// Con estricto, además, nada falla ni avisa en toda la ejecución.
for (const [name, ids, changes, mode, args, strict] of VARIANTS.filter(([n]) => !only || n.includes(only))) {
  const { results } = await run(mutate(changes), mode, args);
  const wrong = results.filter((r) => (strict || ids.includes(r.id)) && (r.status === 'fail' || r.status === 'warn'));
  // skip:id: esa comprobación tiene que omitirse, sin pasar ni fallar en ningún sitio.
  // none:id: esa comprobación no aparece en el informe, ni siquiera omitida.
  const missing = ids.filter((id) => (id.startsWith('skip:')
    ? !results.some((r) => r.id === id.slice(5) && r.status === 'skip') || results.some((r) => r.id === id.slice(5) && r.status !== 'skip')
    : id.startsWith('none:') ? results.some((r) => r.id === id.slice(5))
      : !results.some((r) => r.id === id && r.status === 'pass')));
  if (!wrong.length && !missing.length) console.log(`ok     ${name}: ${ids.join(', ')} pasan`);
  else {
    failed++;
    console.log(`FALLA  ${name}: ${[...wrong.map((r) => `${r.id} ${r.status}: ${r.message}`), ...missing.map((id) => `${id} ${id.startsWith('none:') ? 'aparece' : 'no pasa'}`)].join('; ')}`);
  }
}
// --schema necesita ajv y ajv-formats, que el archivo suelto no trae. Sin ellos, un error que dice qué falta y la
// orden con npx; con ellos instalados en la carpeta desde la que se ejecuta, funciona sin copiar el comprobador.
if (!only || 'schema'.includes(only)) {
  const tmp = mkdtempSync(join(tmpdir(), 'restep-check-schema-'));
  const schemaMode = (cwd, checker, file = 'doc.json', extra = []) => new Promise((ok) => {
    const c = spawn(process.execPath, [checker, '--schema', 'discovery', file, ...extra], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => ok({ code, out, err }));
  });
  try {
    const tool = join(tmp, 'tool'), project = join(tmp, 'project');
    mkdirSync(join(tool, 'schema'), { recursive: true });
    writeFileSync(join(tool, 'restep-check.mjs'), readFileSync(CHECKER));
    writeFileSync(join(tool, 'schema/discovery.json'), readFileSync(inSite ? join(here, '../../public/1/schema/discovery.json') : join(here, '../schema/discovery.json')));
    const doc = JSON.stringify({ restep: '1.0-draft.6', profiles: ['core'], collections: {} });
    writeFileSync(join(tool, 'doc.json'), doc);
    const alone = await schemaMode(tool, join(tool, 'restep-check.mjs'));
    const said = alone.err;
    if (alone.code === 2 && /ajv-formats/.test(said) && said.includes('npx restep-check --schema discovery doc.json')) console.log('ok     --schema sin ajv: dice qué falta y da la orden con npx');
    else { failed++; console.log(`FALLA  --schema sin ajv: salida ${alone.code}, «${said.trim()}»`); }
    // Paquetes de mentira en la carpeta del proyecto: el comprobador los encuentra aunque esté en otra.
    for (const [pkg, main, src] of [['ajv', 'dist/2020.js', 'module.exports = class { compile() { return () => true; } };'], ['ajv-formats', 'index.js', 'module.exports = () => {};']]) {
      mkdirSync(dirname(join(project, 'node_modules', pkg, main)), { recursive: true });
      writeFileSync(join(project, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0', main }));
      writeFileSync(join(project, 'node_modules', pkg, main), src);
    }
    writeFileSync(join(project, 'doc.json'), doc);
    const found = await schemaMode(project, join(tool, 'restep-check.mjs'));
    if (found.code === 0 && /doc\.json/.test(found.out)) console.log('ok     --schema con ajv en la carpeta de trabajo, el comprobador en otra');
    else { failed++; console.log(`FALLA  --schema con ajv en la carpeta de trabajo: salida ${found.code}, ${found.err.trim() || found.out.trim()}`); }
    // Las reglas del texto que el esquema no expresa: el ajv de mentira lo da todo por válido, así que lo que
    // falle es de esas reglas, que el informe da aparte. Una librería: libros, autores y reseñas.
    const books = { path: '/books', filter: { id: { type: 'string', ops: ['eq', 'in'] }, title: { type: 'string', ops: ['eq'] } },
      sort: ['id', 'title'], relations: { author: { to: 'authors' }, reviews: { to: 'reviews', many: true } } };
    const base = { restep: '1.0-draft.6', profiles: ['core', 'query', 'relations'],
      collections: { books, authors: { path: '/authors' }, reviews: { path: '/books/{book_id}/reviews', parent: 'books' } } };
    const RULES = [
      ['filtro con nombre que se llama como un filtro', 'discovery.named-filters', { books: { ...books, named_filters: { title: { description: 'Por título.' } } } }],
      ['subcolección cuya ruta no empieza por la del padre', 'discovery.subcollections', { reviews: { path: '/reviews/{book_id}/items', parent: 'books' } }],
      ['orden a través de una relación a muchos', 'query.filter.lists', { books: { ...books, sort: ['id', 'reviews.rating'] } }],
      ['filtro a través de una relación a muchos', 'query.filter.lists', { books: { ...books, filter: { ...books.filter, 'reviews.rating': { type: 'integer', ops: ['ge'] } } } }],
      ['sync sin in en el filtro de id', 'discovery.sync-id', { authors: { path: '/authors', sync: {}, filter: { id: { type: 'string', ops: ['eq'] } } } }],
      ['mapa de idioma entero en sort', 'query.language.declared', { authors: { path: '/authors', language_maps: { bio: {} }, sort: ['bio'] } }],
    ];
    writeFileSync(join(project, 'ok.json'), JSON.stringify(base));
    const ok = await schemaMode(project, join(tool, 'restep-check.mjs'), 'ok.json');
    if (ok.code === 0 && /Schema \(discovery\.json\): valid/.test(ok.out) && /Rules of the text that the schema cannot express: 0 failed/.test(ok.out))
      console.log('ok     --schema discovery: un documento correcto pasa el esquema y las reglas, informados aparte');
    else { failed++; console.log(`FALLA  --schema discovery con un documento correcto: salida ${ok.code}, ${ok.err.trim() || ok.out.trim()}`); }
    for (const [label, id, change] of RULES) {
      writeFileSync(join(project, 'bad.json'), JSON.stringify({ ...base, collections: { ...base.collections, ...change } }));
      const text = await schemaMode(project, join(tool, 'restep-check.mjs'), 'bad.json');
      const json = await schemaMode(project, join(tool, 'restep-check.mjs'), 'bad.json', ['--json']);
      let r;
      try { r = JSON.parse(json.out).results[0]; } catch { r = null; }
      const hit = r?.rules?.find((x) => x.id === id && x.status === 'fail');
      if (text.code === 1 && json.code === 1 && r.valid === true && r.conforms === false && hit && text.out.includes(`FAIL ${id}`) && /Schema \(discovery\.json\): valid/.test(text.out))
        console.log(`ok     --schema discovery: ${label} → ${id}`);
      else { failed++; console.log(`FALLA  --schema discovery: ${label}: ${id} no falla (salida ${text.code}; ${(r?.rules ?? []).filter((x) => x.id === id).map((x) => `${x.status}: ${x.message}`).join('; ') || text.err.trim() || 'no se ejecutó'})`); }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// La lista de comprobaciones de las páginas tiene que estar al día con el código.
// Y lo generado a partir de otras fuentes: la tabla de las páginas y la especificación en Markdown.
const generated = !inSite ? [] : [[process.execPath, join(here, 'tabla.mjs')], ['python3', join(here, '../fuentes.py')], ['python3', join(here, '../spec-md.py')]];
for (const [cmd, script] of generated) {
  const p = spawn(cmd, [script, '--check'], { stdio: 'inherit', cwd: join(here, '../..') });
  if (await new Promise((ok) => p.on('exit', ok))) { failed++; console.log(`FALLA  desfasado: ejecuta ${script.split('/tools/')[1] ? 'tools/' + script.split('/tools/')[1] : script}`); }
}
console.log(failed ? `\n${failed} pruebas fallan` : '\nTodas las pruebas pasan');
process.exit(failed ? 1 : 0);
