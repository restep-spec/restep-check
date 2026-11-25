// Tests of restep-check: the reference server must pass in full, and each version with a bug
// planted on purpose (a mutation) must make the check that covers it fail.
//   node tools/restep-check/test.mjs            (from projects/restep)
//   node tools/restep-check/test.mjs cursor     (only the mutations whose name contains "cursor")
// The same test ships in github.com/restep-spec/restep-check (test/test.mjs, with the server beside it):
// there it looks for the server and the checker next to it and skips the site's generated files.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const inSite = existsSync(join(here, 'table.mjs'));
const SERVER = readFileSync(inSite ? join(here, '../../public/ref/restep-server.mjs') : join(here, 'restep-server.mjs'), 'utf8');
const CHECKER = inSite ? join(here, 'restep-check.mjs') : join(here, '../restep-check.mjs');
const OAUTH = 'oauth';
const TOKEN = 'restep-check-test';

// [name, check that must fail, [[server text, replacement], ...], mode, result, arguments]
// With a result ('fail' or 'warn'), the check must give exactly that. The arguments are added to the
// checker's (for example, --fixture).
// In OAUTH mode, the server starts with RESTEP_TOKEN (oauth extension) and the checker sends the token.
// Variant with a computed field (5.1): books' rating becomes readOnly in the item schema, and
// the server ignores its current value and gives read_only to any other. RATING_SCHEMA only declares it.
const RATING_SCHEMA = ['    const s = inherited(f, json(f, kind));\n',
  "    const s = { ...inherited(f, json(f, kind)), ...(kind === 'item' && c === db.books && f === 'rating' && { readOnly: true }) };\n"];
const RATING_RULE = ['  errors.push(...relationErrors(coll, patch, id, current), ...inheritErrors(coll, patch, current));',
  "  if (coll === db.books && 'rating' in patch) { if (same(patch.rating, current.rating)) delete patch.rating; else errors.push({ pointer: '/rating', code: 'read_only', detail: t('rating is computed.', 'rating se calcula.') }); }\n  errors.push(...relationErrors(coll, patch, id, current), ...inheritErrors(coll, patch, current));"];

// And the server sets it: a new item starts with rating 0.
const RATING_SET = ["const row = withMaps(coll, { ...body, id: 'id' in body ? body.id : newId(coll) });",
  "const row = withMaps(coll, { ...body, ...(coll === db.books && { rating: 0 }), id: 'id' in body ? body.id : newId(coll) });"];

// _etag on the items of a collection (7.2). ETAG_LIST is the line that sets it.
const ETAG_LIST = 'items: page.map((r) => ({ ...pick(expand(r, coll, include), fields), _etag: etag(r) })), next,';
// A collection that answers :changes (9): state on every page and a minimal :changes that answers 200.
// Since draft 6 what makes it binding is the collection's sync declaration (7.2, 10).
// Only on the collections that support GET: one without GET does not declare sync (4.3).
const CHANGES = [["...(c.deprecations && { deprecations: c.deprecations }), // 5.5", "...(c.deprecations && { deprecations: c.deprecations }), ...(c.methods.includes('GET') && { sync: {} }),"],
  ["...(count === 'true' && { total: items.length }),", "state: hash(JSON.stringify([...coll.rows.values()])),\n    ...(count === 'true' && { total: items.length }),"],
  ['  if (url.pathname === shop.path) return handleShop(req, res, params);\n',
    "  if (read && segments.length === 1 && name.endsWith(':changes') && Object.hasOwn(db, name.slice(0, -8))) {\n" +
    "    const c = db[name.slice(0, -8)];\n" +
    "    return send(res, 200, { since: params.get('since'), state: hash(JSON.stringify([...c.rows.values()])), has_more: false, created: [], updated: [], destroyed: [] }, { 'Cache-Control': 'no-store' }, method === 'HEAD');\n" +
    "  }\n  if (url.pathname === shop.path) return handleShop(req, res, params);\n"]];
// CORS (5.8): echoes the Origin, exposes Restep's headers, adds Origin to Vary on every response and
// answers preflights without Restep's rules.
const CORS_FN = [
  'const cors = (req, res) => {',
  '  const origin = req.headers.origin;',
  '  const writeHead = res.writeHead.bind(res);',
  '  res.writeHead = (status, headers = {}) => writeHead(status, { ...headers, Vary: headers.Vary ? `${headers.Vary}, Origin` : \'Origin\',',
  "    ...(origin && { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'ETag, Location, Link, Allow, Accept-Patch, Accept-Post, Retry-After, Deprecation, Sunset, Idempotent-Replayed, Preference-Applied, Accept-Query' }) });",
  "  if (req.method !== 'OPTIONS' || !origin) return false;",
  "  res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, If-Match, If-None-Match, Idempotency-Key, Prefer, Authorization, DPoP', 'Access-Control-Max-Age': '600' });",
  '  res.end();',
  '  return true;',
  '};',
  ''].join('\n');
const CORS = [['createServer((req, res) => handle(req, res).catch(', 'createServer((req, res) => cors(req, res) || handle(req, res).catch('],
  ['refresh();\nconst port = Number', `${CORS_FN}refresh();\nconst port = Number`]];
const CORS_CREDENTIALS = ["'Access-Control-Allow-Origin': origin,", "'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true',"];
// 4.3: authors declares a list of methods without GET, on the collection or on its items. The reference honours it:
// GET and HEAD give 405 with the Allow of what is declared.
const AUTHORS = "description: t('The authors of the books.', 'Los autores de los libros.'),\n    methods: ['GET', 'POST'], item_methods: ['GET', 'PATCH', 'DELETE'],";
const AUTHORS_POST_ONLY = [AUTHORS, AUTHORS.replace("methods: ['GET', 'POST'],", "methods: ['POST'],")];
// 4.3: and then it declares no filter, sort or count, which belong to listing it.
const AUTHORS_UNLISTED = ["    filter: { id: ['eq', 'in'], name: ['eq', 'in'], country: ['eq', 'in'] },\n    sort: ['id', 'name'],\n    max_limit: 50,\n    count: 'exact',\n", '    max_limit: 50,\n'];
const AUTHORS_ITEMS_NO_GET = [AUTHORS, AUTHORS.replace("item_methods: ['GET', 'PATCH', 'DELETE'],", "item_methods: ['PATCH', 'DELETE'],")];
// Council decisions of draft 7: drafts (upsert) that require If-Match (7.2); books with a writable datetime (3);
// the line of sendReplay that drops what only the current representation may carry (7.1).
const UPSERT_IF_MATCH = ["id_from: 'client', reusable_ids: true, upsert: true,", "id_from: 'client', reusable_ids: true, upsert: true, require_if_match: true,"];
const BOOKS_DATETIME = ["types: { id: 'string', title: 'string', price: 'decimal', rating: 'number', year: 'integer', category: 'enum',",
  "types: { id: 'string', published_at: 'datetime', title: 'string', price: 'decimal', rating: 'number', year: 'integer', category: 'enum',"];
const REPLAY_CURRENT = '  if (!gone && isObject(data) && id !== undefined && !isCurrent(coll, rows.get(id), data._etag)) {';
// Council decisions of draft 7, round 3: /files with a create schema (5.1) and its upload line; the number grammar
// without its rule against leading zeros (6.1); compare, a GET action, with an integer list param (11.1).
const FILES_CREATE = ['    ...(!c.upload && { create:', '    ...({ create:'];
const FILES_UPLOAD = "upload: { media_types: ['image/*'], max_size: 1048576, multipart: true },";
// Council decisions of draft 7, round 4: /files that admits application/* (a JSON body is a file) or */* without
// multipart (an outer multipart/form-data gives 415); the line that throws over the limit of a numeric operand (6.1).
const FILES_APPLICATION = [FILES_UPLOAD, "upload: { media_types: ['image/*', 'application/*'], max_size: 1048576, multipart: true },"];
const FILES_ANY = [FILES_UPLOAD, "upload: { media_types: ['*/*'], max_size: 1048576 },"];
const OVER_LIMIT = "throw bad(key, t(`A numeric operand takes at most ${MAX_DIGITS} digits written out in full.`, `Un operando numérico admite como mucho ${MAX_DIGITS} cifras escrito por completo.`));";
const NUMBER_LEADING_ZERO = ['const NUMBER = /^-?(0|[1-9]\\d*)(?:', 'const NUMBER = /^-?(\\d+)(?:'];
const COMPARE_TOP = ["params: { with: { type: 'string', required: true, description: t('The id of the other book.', 'El id del otro libro.') } },",
  "params: { with: { type: 'string', required: true, description: t('The id of the other book.', 'El id del otro libro.') }, top: { type: 'integer', list: true, description: 'x' } },"];
// A repeat of a POST with the same Idempotency-Key, as if the first were still in progress (7.1).
const IN_PROGRESS = "    if (live && live.print === print) return sendReplay(res, live.response, coll);";

const MUTATIONS = [
  ['next missing at the end', 'core.collection.shape',
    [[ETAG_LIST, 'items: page.map((r) => ({ ...pick(expand(r, coll, include), fields), _etag: etag(r) })), ...(next && { next }),']]],
  ['reserved parameter ignored', 'core.reserved.item',
    [['if (!allowed.includes(base)) throw unsupported(key);', 'if (!allowed.includes(base)) continue;']]],
  // 5.4: the server chooses between 404 and 400, but a different one each time for the same request.
  ['different error each time', 'core.error-order',
    [["  if (id !== undefined && !coll.rows.has(id)) throw missing(url);\n", "  if (id !== undefined && !coll.rows.has(id) && (globalThis.flip = !globalThis.flip)) throw missing(url);\n"]]],
  // A 404 with unsupported parameters turns into 400: no longer either of the two errors that apply.
  ['error that does not apply', 'core.error-order',
    [["  if (id !== undefined && !coll.rows.has(id)) throw missing(url);\n", "  if (id !== undefined && !coll.rows.has(id)) throw [...params.keys()].length ? new Problem(400, 'bad_request', 'x') : missing(url);\n"]]],
  // 5.4: the 422 for the content cannot come before the 412.
  ['422 before 412', 'writes.error-order',
    [["  const ifMatch = req.headers['if-match'];\n", "  if (patch && 'id' in patch && patch.id !== id) throw invalid([{ pointer: '/id', code: 'read_only', detail: 'id' }]);\n  const ifMatch = req.headers['if-match'];\n"]]],
  ['$ not reserved', 'core.reserved.dollar',
    [["const isReserved = (base) => RESERVED.includes(base) || base.startsWith('$');", 'const isReserved = (base) => RESERVED.includes(base);']]],
  ['404 with another code', 'core.not-found',
    [['code: p.code, detail: text(p.detail, lang),', "code: p.status === 404 ? 'missing' : p.code, detail: text(p.detail, lang),"]]],
  ['405 without Allow', 'passive.error.405',
    [["`Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') }", "`Admite ${methods.join(', ')}.`), {}, {}"]]],
  ['errors as application/json', 'passive.error.media-type',
    [["status >= 400 ? 'application/problem+json' : 'application/json'", "'application/json'"]]],
  ['different status in the body', 'passive.error.members',
    [["title: text(TITLES[p.status] ?? 'Error', lang), status: p.status,", "title: text(TITLES[p.status] ?? 'Error', lang), status: 400,"]]],
  ['errors without Cache-Control', 'cache.cache-control',
    [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language',", "{ Vary: 'Accept-Language',"]]],
  ['no profile header', 'passive.profile-link',
    [['res.writeHead(status, { Link: link,', 'res.writeHead(status, {']]],
  ['profiles listed in the header', 'passive.profile-link',
    [['const link = `<${PROFILE}>; rel="profile"`;', 'const link = `<${PROFILE}>; rel="profile", <${PROFILE}core>; rel="profile"`;']]],
  ['no service-doc', 'discovery.service-doc',
    [["Link: `${link}, ${DOCS}` };", '};']]],
  // The Link parser honours quotes: a rel inside another parameter does not count.
  ['service-doc only inside a title', 'discovery.service-doc',
    [['const DOCS = `<${SPEC}>; rel="service-doc"; hreflang="en"; title="Restep 1, the specification", <https://restep.wubytes.com/es/1/>; rel="service-doc"; hreflang="es"`;',
      'const DOCS = `<${SPEC}>; title="docs, rel=service-doc"; rel="help"`;']]],
  ['reason with an impossible code', 'discovery.reasons',
    [['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { sold_out: { code: 'http_409' } }, collections, singletons };"]]],
  ['undeclared reason', 'passive.error.reason',
    [["code: p.code, detail: text(p.detail, lang), ...extra,", "code: p.code, reason: 'sold_out', detail: text(p.detail, lang), ...extra,"]]],
  ['reason with another code', 'passive.error.reason',
    [['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { sold_out: { code: 'conflict' } }, collections, singletons };"],
      ["code: p.code, detail: text(p.detail, lang), ...extra,", "code: p.code, reason: 'sold_out', detail: text(p.detail, lang), ...extra,"]]],
  // sold_out is declared with the code of 404s: it fails only because the reason is a list.
  ['reason that is not a string', 'passive.error.reason',
    [['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { sold_out: { code: 'not_found' } }, collections, singletons };"],
      ["code: p.code, detail: text(p.detail, lang), ...extra,", "code: p.code, ...(p.status === 404 && { reason: ['sold_out'] }), detail: text(p.detail, lang), ...extra,"]]],
  ['root in error with an empty anchor', 'discovery.service-doc',
    [['  if (!name) { // Discovery document, at the API root\n', "  if (!name) { // Discovery document, at the API root\n    if (read) throw new Problem(404, 'not_found', t('No discovery.', 'Sin descubrimiento.'), {}, { Link: `${link}, <${SPEC}>; rel=\"service-doc\"; anchor` });\n"]]],
  ['service-doc with a malformed target', 'discovery.service-doc',
    [['const DOCS = `<${SPEC}>; rel="service-doc"; hreflang="en"; title="Restep 1, the specification", <https://restep.wubytes.com/es/1/>; rel="service-doc"; hreflang="es"`;',
      'const DOCS = `<http://[>; rel="service-doc"`;']]],
  ['service-doc with an invalid escape', 'discovery.service-doc',
    [['const DOCS = `<${SPEC}>; rel="service-doc"; hreflang="en"; title="Restep 1, the specification", <https://restep.wubytes.com/es/1/>; rel="service-doc"; hreflang="es"`;',
      'const DOCS = `<https://docs.example.test/%ZZ>; rel="service-doc"`;']]],
  ['1.1 with http_409 in a reason', 'discovery.reasons',
    [["const doc = { restep: RESTEP,", "const doc = { restep: '1.1',"],
      ['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { sold_out: { code: 'http_409' } }, collections, singletons };"]]],
  ['service-doc with an unclosed quote', 'discovery.service-doc',
    [['const DOCS = `<${SPEC}>; rel="service-doc"; hreflang="en"; title="Restep 1, the specification", <https://restep.wubytes.com/es/1/>; rel="service-doc"; hreflang="es"`;',
      'const DOCS = `<${SPEC}>; rel="service-doc`;']]],
  ['service-doc anchored in another API', 'discovery.service-doc',
    [['const DOCS = `<${SPEC}>; rel="service-doc"; hreflang="en"; title="Restep 1, the specification", <https://restep.wubytes.com/es/1/>; rel="service-doc"; hreflang="es"`;',
      'const DOCS = `<${SPEC}>; rel="service-doc"; anchor="https://other.example/api/"`;']]],
  // Without discovery, the root answers 404: the context of its Link is not the root except with anchor (RFC 8288, 3.2).
  ['root in error with service-doc without anchor', 'discovery.service-doc',
    [['  if (!name) { // Discovery document, at the API root\n', "  if (!name) { // Discovery document, at the API root\n    if (read) throw new Problem(404, 'not_found', t('No discovery.', 'Sin descubrimiento.'), {}, { Link: `${link}, ${DOCS}` });\n"]]],
  ['root in error with a malformed anchor', 'discovery.service-doc',
    [['  if (!name) { // Discovery document, at the API root\n', "  if (!name) { // Discovery document, at the API root\n    if (read) throw new Problem(404, 'not_found', t('No discovery.', 'Sin descubrimiento.'), {}, { Link: `${link}, <${SPEC}>; rel=\"service-doc\"; anchor=\"http://[\"` });\n"]]],
  ['limit silently clamped', 'query.limit.range',
    [['if (!/^\\d+$/.test(params.get(\'limit\') ?? \'1\') || !Number.isInteger(limit) || limit < 1 || limit > coll.max_limit)',
      "if (!/^\\d+$/.test(params.get('limit') ?? '1') || !Number.isInteger(limit) || limit < 1)"]]],
  ['unsigned cursor', 'query.cursor.tampered',
    [['if (parts.length === 2 && mac === sign(payload)) {', 'if (parts.length === 2) {']]],
  ['cursor not bound to the query', 'query.cursor.other-query',
    [['c.q !== print) throw', 'false) throw']]],
  // In the data only rating is ever absent (on book 50), and rating supports ge.
  ['ge returns absent values', 'query.filter.absent',
    [['      test = (x) => x != null && OPS[op](compare(type, x, v, collation));',
      "      test = (x) => (x == null && op === 'ge') || (x != null && OPS[op](compare(type, x, v, collation)));"]]],
  ['le as lt', 'query.filter.match',
    [['le: (c) => c <= 0,', 'le: (c) => c < 0,']]],
  ['absent values first when sorting', 'query.sort.order',
    [['return x == null ? 1 : -1; } // missing values last', 'return x == null ? -1 : 1; }']]],
  ['sort without tie-breaker', 'query.sort.stable',
    [["for (const s of [...sort, 'id']) {", 'for (const s of sort) {'],
      ['let items = applyFilters(coll, params);', 'let items = applyFilters(coll, params).sort(() => Math.random() - 0.5);']]],
  ['repeated filter accepted', 'query.filter.bad-value',
    [["if (seen.has(`${field}[${op}]`)) throw bad(key, SAME_FILTER);", ''],
      ["// only filter has bracketed forms\n    if (params.getAll(key).length > 1) throw once(key);", '// only filter has bracketed forms']]],
  ['range taken as repeated', 'query.filter.same-field',
    [["if (seen.has(`${field}[${op}]`)) throw bad(key, SAME_FILTER);\n    seen.add(`${field}[${op}]`);",
      "if (seen.has(field)) throw bad(key, SAME_FILTER);\n    seen.add(field);"]]],
  ['filter[f] and filter[f][eq] as different', 'query.filter.bad-value',
    [["if (seen.has(`${field}[${op}]`)) throw bad(key, SAME_FILTER);\n    seen.add(`${field}[${op}]`);",
      "if (seen.has(key)) throw bad(key, SAME_FILTER);\n    seen.add(key);"]]],
  // Named filters (6.1): featured (a switch) and search (string) on books.
  ['named filter that adds items', 'query.named-filter.narrows',
    [['items = items.filter((r) => named.apply(r, v));', "items = [...items, { id: 'restep-check-ghost', title: 'x' }];"]]],
  ['named filter ignored next to another', 'query.named-filter.and',
    [['items = items.filter((r) => named.apply(r, v));', 'if ([...params.keys()].length === 1) items = items.filter((r) => named.apply(r, v));']]],
  ['named filter with an operator', 'query.named-filter.operator',
    [["if (m[2] !== undefined) throw unsupported(key, t(`${field} is a named filter: it takes no operator.`, `${field} es un filtro con nombre: no lleva operador.`));", '']]],
  ['switch with a value accepted', 'query.named-filter.bad-value',
    [["if (!named.type && value !== '') throw bad(key, t(`${field} is a switch: it takes no value.`, `${field} es un interruptor: no lleva valor.`));", '']]],
  ['named filter without a value accepted', 'query.named-filter.bad-value',
    [["if (named.type && value === '') throw bad(key, t(`${field} needs a ${named.type} value.`, `${field} necesita un valor ${named.type}.`));", '']]],
  ['named filter named like a filter', 'discovery.named-filters',
    [["      featured: { description:", "      price: { description: t('x', 'x'), apply: () => true },\n      featured: { description:"]]],
  ['named filter without description', 'discovery.named-filters',
    [["[f, { ...(n.type && { type: n.type }), ...(n.default && { default: true }), description: text(n.description, lang) }]", "[f, { ...(n.type && { type: n.type }), ...(n.default && { default: true }) }]"]]],
  ['cursor bound to limit', 'query.cursor.page-params',
    [["const PAGE_ONLY = ['cursor', 'limit', 'fields', 'include', 'count'];", "const PAGE_ONLY = ['cursor', 'count'];"]]],
  ['fields returns too much', 'query.fields',
    [['const out = { id: row.id };', 'const out = { id: row.id, year: row.year };']]],
  ['undeclared count ignored', 'query.count',
    [["...(count === 'true' && { total: items.length }),", '']]],
  ['weak ETag', 'writes.etag.strong',
    [['const etag = (value) => `"${hash(', 'const etag = (value) => `W/"${hash(']]],
  ['If-None-Match ignored on GET', 'cache.if-none-match',
    [["    if (weakMatch(req.headers['if-none-match'], tag)) return send(res, 304, undefined, headers);\n    return send(res, 200, data, headers, method === 'HEAD');", "    return send(res, 200, data, headers, method === 'HEAD');"]]],
  ['If-Match ignored', 'writes.if-match.stale',
    [["if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))\n    throw", 'if (false)\n    throw']]],
  ['non-atomic If-Match', 'writes.if-match.race',
    [["  if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))\n    throw new Problem(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));",
      "  if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))\n    throw new Problem(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));\n  await new Promise((r) => setTimeout(r, 30));"]]],
  ['Idempotency-Key ignored', 'writes.idempotency.replay',
    [['const live = saved && saved.expires > Date.now() ? saved : null;', 'const live = null;']]],
  ['precondition before replaying', 'writes.idempotency.replay-precondition',
    [['    if (live && live.print === print) return sendReplay(', '    if (live && live.print === print && req.headers[\'if-none-match\'] === undefined) return sendReplay(']]],
  ['fingerprint of the literal text', 'writes.idempotency.json-equality',
    [['    const print = scope && fingerprint(params, sent);', '    const print = scope && hash(JSON.stringify([[...params], sent]));']]],
  ['malformed key accepted', 'writes.idempotency.malformed',
    [["  if (!m) throw new Problem(400, 'bad_request',", "  if (!m) return null;\n  if (false) throw new Problem(400, 'bad_request',"]]],
  ['key with parameters accepted', 'writes.idempotency.malformed',
    [["const m = raw.trim().match(/^\"((?:[\\x20\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\"\\\\])*)\"$/);", "const m = raw.trim().replace(/;.*$/, '').match(/^\"((?:[\\x20\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\"\\\\])*)\"$/);"]]],
  ['malformed key without entry', 'writes.idempotency.malformed',
    [["    { errors: [{ header: 'Idempotency-Key', code: 'format',", "    { errors: [{ pointer: '/', code: 'format',"]]],
  ['POST accepts id', 'core.post.id',
    [["  if (from === 'server') return [{ pointer: '/id', code: 'read_only'", "  if (false) return [{ pointer: '/id', code: 'read_only'"]]],
  ['PATCH stores the _ members', 'core.patch.underscore',
    [["  const out = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));", '  const out = v;'],
      ['if (!Object.hasOwn(coll.types, f)) { errors.push(', "if (!Object.hasOwn(coll.types, f) && !f.startsWith('_')) { errors.push("]]],
  ['null does not remove', 'core.patch.merge',
    [['if (v === null) delete out[k];', 'if (v === null) out[k] = out[k];']]],
  ['DELETE with 200', 'core.delete',
    [["    return send(res, 204, undefined, invalidation);\n  }", "    return send(res, 200, { deleted: true });\n  }"]]],
  ['resource without the trailing slash', 'oauth.metadata',
    [["const meta = { resource: `http://${req.headers.host}/`,", "const meta = { resource: `http://${req.headers.host}`,"]], OAUTH],
  ['metadata behind credentials', 'oauth.metadata',
    [["if (TOKEN && url.pathname === METADATA) {", "if (TOKEN && url.pathname === METADATA && req.headers.authorization === `Bearer ${TOKEN}`) {"]], OAUTH],
  ['metadata without public cache', 'oauth.metadata.recommended',
    [["'Cache-Control': 'public, max-age=3600' });", "'Cache-Control': 'no-store' });"]], OAUTH],
  ['root 401 without resource_metadata', 'oauth.challenge',
    [[', resource_metadata="http://${req.headers.host}${METADATA}"${sent}`;', '${sent}`;']], OAUTH],
  ['collection 401 pointing to the root', 'oauth.challenge.elsewhere',
    [["const challenge = req.url !== '/' ? `Bearer realm=\"restep\"${sent}`", "const challenge = false ? ''"]], OAUTH],
  ['issuer that is not an https URL', 'oauth.metadata',
    [["authorization_servers: ['https://auth.example.com'],", "authorization_servers: [''],"]], OAUTH],
  ['invalid_parameter without parameter', 'passive.error.parameter',
    [["const bad = (parameter, detail) => new Problem(400, 'invalid_parameter', detail, { parameter });", "const bad = (parameter, detail) => new Problem(400, 'invalid_parameter', detail, {});"]]],
  ['errors without detail', 'passive.error.detail',
    [['code: p.code, detail: text(p.detail, lang), ...extra,', 'code: p.code, ...extra,']]],
  ['empty description in discovery', 'discovery.describing',
    [['description: text(c.description, lang), methods: c.methods,', "description: '', methods: c.methods,"]]],
  ['collection that serves the GET it does not declare', 'core.methods.left-out',
    [['methods: c.methods, item_methods: c.item_methods,', "methods: c === db.authors ? ['POST'] : c.methods, item_methods: c.item_methods,"]]],
  ['HEAD served although methods does not declare GET', 'core.methods.left-out',
    [AUTHORS_POST_ONLY, ["const withHead = (methods) => (methods.includes('GET') ? [...methods, 'HEAD'] : methods);", "const withHead = (methods) => [...methods, 'HEAD'];"]]],
  ['item that serves the GET it does not declare', 'core.methods.left-out',
    [['methods: c.methods, item_methods: c.item_methods,', "methods: c.methods, item_methods: c === db.authors ? ['PATCH', 'DELETE'] : c.item_methods,"]]],
  ['collection with sync without in on the id filter', 'discovery.sync-id',
    [...CHANGES, ["filter: { id: ['eq', 'in'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],", "filter: { id: ['eq'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],"]]],
  ['declared methods that do not match Allow', 'core.methods.allow',
    [['description: text(c.description, lang), methods: c.methods,', "description: text(c.description, lang), methods: ['GET', 'POST', 'DELETE'],"]]],
  ['declared item_methods that do not match Allow', 'core.methods.allow',
    [['item_methods: c.item_methods,', "item_methods: ['GET', 'POST', 'PATCH', 'DELETE'],"]]],
  ['create schema requires what the server does not check', 'core.schema.create',
    [['for (const f of coll.required) if', 'for (const f of []) if']]],
  ['service status cached', 'core.status',
    [["res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' });", "res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'max-age=60' });"]]],
  ['service status that does not answer HEAD', 'core.status',
    [["res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' });", "res.writeHead(method === 'HEAD' ? 404 : 200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' });"]]],
  ['PATCH with an unknown field set to null', 'core.schema.update',
    [["!f.startsWith('_') && !Object.hasOwn(coll.types, f));\n  if (unknown.length) throw invalid(", "!f.startsWith('_') && !Object.hasOwn(coll.types, f));\n  if (false) throw invalid("]]],
  // Language (3, 5.6, 6.1): the API's texts follow Accept-Language, the data never does; language maps.
  ['406 to an Accept-Language it does not offer', 'core.language.fallback',
    [["  const method = req.method;\n", "  const method = req.method;\n  if (/qaa/i.test(req.headers['accept-language'] ?? '')) throw new Problem(406, 'not_acceptable', 'Only en and es.');\n"]]],
  ['400 to a malformed Accept-Language', 'core.language.fallback',
    [["  const method = req.method;\n", "  const method = req.method;\n  if (/q=abc/.test(req.headers['accept-language'] ?? '')) throw bad('Accept-Language', 'Malformed.');\n"]]],
  ['errors without Vary', 'core.language.vary',
    [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang,", "{ 'Cache-Control': 'no-store', 'Content-Language': lang,"]]],
  ['discovery without Vary in the default language', 'core.language.vary',
    [["'Cache-Control': 'public, max-age=300', Vary: 'Accept-Language',", "'Cache-Control': 'public, max-age=300', ...(lang !== 'en' && { Vary: 'Accept-Language' }),"]]],
  ['same discovery ETag in every language', 'core.language.vary',
    [['ETag: etag([lang, doc]),', 'ETag: etag(Object.keys(doc)),']]],
  ['item ETag depends on the language', 'core.language.data',
    [["      tag = fields || included.length ? etag(data) : etag(row);", "      tag = etag([data, req.headers['accept-language']]);"]]],
  ['map keys with the region in upper case', 'core.language.maps',
    [["'es-es': 'Goma de borrar', 'es-mx': 'Goma' },", "'es-es': 'Goma de borrar', 'es-MX': 'Goma' },"]]],
  ['upper-case tag lowered', 'core.language.format',
    [['  const errors = languageErrors(coll, patch, current);',
      '  for (const f of maps(coll)) if (isObject(patch[f])) patch[f] = Object.fromEntries(Object.entries(patch[f]).map(([k, v]) => [k.toLowerCase(), v]));\n  const errors = languageErrors(coll, patch, current);']]],
  ['keys removed without validation', 'core.language.format',
    [['      if (!wellFormed) errors.push(', '      if (!wellFormed && s !== null) errors.push(']]],
  ['emptied map treated as absent', 'core.language.merge',
    [['  const row = withMaps(coll, { ...mergePatch(current, patch), id });', '  const row = { ...mergePatch(current, patch), id };']]],
  ['map replaced whole in a PATCH', 'core.language.merge',
    [['  const row = withMaps(coll, { ...mergePatch(current, patch), id });',
      '  const row = withMaps(coll, { ...mergePatch(current, patch), ...Object.fromEntries(maps(coll).filter((f) => isObject(patch[f])).map((f) => [f, patch[f]])), id });']]],
  ['language map declared in filter', 'query.language.declared',
    [["'name.es-mx': ['eq', 'in'], 'name.en-gb': ['eq', 'in'] },", "'name.es-mx': ['eq', 'in'], 'name.en-gb': ['eq', 'in'], name: ['null'] },"]]],
  ['translation falling back to the language without region', 'query.language.exact',
    [["  return row[m]?.[rest];\n};", "  return row[m]?.[rest] ?? row[m]?.[rest.split('-')[0]];\n};"]]],
  ['languages not reserved', 'core.reserved.get',
    [["'cursor', 'since', 'languages'];", "'cursor', 'since'];"]]],
  ['fields with a path inside a map as unsupported', 'query.fields.unknown',
    [["      throw bad('fields', t(`${f.split('.')[0]} is a language map", "      throw unsupported('fields', t(`${f.split('.')[0]} is a language map"]]],
  ['language_maps with values that are not objects', 'discovery.language-maps',
    [['language_maps: Object.fromEntries(maps(c).map((f) => [f, {}]))', 'language_maps: Object.fromEntries(maps(c).map((f) => [f, true]))']]],
  // Inherited values (5.7): products and categories take tax_rate from their category, their parent or the default.
  ['inherit with an undeclared relation', 'discovery.inherit',
    [['{ own: i.own, from: i.from, default:', "{ own: i.own, from: [...i.from, 'shelf'], default:"]]],
  ['effective value not taken from the own one', 'inherit.read',
    [['if (row[coll.inherit[f].own] == null) why[f] =', 'why[f] ='],
      ['  if (row[rule.own] != null) return { value: row[rule.own], href:', '  if (false) return { value: row[rule.own], href:']]],
  ['href to the immediate parent', 'inherit.read',
    [['return to.inherit?.[f] ? source(to, target, f, seen) :', 'return to.inherit?.[f] ? { ...source(to, target, f, seen), href: `/${nameOf(to)}/${target.id}` } :']]],
  ['sending back what was read pins the inherited value', 'inherit.roundtrip',
    [['    delete body[f];\n  }\n  return errors;\n}\n// 5.1: the other read-only', '    if (current && same(body[f], now)) body[rule.own] = body[f];\n    delete body[f];\n  }\n  return errors;\n}\n// 5.1: the other read-only']]],
  ['another value in the effective field is ignored', 'inherit.read-only',
    [['    if (!same(body[f], now)) errors.push(', '    if (false) errors.push(']]],
  ['null in the own field does not inherit again', 'inherit.own',
    [['  errors.push(...relationErrors(coll, patch, id, current), ...inheritErrors(coll, patch, current));',
      '  errors.push(...relationErrors(coll, patch, id, current), ...inheritErrors(coll, patch, current));\n  for (const i of Object.values(coll.inherit ?? {})) if (patch[i.own] === null) delete patch[i.own];']]],
  ['POST with another value in the effective field', 'inherit.post',
    [['    if (!same(body[f], now)) errors.push(', '    if (current && !same(body[f], now)) errors.push(']]],
  ['whole _inherited with fields', 'inherit.fields',
    [['Object.entries(row._inherited).filter(([f]) => f in out) : [];', 'Object.entries(row._inherited) : [];']]],
  ['cycle accepted', 'inherit.cycle',
    [['    if (rel.to === nameOf(coll.base ?? coll) && id !== undefined && isObject(body[r])) {', '    if (false) {']]],
  ['children are not recomputed', 'inherit.source',
    [['  refresh(); // 11.6: effective values, after any write (a DELETE may have unlinked items)\n', ''],
      ['  coll.rows.set(id, row);\n  refresh();', '  coll.rows.set(id, row);\n  refresh(row);']]],
  ['stale effective value accepted', 'inherit.stale',
    [['now = current ? current[f] :', 'now = current ? body[f] :']]],
  // Read-only fields (5.1).
  ['another id without read_only entry', 'core.patch.id',
    [["throw invalid([{ pointer: '/id', code: 'read_only', detail: t('id cannot change.'", "throw invalid([{ pointer: '/id', code: 'range', detail: t('id cannot change.'"]]],
  ['the current id is rejected too', 'core.patch.roundtrip',
    [["if ('id' in patch && patch.id !== id) throw invalid(", "if ('id' in patch) throw invalid("]]],
  ['readOnly field that gets stored', 'core.patch.read-only', [RATING_SCHEMA, RATING_SET]],
  // _etag on the items of a collection (7.2): SHOULD without :changes, MUST with it.
  ['collection without _etag', 'writes.etag.collection', [[ETAG_LIST, 'items: page.map((r) => pick(expand(r, coll, include), fields)), next,']], undefined, 'warn'],
  ['collection with an _etag that is not the item\'s', 'writes.etag.collection', [[ETAG_LIST, 'items: page.map((r) => ({ ...pick(expand(r, coll, include), fields), _etag: etag([r]) })), next,']], undefined, 'warn'],
  ['collection with :changes without _etag', 'writes.etag.collection', [...CHANGES, [ETAG_LIST, 'items: page.map((r) => pick(expand(r, coll, include), fields)), next,']], undefined, 'fail'],
  ['collection with :changes and an _etag that is not the item\'s', 'writes.etag.collection',
    [...CHANGES, [ETAG_LIST, 'items: page.map((r) => ({ ...pick(expand(r, coll, include), fields), _etag: etag([r]) })), next,']], undefined, 'fail'],
  ['collection with :changes without _etag when fields is requested', 'writes.etag.collection',
    [...CHANGES, [ETAG_LIST, 'items: page.map((r) => ({ ...pick(expand(r, coll, include), fields), ...(!fields && { _etag: etag(r) }) })), next,']], undefined, 'fail'],
  // 409 request_in_progress (5.4, 7.1).
  ['request_in_progress without Retry-After', 'passive.error.request-in-progress',
    [[IN_PROGRESS, "    if (live && live.print === print) throw new Problem(409, 'request_in_progress', 'The first request is still running.');"]]],
  // CORS (5.8).
  ['CORS without exposing ETag', 'core.cors.expose', [...CORS, ["'Access-Control-Expose-Headers': 'ETag, Location,", "'Access-Control-Expose-Headers': 'Location,"]]],
  ['CORS without Vary: Origin', 'core.cors.vary', [...CORS, ["Vary: headers.Vary ? `${headers.Vary}, Origin` : 'Origin',", '']]],
  ['CORS without Access-Control-Allow-Origin on errors', 'core.cors.errors', [...CORS, ['...(origin && {', '...(origin && status < 400 && {']]],
  ['preflight without If-Match', 'core.cors.preflight', [...CORS, ['Content-Type, If-Match, If-None-Match', 'Content-Type, If-None-Match']]],
  ['preflight without PATCH', 'core.cors.preflight', [...CORS, ["'GET, POST, PATCH, DELETE'", "'GET, POST, DELETE'"]]],
  ['preflight with * and credentials', 'core.cors.preflight', [...CORS, CORS_CREDENTIALS,
    ["'Access-Control-Allow-Headers': 'Content-Type, If-Match, If-None-Match, Idempotency-Key, Prefer, Authorization, DPoP'", "'Access-Control-Allow-Headers': '*'"]]],
  ['CORS with * and credentials', 'core.cors.credentials',
    [...CORS, ["'Access-Control-Allow-Origin': origin,", "'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true',"]]],  // Draft 6.
  // Media types (3): 2xx with a body are application/json; a POST with another type, without one or with another charset gets 415.
  ['2xx that are not application/json', 'passive.json-type', [["const type = status >= 400 ? 'application/problem+json' : 'application/json';", "const type = status >= 400 ? 'application/problem+json' : 'text/json';"]]],
  ['POST without Content-Type accepted', 'core.post.media-type', [["  if (!mediaTypeOk(req.headers['content-type'], types))", "  if (req.headers['content-type'] !== undefined && !mediaTypeOk(req.headers['content-type'], types))"]]],
  ['POST with text/plain accepted', 'core.post.media-type', [["  if (!types.includes(type.trim().toLowerCase())) return false;", "  if (!types.includes(type.trim().toLowerCase()) && type.trim() !== 'text/plain') return false;"]]],
  ['charset=UTF-8 rejected', 'core.post.charset', [["    if (value.toLowerCase() !== 'utf-8') return false;", "    if (value !== 'utf-8') return false;"]]],
  ['PATCH with text/plain accepted', 'core.415', [["method === 'PATCH' ? await readJson(req, ['application/merge-patch+json', 'application/json']", "method === 'PATCH' ? await readJson(req, ['application/merge-patch+json', 'application/json', 'text/plain']"]]],
  ['415 without Accept-Patch', 'core.415.accept-patch', [["types.includes('application/merge-patch+json') ? { 'Accept-Patch': 'application/merge-patch+json' } : {});", '{});']], undefined, 'warn'],
  // Private responses (5.1).
  ['cacheable 401', 'passive.error.private', [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang, ...req.extra,", "{ 'Cache-Control': p.status === 401 ? 'public, max-age=60' : 'no-store', Vary: 'Accept-Language', 'Content-Language': lang, ...req.extra,"],
    ["if (TOKEN && cc && !cc.includes('no-store'))", "if (TOKEN && cc && !cc.includes('no-store') && status !== 401)"]], OAUTH],
  ['responses with a token without private', 'core.private', [["if (TOKEN && cc && !cc.includes('no-store'))", 'if (false)']], OAUTH],
  // Discovery (1.1, 3, 4.2, 5.1, 5.5, 5.9, 6.1, 11.6).
  ['restep without the suffix dot', 'discovery.version', [["const RESTEP = '1.0-draft.7';", "const RESTEP = '1.0-draft7';"]]],
  // 1.1 (C-02): the grammar is case-sensitive (RFC 7405); an uppercase suffix does not follow it.
  ['restep with an uppercase suffix', 'discovery.version', [["const RESTEP = '1.0-draft.7';", "const RESTEP = '1.0-DRAFT.7';"]]],
  ['different discovery on each read', 'discovery.same', [["const doc = { restep: RESTEP, version: '1',", "const doc = { restep: RESTEP, 'x-served': String(process.hrtime.bigint()), version: '1',"]]],
  ['reason with a name outside the grammar', 'discovery.names', [['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { 'Sold out': { code: 'conflict' } }, collections, singletons };"]]],
  ['custom member without x-', 'discovery.members', [["const doc = { restep: RESTEP, version: '1',", "const doc = { restep: RESTEP, opening_hours: '9-21', version: '1',"]]],
  ['id filter with lt', 'discovery.ops', [["filter: { id: ['eq', 'in'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],", "filter: { id: ['eq', 'in', 'lt'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],"]]],
  ['unknown id_from', 'discovery.id-from', [["    id_from: 'either',", "    id_from: 'mixed',"]]],
  ['collation on id', 'discovery.collations', [["    unique: ['name'],\n    collations: { name: 'server' },", "    unique: ['name'],\n    collations: { name: 'server', id: 'server' },"]]],
  ['subcollection without parent', 'discovery.subcollections', [['    const singletons = { shop:', "    collections.reviews = { path: '/books/{id}/reviews' };\n    const singletons = { shop:"]]],
  ['singleton with an item\'s path', 'discovery.singletons', [["  path: '/shop',", "  path: '/books/shop',"]]],
  ['notice without announced', 'discovery.deprecations', [["deprecations: [{ kind: 'sort', name: 'year', announced: '2026-11-20T00:00:00Z', sunset:", "deprecations: [{ kind: 'sort', name: 'year', sunset:"]]],
  ['announced that changes', 'evolution.announced', [["announced: '2026-11-20T00:00:00Z', sunset:", "get announced() { return new Date(Date.now() - Math.floor(Math.random() * 1e9)).toISOString(); }, sunset:"]]],
  ['retired action without Deprecation', 'evolution.deprecation-header', [['return notice ? { Deprecation: epoch(notice.announced), ', 'return notice ? { ']]],
  ['inherit without announcing the extension', 'discovery.inherit', [["const EXTENSIONS = TOKEN ? ['actions', 'inherit', 'oauth'] : ['actions', 'inherit'];", "const EXTENSIONS = TOKEN ? ['actions', 'oauth'] : ['actions'];"]]],
  // Paths and ids (3, 5.1).
  ['/books/07 is /books/7', 'core.not-found.id-form', [["segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);", "segments = url.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x).replace(/^0+(?=\\d)/, ''));"]]],
  ['filter with three brackets accepted', 'core.reserved.forms', [["const m = key.match(/^filter\\[([^\\]]+)\\](?:\\[([^\\]]+)\\])?$/);", "const m = key.match(/^filter\\[([^\\]]+)\\](?:\\[([^\\]]+)\\])?(?:\\[[^\\]]*\\])*$/);"]]],
  ['POST with id without read_only entry', 'core.post.id', [["  if (from === 'server') return [{ pointer: '/id', code: 'read_only'", "  if (from === 'server') return [{ pointer: '/id', code: 'type'"]]],
  ['client id ignored', 'core.client-id', [["const row = withMaps(coll, { ...body, id: 'id' in body ? body.id : newId(coll) });", 'const row = withMaps(coll, { ...body, id: newId(coll) });']]],
  ['required client id not enforced', 'core.client-id.required', [["    id_from: 'either',", "    id_from: 'client',"], ["  if (!('id' in body)) return from === 'client' ? [{", "  if (!('id' in body)) return false ? [{"]]],
  ['malformed id accepted', 'core.client-id.format', [["  if (!ID.test(body.id) || body.id === '.' || body.id === '..')", '  if (false)']]],
  ['id of a deleted item reused', 'core.client-id.taken', [['  if (self === undefined && coll.used.has(row.id))', '  if (self === undefined && coll.rows.has(row.id))']]],
  // Singleton (5.9).
  ['singleton that is not an object', 'core.singleton', [[': withEtag(shop.row);', ': [withEtag(shop.row)];']]],
  ['singleton with POST', 'core.singleton.methods', [["  if (!allow.split(', ').includes(method))", "  if (method === 'PUT')"]]],
  ['singleton that accepts include', 'core.singleton.params', [["    if (!read || base !== 'fields' || key !== base) throw unsupported(key);", "    if (!read || !['fields', 'include'].includes(base) || key !== base) throw unsupported(key);"]]],
  ['PATCH {} that changes the singleton', 'core.singleton.patch', [['  const row = mergePatch(current, patch);', '  const row = { ...mergePatch(current, patch), max_reservations: current.max_reservations + 1 };']]],
  // Relationships in a write (5.1).
  ['nonexistent relation without entry at its id', 'core.relation.unknown', [["errors.push({ pointer: `${where}/id`, code: 'unknown',", "errors.push({ pointer: where, code: 'unknown',"]]],
  ['relation that stores what it receives', 'core.relation.replace', [['  return linkOf(rel, v);\n}', '  return v;\n}']]],
  // query (5.2, 5.3, 6.1, 6.3, 6.5).
  ['literal + in the query', 'query.plus', [['  const params = url.searchParams;', "  const params = new URLSearchParams(url.search.replace(/\\+/g, '%2B'));"]]],
  ['cursor bound to the parameter order', 'query.reencode', [['  const q = [...params].filter(([k]) => !PAGE_ONLY.includes(k)).map(([k, v]) => [k, sameOperand(coll, k, v)]).sort();', '  const q = [...params].filter(([k]) => !PAGE_ONLY.includes(k)).map(([k, v]) => [k, sameOperand(coll, k, v)]);']]],
  ['in silently truncated', 'query.limits', [['      if (values.length > MAX_IN) throw bad(', '      if (values.length > MAX_IN) values.length = MAX_IN;\n      if (false) throw bad(']]],
  ['fields=id rejected', 'query.fields', [['  return fields;\n}', "  if (fields.length === 1 && fields[0] === 'id') throw bad('fields', 'id alone is not a list.');\n  return fields;\n}"]]],
  ['fields accepted on writes', 'query.fields.writes', [['  const allowed = !read ? [] :', "  const allowed = !read ? ['fields'] :"]]],
  ['path through a to-many relation in filter', 'query.filter.lists', [["{ to: rel.to, ...(rel.many && { many: true }),", "{ to: rel.to, ...((rel.many || c === db.products) && { many: true }),"],
    ["tax_rate_own: ['null'], 'name.es-mx'", "tax_rate_own: ['null'], 'category.id': ['eq'], 'name.es-mx'"]]],
  ['count=false without count declared', 'query.count.undeclared', [["    count: 'exact',\n    // 5.5: sorting by year", '    // 5.5: sorting by year'], ["  if (count !== null && !coll.count) throw unsupported('count');", "  if (count === 'true' && !coll.count) throw unsupported('count');"]]],
  // writes (7.1, 7.2).
  ['complete item without _etag', 'writes.etag.member', [['data = fields || included.length ? { ...pick(expand(row, coll, included), fields), _etag: etag(row) } : withEtag(row);', 'data = fields || included.length ? { ...pick(expand(row, coll, included), fields), _etag: etag(row) } : row;']]],
  ['PATCH without _etag in the response', 'writes.etag.write', [['prefer ? undefined : withEtag(row), { ETag: etag(row), ...invalidation, ...applied });', 'prefer ? undefined : row, { ETag: etag(row), ...invalidation, ...applied });']]],
  ['If-Match ignored on a POST', 'writes.if-match.post', [["    if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], collTag))", '    if (false)']]],
  ['412 to a just-deleted item', 'writes.if-match.deleted', [['  if (id !== undefined && !coll.rows.has(id)) throw missing(url);', "  if (id !== undefined && !coll.rows.has(id)) { if (req.headers['if-match'] && coll.used.has(id)) throw new Problem(412, 'precondition_failed', 'Gone.'); throw missing(url); }"]]],
  ['the query does not count for the key', 'writes.idempotency.mismatch', [['    const print = scope && fingerprint(params, sent);', '    const print = scope && hash(canonical([[], sent]));']]],
  // 7.1: the order of a parameter's repeated values counts; sorting the name=value pairs loses it.
  ['repeated values sorted in the key', 'writes.idempotency.mismatch', [['const fingerprint = (params, sent) => hash(canonical([idempotencyQuery(params), sent]));',
    'const fingerprint = (params, sent) => hash(canonical([[...params].map(([k, v]) => `${k}=${v}`).sort(), sent]));']]],
  // 5.1 and 4.3: a JSON body that is not an object gets 422 with an entry at ""; 5.4: after If-Match.
  ['PATCH [] gives 400', 'core.patch.not-object', [["  if (method === 'PATCH') objectBody(patch); // 5.1 and 5.4: after the preconditions",
    "  if (method === 'PATCH' && !isObject(patch)) throw new Problem(400, 'bad_request', 'Not an object.');"]]],
  ['POST [] gives 400', 'core.schema.create', [['    objectBody(body);\n    validate(coll, body, undefined,', "    if (!isObject(body)) throw new Problem(400, 'bad_request', 'Not an object.');\n    validate(coll, body, undefined,"]]],
  ['PATCH [] checked before If-Match', 'writes.error-order', [["  const [patch] = method === 'PATCH' ? await readJson(req, ['application/merge-patch+json', 'application/json']) : [null];",
    "  const [patch] = method === 'PATCH' ? await readJson(req, ['application/merge-patch+json', 'application/json']) : [null];\n  if (method === 'PATCH') objectBody(patch);"]]],
  ['two simultaneous POSTs with the same key', 'writes.idempotency.concurrent', [["    if (live) throw new Problem(422, 'idempotency_mismatch',", "    await new Promise((r) => setTimeout(r, 30));\n    if (live) throw new Problem(422, 'idempotency_mismatch',"]]],
  ['anonymous false not rejected', 'writes.idempotency.anonymous', [['idempotency: { ttl: TTL / 1000 },', 'idempotency: { ttl: TTL / 1000, anonymous: false },']]],
  // cache (8) and links (3).
  ['item without ETag', 'cache.etag', [["const headers = { ETag: tag, 'Cache-Control': 'no-cache', 'Cache-Groups': groups(paths), ...req.extra };", "const headers = { ...(id === undefined && { ETag: tag }), 'Cache-Control': 'no-cache', 'Cache-Groups': groups(paths), ...req.extra };"]]],
  ['singleton that ignores If-Match', 'core.singleton.patch', [["  if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], etag(current)))", '  if (false)']]],
  ['collation on an enum that is not a sort key', 'discovery.collations', [["    sort: ['id', 'title', 'price', 'rating', 'year', 'reviews.rating'],", "    sort: ['id', 'title', 'price', 'rating', 'year', 'reviews.rating'],\n    collations: { category: 'server' },"]]],
  // Subcollections (4.2, 5.1, 6.1): each book's reviews, at /books/{book_id}/reviews.
  ['subcollection under a parent that does not exist', 'core.subcollection.parent', [['  if (!top.rows.has(id)) return { gone: true, id: subId };\n', '']]],
  ['subcollection that outlives its parent', 'core.subcollection.delete', [['  if (!top.rows.has(id)) return { gone: true, id: subId };\n', ''],
    ['      db[sub].byParent.delete(id);\n', '']]],
  ['subcollection without declared parent', 'discovery.subcollections', [['      path: c.path ?? `/${n}`, ...(c.parent && { parent: c.parent }), description:', '      path: c.path ?? `/${n}`, description:']]],
  ['filter by the id of a subcollection item', 'query.filter.lists', [["      'author.id': ['eq', 'in'],", "      'author.id': ['eq', 'in'], 'highlight.id': ['eq'],"]]],
  // relations (9).
  ['relation to an undeclared collection', 'discovery.relations', [['{ to: rel.to, ...(rel.many && { many: true }),', "{ to: rel.to === 'authors' ? 'writers' : rel.to, ...(rel.many && { many: true }),"]]],
  ['relation to a subcollection without href', 'relations.objects', [["highlight: { id: '1', href: '/books/7/reviews/1' } },", "highlight: { id: '1' } },"]]],
  ['relation to several collections without type', 'relations.objects', [["showcase: { type: 'books', id: '7' }", "showcase: { id: '7' }"]]],
  ['href to another item', 'relations.href', [["highlight: { id: '1', href: '/books/7/reviews/1' } },", "highlight: { id: '1', href: '/books/7/reviews/2' } },"]]],
  ['include ignored', 'relations.include', [['  if (!here.length) return row;\n  const out = { ...row };', '  return row;\n  const out = { ...row };']]],
  ['include deeper than include_depth', 'relations.include.unsupported', [['    if (segs.length > (coll.include_depth ?? 1))', '    if (false)']]],
  ['include_depth not honoured', 'relations.include.depth', [['    if (segs.length > (coll.include_depth ?? 1))', '    if (segs.length > 1)']]],
  ['dotted fields without include', 'relations.fields', [['  if (!include.includes(`${prefix}${m}`)) throw bad(', '  if (false) throw bad(']]],
  ['author.name filter that does not look at the author', 'query.filter.match', [["return rest === 'id' ? row[m]?.id : lookup(rel.to, row[m])?.[rest];", "return rest === 'id' ? row[m]?.id : undefined;"]]],
  ['subcollection href not checked', 'core.relation.href', [['  if (to.parent && (typeof v.href !== \'string\' ||', '  if (false && (typeof v.href !== \'string\' ||'],
    ['  if (!to.parent) return to.rows.get(v.id);\n', '  if (!to.parent) return to.rows.get(v.id);\n  for (const m of to.byParent.values()) if (m.has(v.id)) return m.get(v.id);\n']]],
  // actions (11.1): restock and low_stock on products, inherit_tax on categories, find_or_create on authors.
  ['action with an unknown on', 'discovery.actions', [['[a, { ...(d.on && { on: d.on }), safe: d.safe,', "[a, { ...(d.on && { on: d.on === 'item' ? 'element' : d.on }), safe: d.safe,"]]],
  ['item action requested on the collection', 'actions.undeclared', [[" || decl.on !== (id === undefined ? 'collection' : 'item'))", ')']]],
  ['action with another method without 405', 'actions.method', [["  const allow = decl.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];\n  if (!allow.includes(req.method))\n    throw new Problem(405, 'method_not_allowed', t(`Supports ${allow.join(', ')}.`, `Admite ${allow.join(', ')}.`), {}, { Allow: allow.join(', ') });\n  for (const key of new Set(params.keys())) if (isReserved(reservedName(key))) throw unsupported(key); // 5.3\n  if (decl.method === 'GET') {", "  const allow = decl.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];\n  if (!allow.includes(req.method))\n    throw missing(url);\n  for (const key of new Set(params.keys())) if (isReserved(reservedName(key))) throw unsupported(key); // 5.3\n  if (decl.method === 'GET') {"]]],
  ['action with %3A not recognised', 'actions.colon', [["const last = segments.at(-1), colon = last.indexOf(':');", "const last = segments.at(-1), colon = url.pathname.split('/').at(-1).indexOf(':');"]]],
  ['GET action without HEAD', 'actions.get', [["action); // 5.5: an action retired whole, on every response to it\n  const allow = decl.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];", "action); // 5.5: an action retired whole, on every response to it\n  const allow = decl.method === 'GET' ? ['GET'] : ['POST'];"]]],
  ['_actions with another method', 'actions.listed', [["{ method: a.method ?? 'POST', href:", "{ method: 'GET', href:"]]],
  ['action with an empty body as non-JSON', 'actions.empty-body', [['    if (!Buffer.concat(raw).length) return [{}, {}];\n', '']]],
  ['action that answers 202', 'actions.response', [['row.stock = (row.stock ?? 0) + body.quantity; return [200, row];', 'row.stock = (row.stock ?? 0) + body.quantity; return [202, row];']]],
  ['idempotent action that rejects the key', 'actions.idempotency-key', [['  const scope = decl.idempotent ? null : idempotencyScope(req, url.pathname);',
    "  if (decl.idempotent && req.headers['idempotency-key']) throw new Problem(400, 'bad_request', 'No keys here.');\n  const scope = decl.idempotent ? null : idempotencyScope(req, url.pathname);"]]],
  ['next with a foreign scheme', 'passive.links', [['    next = `${path}?${q}`;', '    next = `ftp://localhost${path}?${q}`;']]],  // Draft 7. Data (3): no repeated names or noncharacters; T and Z in upper case.
  ['repeated member name', 'passive.i-json', [["  const body = data === undefined ? '' : JSON.stringify(data);", "  const body = data === undefined ? '' : JSON.stringify(data).replace(/^\\{\"id\":(\"[^\"]*\"),/, '{\"id\":$1,\"id\":$1,');"]]],
  ['noncharacter in a body', 'passive.i-json', [["  const body = data === undefined ? '' : JSON.stringify(data);", "  const body = data === undefined ? '' : JSON.stringify(data).replace(/^\\{\"id\":/, '{\"x\\\\ufffe\":1,\"id\":');"]]],
  ['lowercase t in an instant', 'core.item.dates', [["    filter: { id: ['eq', 'in'], frequency: ['eq', 'in'] },", "    filter: { id: ['eq', 'in'], frequency: ['eq', 'in'], subscribed_at: ['eq'] },"],
    ["{ id: '1', frequency: 'weekly', subscribed_at: '2026-10-01T08:00:00.000Z' }", "{ id: '1', frequency: 'weekly', subscribed_at: '2026-10-01t08:00:00.000Z' }"]]],
  // Errors (5.4): about:blank, reason, no-store, fields for shared caches (5.1).
  ['about:blank for invalid_parameter', 'passive.error.type', [["    type: `${PROFILE}errors#${p.code}`,", "    type: p.code === 'invalid_parameter' ? 'about:blank' : `${PROFILE}errors#${p.code}`,"]]],
  ['about:blank with errors', 'passive.error.type', [["    type: `${PROFILE}errors#${p.code}`,", "    type: p.code === 'invalid' ? 'about:blank' : `${PROFILE}errors#${p.code}`,"]]],
  ['type of another code', 'passive.error.type-code', [["    type: `${PROFILE}errors#${p.code}`,", "    type: `${PROFILE}errors#${p.code === 'not_found' ? 'invalid' : p.code}`,"]], undefined, 'warn'],
  ['reason outside the grammar of names', 'passive.error.reason', [["code: p.code, detail: text(p.detail, lang), ...extra,", "code: p.code, ...(p.status === 404 && { reason: 'sold out' }), detail: text(p.detail, lang), ...extra,"]]],
  ['reason in camelCase', 'passive.error.reason-case', [["code: p.code, detail: text(p.detail, lang), ...extra,", "code: p.code, ...(p.status === 404 && { reason: 'soldOut' }), detail: text(p.detail, lang), ...extra,"]], undefined, 'warn'],
  ['declared reason in camelCase', 'discovery.reasons-case', [['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { soldOut: { code: 'conflict' } }, collections, singletons };"]], undefined, 'warn'],
  ['428 without no-store', 'passive.error.no-store', [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang,", "{ 'Cache-Control': p.status === 428 ? 'private' : 'no-store', Vary: 'Accept-Language', 'Content-Language': lang,"]]],
  ['no-store with CDN-Cache-Control', 'passive.shared-cache', [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang,", "{ 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'max-age=60', Vary: 'Accept-Language', 'Content-Language': lang,"]]],
  // Links (3, 5.2, 11.1): brackets encoded; an action's colon, as is.
  ['next with unencoded brackets', 'passive.links', [['    next = `${path}?${q}`;', "    next = `${path}?${q.toString().replace(/%5B/g, '[').replace(/%5D/g, ']')}`;"]]],
  ['action href with %3A', 'passive.links', [["_actions: { verify_email: { method: 'POST', href: '/me:verify_email' } } }", "_actions: { verify_email: { method: 'POST', href: '/me%3Averify_email' } } }"]]],
  // Discovery (4.2, 4.3, 5.9, 11.1).
  ['shared_cache in discovery', 'discovery.members', [['status: STATUS, reasons: {}, collections, singletons };', 'status: STATUS, reasons: {}, shared_cache: {}, collections, singletons };']]],
  ['unknown member in a filter', 'discovery.members', [["        ...(c.notes?.[f] && { description: text(c.notes[f], lang) }) }])) }),", "        ...(c.notes?.[f] && { description: text(c.notes[f], lang) }), ...(f === 'id' && { indexed: true }) }])) }),"]]],
  ['collection without GET that declares sort', 'discovery.no-get', [["    method_effects: { POST: ['charges'] },\n    types: { id: 'string', order: 'relation', amount: 'decimal' },", "    method_effects: { POST: ['charges'] }, sort: ['id'],\n    types: { id: 'string', order: 'relation', amount: 'decimal' },"]]],
  ['unknown effect', 'discovery.effects', [["    method_effects: { POST: ['charges'] },\n    types: { id: 'string', order: 'relation', amount: 'decimal' },", "    method_effects: { POST: ['charges', 'emails'] },\n    types: { id: 'string', order: 'relation', amount: 'decimal' },"]]],
  ['safe action with external', 'discovery.effects', [["      low_stock: { on: 'collection', method: 'GET', safe: true, idempotent: true, effects: [],", "      low_stock: { on: 'collection', method: 'GET', safe: true, idempotent: true, effects: ['external'],"]]],
  ['localized fields without default_language', 'discovery.localized', [["    const doc = { restep: RESTEP, version: '1', default_language: LANGUAGES[0],", "    const doc = { restep: RESTEP, version: '1',"]]],
  ['reusable_ids with id_from either', 'discovery.id-from', [["    id_from: 'either',\n", "    id_from: 'either', reusable_ids: true,\n"]]],
  ['subcollection variable with a hyphen', 'discovery.subcollections', [["      path: c.path ?? `/${n}`,", "      path: (c.path ?? `/${n}`).replace('{book_id}', '{book-id}'),"]]],
  ['singleton template without parent', 'discovery.singletons', [['settings: { path: settings.path, parent: settings.parent, methods:', 'settings: { path: settings.path, methods:']]],
  ['prefix on an integer filter', 'discovery.ops', [["      year: ['eq', 'lt', 'le', 'gt', 'ge'], rating: ['ge', 'null'],", "      year: ['eq', 'lt', 'le', 'gt', 'ge', 'prefix'], rating: ['ge', 'null'],"]]],
  ['action new that is a POST', 'discovery.actions', [["      new: { on: 'collection', method: 'GET', safe: true,", "      new: { on: 'collection', safe: true,"]]],
  ['unknown type of a parameter', 'discovery.types', [["        params: { with: { type: 'string', required: true,", "        params: { with: { type: 'isbn', required: true,"]]],
  // core (5.1, 5.9).
  ['trailing segment not decoded', 'core.not-found.id-form', [['segments = url.pathname.split(\'/\').filter(Boolean).map(decodeURIComponent);', "segments = url.pathname.split('/').filter(Boolean).map((x) => (/%3[0-9]/.test(x) ? x : decodeURIComponent(x)));"]]],
  ['settings under a reader that does not exist', 'core.singleton', [['  if (!db.readers.rows.has(id)) return { missing: true };\n', '']]],
  ['PUT on a collection', 'core.put', [["  const method = req.method;\n", "  const method = req.method;\n  if (method === 'PUT' && url.pathname === '/books') return send(res, 200, { items: [], next: null });\n"]]],
  ['default not applied', 'core.schema.default', [['  for (const [f, v] of Object.entries(coll.defaults ?? {})) if (row[f] === undefined) row[f] = v;\n', '']]],
  ['empty merge patch taken as {}', 'core.415', [['  try { v = JSON.parse(text); } catch {', "  try { v = JSON.parse(text || '{}'); } catch {"]]],
  ['undeclared media type uploaded', 'core.upload', [['  if (multipart ? !upload.multipart : !upload.media_types.some((m) => mediaMatch(m, type))) throw refuse();', '  if (multipart && !upload.multipart) throw refuse();']]],
  ['upload without max_size', 'core.upload', [['  if (size > upload.max_size)\n    throw new Problem(413', '  if (false)\n    throw new Problem(413']]],
  ['upload without _content', 'core.upload', [['  const row = { id, name: file.name, _content: { href: `${href}/content`, media_type: file.mediaType, size: file.bytes.length } };', '  const row = { id, name: file.name };']]],
  ['deleted key taken for good', 'core.client-id.reuse', [['    if (coll.reusable_ids) coll.used.delete(id); // 5.1: its id is free again', '    if (false) coll.used.delete(id);']]],
  ['upsert answered with 404', 'core.upsert', [['  if (id !== undefined && method === \'PATCH\' && coll.upsert && !coll.rows.has(id) && isFree(coll, id))', '  if (false)']]],
  // Language (3, 5.6, 7.2): localized fields.
  ['data that follows the language', 'core.language.data', [["    if (coll.localized[f]) out[f] = localizedText(row[coll.localized[f].source], lang);", "    if (coll.localized[f]) { out[f] = localizedText(row[coll.localized[f].source], lang); out.lang_note = lang; }"]]],
  ['localized without Content-Language', 'core.language.localized', [["const languageHeaders = (coll, lang) => (coll.localized ? { Vary: 'Accept-Language', 'Content-Language': lang } : {});", "const languageHeaders = (coll, lang) => (coll.localized ? { Vary: 'Accept-Language' } : {});"]]],
  ['localized text in another language rejected', 'core.language.localized-write', [['    const now = loc ? LANGUAGES.map((l) => localizedText((current ?? body)[loc.source], l)) : [current?.[f]];', "    const now = loc ? [localizedText((current ?? body)[loc.source], 'en')] : [current?.[f]];"]]],
  ['If-Match bound to the language', 'writes.if-match.language', [['  return LANGUAGES.some((l) => strongMatch(header, etag(present(coll, row, l)))) ? etag(row) : header;', '  return header;']]],
  // query (6.1, 6.4).
  ['prefix as its opposite', 'query.filter.prefix', [["      test = (x) => x != null && (op === 'prefix' ? norm(x).startsWith(norm(value)) : norm(x).includes(norm(value)));", "      test = (x) => x != null && (op === 'prefix' ? !norm(x).startsWith(norm(value)) : norm(x).includes(norm(value)));"]]],
  ['contains as prefix', 'query.filter.contains', [["      test = (x) => x != null && (op === 'prefix' ? norm(x).startsWith(norm(value)) : norm(x).includes(norm(value)));", "      test = (x) => x != null && norm(x).startsWith(norm(value));"]]],
  ['empty prefix accepted', 'query.filter.prefix', [["      if (value === '') throw bad(key, t(`${op} needs a non-empty operand.`, `${op} necesita un operando no vacío.`));", '']]],
  ['nin that reads only its first value', 'query.filter.nin', [['      test = (x) => x != null && parsed.some((v) => compare(type, x, v, collation) === 0) === (op === \'in\');', "      test = (x) => x != null && (op === 'in' ? parsed : parsed.slice(0, 1)).some((v) => compare(type, x, v, collation) === 0) === (op === 'in');"]]],
  ['group filters on different reviews', 'query.filter.some', [['    const some = (r) => coll.some[g](r).some((el) => tests.every((x) => x(el)));', '    const some = (r) => tests.every((x) => coll.some[g](r).some((el) => x(el)));']]],
  ['null on the group does not negate it', 'query.filter.none', [['    items = items.filter((r) => (none === true ? !some(r) : some(r)));', '    items = items.filter((r) => (none === true && !tests.length ? !some(r) : some(r)));']]],
  ['default filter not applied', 'query.named-filter.default', [['    if (named.default && !seen.has(name)) items = items.filter((r) => named.apply(r));', '    if (false) items = items.filter((r) => named.apply(r));']]],
  ['false on a switch without default', 'query.named-filter.bad-value', [["      if (named.default && value === 'false') continue;", "      if (value === 'false') continue;"]]],
  ['required filter not enforced', 'query.filter.required', [["        ...(c.notes?.[f] && { description: text(c.notes[f], lang) }) }])) }),", "        ...(c.notes?.[f] && { description: text(c.notes[f], lang) }), ...(c === db.authors && f === 'country' && { required: true }) }])) }),"]]],
  // Actions (11.1).
  ['undeclared parameter of a GET action accepted', 'actions.params', [["    if (!p) throw unsupported(key, t(`The ${key} parameter is not declared for this action.`, `El parámetro ${key} no está declarado para esta acción.`));", '    if (!p) continue;']]],
  ['output with _etag', 'actions.output', [['          return [200, { fields }];', '          return [200, { fields, _etag: \'"x"\' }];']]],
  ['new that widens create', 'actions.new', [['          const schema = { ...create, properties: { ...create.properties, quantity:', '          const schema = { ...create, properties: { ...create.properties, gift_wrap: { type: \'boolean\' }, quantity:']]],
  ['action 200 without Content-Location', 'actions.content-location', [["{ ETag: etag(made), ...(status === 201 ? { Location: changed } : { 'Content-Location': changed }),", "{ ETag: etag(made), ...(status === 201 ? { Location: changed } : {}),"]]],
  ['action of a singleton with another method without 405', 'actions.method', [["  if (!decl) throw missing(url);\n  const allow = decl.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];\n  if (!allow.includes(req.method))\n    throw new Problem(405,", "  if (!decl) throw missing(url);\n  const allow = decl.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];\n  if (!allow.includes(req.method))\n    throw missing(url);\n  if (false) throw new Problem(405,"]]],
  ['deprecated action with another instant', 'evolution.deprecation-header', [['return notice ? { Deprecation: epoch(notice.announced), ', 'return notice ? { Deprecation: epoch(\'2026-01-01T00:00:00Z\'), ']]],
  ['part of a resource with Deprecation', 'evolution.deprecation-header', [["  const method = req.method;\n", "  const method = req.method;\n  if (/sort=year/.test(req.url)) req.extra = { Deprecation: '@1795996800' };\n"]]],
  // inherit (11.6).
  ['inherited item that takes a PATCH', 'inherit.items', [['  if (current._from) throw new Problem(409,', '  if (false) throw new Problem(409,']]],
  ['switch of inherited items ignored', 'inherit.switch', [["  if (!parent || seen.has(parentId) || (parent[decl.switch.field] ?? decl.switch.initial) === false) return out;", '  if (!parent || seen.has(parentId)) return out;']]],
  ['combined member that ignores its own value', 'inherit.read', [['  if (row[rule.own]?.[m] != null) return { value: row[rule.own][m], href:', '  if (false) return { value: row[rule.own][m], href:']]],
  // Council decisions of draft 7 (round 1).
  // 2 (5.1): a JSON body to a collection that only takes files is a media type it does not declare.
  ['JSON body to an upload-only collection', 'core.upload',
    [['    const file = coll.upload ? await readUpload(req, coll.upload) : null; // 5.1: a file, never JSON',
      "    const file = coll.upload && !mediaTypeOk(req.headers['content-type'], ['application/json']) ? await readUpload(req, coll.upload) : null;"]]],
  ['415 of an upload without Accept-Post', 'core.upload.accept-post', [["`Envía un fichero de tipo ${upload.media_types.join(', ')}.`), {}, { 'Accept-Post': accepted });",
    "`Envía un fichero de tipo ${upload.media_types.join(', ')}.`), {}, {});"]], undefined, 'warn'],
  // 3 (6.1): 20.0 is a valid operand of an integer field, the same filter as 20, also for the cursor; 20.5 is not.
  ['integer operand 20.0 rejected', 'query.filter.integer', [["  if (type === 'integer' && wholeNumber(raw)) return exact ? canonicalNumber(raw) : Number(raw);", "  if (type === 'integer' && /^-?\\d+$/.test(raw)) return exact ? canonicalNumber(raw) : Number(raw);"]]],
  ['integer operand 20.5 accepted', 'query.filter.integer', [['  return !/[1-9]/.test(digits.slice(Math.max(point, 0)));', '  return true;']]],
  ['cursor bound to how an operand is written', 'query.filter.integer', [["  return value.split(',').map((v) => (NUMBER.test(v) ? canonicalNumber(v) : v)).join(',');", '  return value;']]],
  // 6 (5.3, 11.1): a GET action without params takes no query parameters.
  ['GET action without params ignores a parameter', 'actions.params', [['    const p = decl.params && Object.hasOwn(decl.params, key) ? decl.params[key] : null;\n',
    '    if (!decl.params) continue;\n    const p = decl.params && Object.hasOwn(decl.params, key) ? decl.params[key] : null;\n']]],
  // 7 (7.2): where upsert requires If-Match, If-None-Match: * meets the requirement.
  ['upsert with If-Match required refuses If-None-Match: *', 'core.upsert.if-match', [UPSERT_IF_MATCH,
    ["  if (coll.require_if_match && !anyTag(req.headers['if-none-match']))\n", '  if (coll.require_if_match)\n']]],
  // 8 (5.9): a singleton's method_effects has PATCH as its only key.
  ['singleton method_effects with POST', 'discovery.effects', [['  method_effects: { PATCH: [] }, // 4.3 and 5.9', '  method_effects: { PATCH: [], POST: [] }, // 4.3 and 5.9']]],
  // 1 (6.1): null on a to-many relationship itself is declared with the type of the related ids, string.
  ['null on reviews declared as integer', 'query.filter.lists', [["filter_types: { 'reviews.rating': 'integer', 'reviews.reader.id': 'string', reviews: 'string' },",
    "filter_types: { 'reviews.rating': 'integer', 'reviews.reader.id': 'string', reviews: 'integer' },"]]],
  // 11 (3, 5.4): the entry for an unpaired surrogate points at its string; a JSON syntax error wins with 400.
  ['unpaired surrogate at another pointer', 'core.i-json.body', [["  if (typeof v === 'string') return ODD.test(v) ? [at] : [];", "  if (typeof v === 'string') return ODD.test(v) ? ['/elsewhere'] : [];"]]],
  ['unpaired surrogate before the syntax error', 'core.i-json.body', [['  try { v = JSON.parse(text); } catch {',
    "  if (/\\\\ud800/i.test(text)) throw invalid([{ pointer: '', code: 'format', detail: 'x' }]);\n  try { v = JSON.parse(text); } catch {"]]],
  // 4 (3): a leap second in a request body gives 422 with a format entry (books get a writable datetime).
  ['leap second accepted in a body', 'core.leap-second', [BOOKS_DATETIME, ["    if (ok && type === 'datetime' && v.slice(17, 19) === '60') {", '    if (false) {']]],
  // 12 (7.1, 7.2): a replay whose body is no longer the item's current representation carries no
  // Content-Location, ETag or _etag.
  ['replay with the stored ETag', 'writes.idempotency.replay-current', [[REPLAY_CURRENT, '  if (false) {']]],
  ['action replay with the stored ETag', 'actions.replay', [[REPLAY_CURRENT, REPLAY_CURRENT.replace('if (!gone && ', 'if (!gone && status !== 200 && ')]]],
  // Council decisions of draft 7 (round 3).
  // 1 (5.1): /files declares a create schema, so it creates items from JSON, but still refuses a JSON body.
  ['upload collection with create that refuses JSON', 'core.upload.create', [FILES_CREATE]],
  // 2 (5.1): in a collection with upload and create, a POST with application/json is an item, never a file.
  ['JSON body stored as a file where the collection creates from JSON', 'core.upload.create', [FILES_CREATE,
    [FILES_UPLOAD, "upload: { media_types: ['image/*', 'application/json'], max_size: 1048576, multipart: true },"]]],
  // 2 (5.1): and where its media_types admit application/json, also by a wildcard, it declares multipart true.
  ['upload with create that admits JSON without multipart', 'discovery.upload', [FILES_CREATE,
    [FILES_UPLOAD, "upload: { media_types: ['image/*', 'application/*'], max_size: 1048576 },"]]],
  // 5 (7.3): the replay of a 201 without a body carries no ETag, even while the item exists.
  ['replay of a minimal 201 with its ETag', 'writes.minimal.replay', [["  if (!gone && !(status === 201 && data === undefined)) return send(", '  if (!gone) return send(']]],
  // 6 (7.2): If-None-Match with a list of entity tags does not meet a required If-Match (books require it here).
  ['If-None-Match list instead of a required If-Match', 'writes.if-none-match.required',
    [["  const ifMatch = req.headers['if-match'];\n", "  const ifMatch = req.headers['if-match'];\n  if (ifMatch === undefined && req.headers['if-none-match'] === undefined && coll === db.books) throw new Problem(428, 'precondition_required', 'Send If-Match.');\n"]]],
  // 7 (6.1, 11.1): operands follow the number grammar of RFC 8259: 020 is not one, in a filter or a GET action param.
  ['leading zero in an integer operand', 'query.filter.number', [NUMBER_LEADING_ZERO]],
  ['leading zero in a list param of a GET action', 'actions.params', [COMPARE_TOP, NUMBER_LEADING_ZERO]],
  // 9 (6.1): null with the group's filters tests the whole group: false keeps the books where a review matches them.
  ['null=false on the group means any related item', 'query.filter.none', [['    items = items.filter((r) => (none === true ? !some(r) : some(r)));',
    '    items = items.filter((r) => (none === true ? !some(r) : none === false ? coll.some[g](r).length > 0 : some(r)));']]],
  // 10 (3): an unpaired surrogate in a member name has its format entry at "".
  ['unpaired surrogate in a member name at its pointer', 'core.i-json.body', [["[...(ODD.test(k) ? [''] : []),", '[...(ODD.test(k) ? [at + ptr(k)] : []),']]],
  // Council decisions of draft 7 (round 4).
  // 1a (5.1): in a collection that only takes files, application/* (or */*) admits a JSON body as a file.
  ['JSON body refused where application/* admits it', 'core.upload.json-file', [FILES_APPLICATION,
    ['  if (multipart ? !upload.multipart : !upload.media_types.some((m) => mediaMatch(m, type))) throw refuse();',
      "  if (multipart ? !upload.multipart : type === 'application/json' || !upload.media_types.some((m) => mediaMatch(m, type))) throw refuse();"]]],
  ['*/* that does not admit a JSON body', 'core.upload.json-file', [FILES_ANY, ["range === type || range === '*/*' || (range", 'range === type || (range']]],
  // 2 (5.1): an outer multipart/form-data without multipart true gives 415, even when media_types matches it.
  ['multipart body taken as raw bytes without multipart true', 'core.upload.multipart-off', [FILES_ANY,
    ["  const multipart = type === 'multipart/form-data';", "  const multipart = type === 'multipart/form-data' && upload.multipart;"]]],
  // 4b (5.1): the server does not require filename on the file part.
  ['file part without filename refused', 'core.upload.no-filename', [['    if (!/^form-data\\s*;/i.test(disposition) ||', '    if (!/filename/i.test(disposition) || !/^form-data\\s*;/i.test(disposition) ||']]],
  // 5a (6.1): two null filters on the same to-many relationship give invalid_parameter, even when they agree.
  ['two null filters on reviews accepted', 'query.filter.null-once', [["      if (op === 'null' && groups.get(group).nulls++)\n", '      if (false)\n']]],
  // 5b (6.1): null=true with other filters of the group: no related item matches all of them at once.
  ['null with the group negates each filter alone', 'query.filter.none', [['    items = items.filter((r) => (none === true ? !some(r) : some(r)));',
    '    items = items.filter((r) => (none === true ? !coll.some[g](r).some((el) => tests.some((x) => x(el))) : some(r)));']]],
  // 6 (6.1): a numeric operand is compared exactly; over a limit, invalid_parameter with the limit in detail.
  ['numeric operand through floating point', 'query.filter.number-exact',
    [["typeof a === 'number' && typeof b === 'number' ? a - b : cmpDecimal(exactNumber(a), exactNumber(b));", 'Number(a) - Number(b);']]],
  ['numeric operand over the limit without the limit in detail', 'query.filter.limit-detail', [[OVER_LIMIT, "throw bad(key, t('Too long.', 'Demasiado largo.'));"]], undefined, 'warn'],
  ['numeric operand over the limit replaced by zero', 'query.filter.number-exact', [[OVER_LIMIT, 'return 0;']]],
  // 8 (3): a leap second in a local date-time of a request body gives 422 with a format entry (orders.collect_at).
  ['leap second accepted in a local date-time', 'core.leap-second.local', [["    if (ok && type === 'localdatetime' && v.slice(17, 19) === '60') {", '    if (false) {']]],
  // oauth (11.5): a Bearer challenge carries some parameter.
  ['Bearer challenge without parameters', 'passive.error.401', [["    const challenge = req.url !== '/' ? `Bearer realm=\"restep\"${sent}`", "    const challenge = req.url !== '/' ? `Bearer${sent}`"]], OAUTH],
];

// Correct variants: every check in the list must pass (no fail or warning) and the checker must not break.
const VARIANTS = [
  ['computed readOnly field', ['core.patch.roundtrip', 'core.patch.read-only', 'core.patch.merge'], [RATING_SCHEMA, RATING_SET, RATING_RULE]],
  ['root in error with service-doc anchored to the root', ['discovery.service-doc'],
    [['  if (!name) { // Discovery document, at the API root\n', "  if (!name) { // Discovery document, at the API root\n    if (read) throw new Problem(404, 'not_found', t('No discovery.', 'Sin descubrimiento.'), {}, { Link: `${link}, <${SPEC}>; rel=\"service-doc\"; anchor=\"/\"` });\n"]]],
  // 1.1: a new code, unknown to the checker, is not judged; its declared reason is.
  ['1.1 with a new code and reason', ['discovery.reasons', 'passive.error.code', 'passive.error.reason'],
    [["const doc = { restep: RESTEP,", "const doc = { restep: '1.1',"],
      ['status: STATUS, reasons: {}, collections, singletons };', "status: STATUS, reasons: { gone_fishing: { code: 'out_to_lunch', description: 'Back soon.' } }, collections, singletons };"],
      ["code: p.code, detail: text(p.detail, lang), ...extra,", "code: p.status === 404 ? 'out_to_lunch' : p.code, ...(p.status === 404 && { reason: 'gone_fishing' }), detail: text(p.detail, lang), ...extra,"]]],
  ['collection with :changes and _etag', ['writes.etag.collection'], CHANGES],
  // 10: discovery.sync-id is reported like the other declarations, also when it passes.
  ['collection with sync that declares id with in', ['discovery.sync-id'], CHANGES],
  // 4.3: what cannot be exercised without GET is skipped; the 405 with its Allow is a pass. Nothing fails or warns.
  ['collection without declared GET', ['core.methods.left-out', 'core.method-not-allowed', 'core.methods.allow', 'discovery.no-get'], [AUTHORS_POST_ONLY, AUTHORS_UNLISTED], undefined, [], true],
  ['items without declared GET', ['core.methods.left-out', 'core.collection.shape', 'core.reserved.get'], [AUTHORS_ITEMS_NO_GET], undefined, [], true],
  ['request_in_progress with Retry-After', ['passive.error.request-in-progress', 'passive.error.code'],
    [[IN_PROGRESS, "    if (live && live.print === print) throw new Problem(409, 'request_in_progress', 'The first request is still running.', {}, { 'Retry-After': '1' });"]]],
  ['full CORS', ['core.cors.expose', 'core.cors.errors', 'core.cors.preflight', 'core.cors.vary'], CORS],
  ['CORS with credentials', ['core.cors.expose', 'core.cors.errors', 'core.cors.preflight', 'core.cors.vary', 'core.cors.credentials'], [...CORS, CORS_CREDENTIALS]],
  ['CORS with * without credentials', ['core.cors.expose', 'core.cors.errors', 'core.cors.preflight'],
    [...CORS, ["'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'ETag, Location, Link, Allow, Accept-Patch, Accept-Post, Retry-After, Deprecation, Sunset, Idempotent-Replayed, Preference-Applied, Accept-Query'",
      "'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': '*'"],
      ["'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, If-Match, If-None-Match, Idempotency-Key, Prefer, Authorization, DPoP'",
        "'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*'"]]],
  // Draft 6: client-chosen ids, unique fields with --fixture and resources that require headers on writes.
  ['required client id', ['core.post', 'core.client-id', 'core.client-id.required', 'core.client-id.format', 'core.client-id.taken'], [["    id_from: 'either',", "    id_from: 'client',"]]],
  ['fixture with {{n}} template', ['core.post', 'core.client-id', 'core.client-id.taken', 'core.post.charset', 'writes.idempotency.replay', 'writes.minimal', 'inherit.cycle'], [], undefined,
    ['--fixture', 'categories={"name":"Restep check {{n}}","tax_rate_own":null}'], true],
  ['several fixtures without template', ['core.post'], [], undefined, ['--fixture', 'categories={"name":"Restep uno"}', '--fixture', 'categories={"name":"Restep dos"}'], true],
  // 6.1: a string enum that is a sort key may carry a collation.
  ['collation on an enum that is a sort key', ['discovery.collations', 'query.sort.order'], [["    sort: ['id', 'title', 'price', 'rating', 'year', 'reviews.rating'],", "    sort: ['id', 'title', 'price', 'rating', 'year', 'reviews.rating', 'category'],\n    collations: { category: 'server' },"]]],
  // 1.2: the 1.0 text does not exist yet, so under "1.0" inherit, experimental, is not used (skip: must be skipped).
  ['1.0 without text: inherit is not used', ['skip:inherit.read', 'skip:inherit.roundtrip'], [["const RESTEP = '1.0-draft.7';", "const RESTEP = '1.0';"]]],
  // 6.4: without max_limit, limit gives unsupported_parameter; stable order is checked without limit, with the
  // server's page size, and nothing fails because of that 400, which is what the text requires.
  ['collection without max_limit', ['query.limit', 'query.sort.stable'],
    [['schemas: schemas(c, lang), ...(c.max_limit && { max_limit: c.max_limit }),', 'schemas: schemas(c, lang), ...(c.max_limit && c !== db.books && { max_limit: c.max_limit }),'],
      ["id === undefined ? ['filter', 'sort', 'fields', 'count', 'limit', 'cursor', ...include]", "id === undefined ? ['filter', 'sort', 'fields', 'count', ...(coll === db.books ? [] : ['limit']), 'cursor', ...include]"]], undefined, [], true],
  // 11.6: without the extension announced, inherit is not used (like actions): its checks neither run nor are
  // listed as skipped; discovery.inherit already flags it. none:id: that check does not appear in the report.
  ['inherit declared without announcing the extension', ['none:inherit.read', 'none:inherit.roundtrip', 'none:inherit.own', 'none:inherit.stale'],
    [["const EXTENSIONS = TOKEN ? ['actions', 'inherit', 'oauth'] : ['actions', 'inherit'];", "const EXTENSIONS = TOKEN ? ['actions', 'oauth'] : ['actions'];"]]],
  // 5.4: a 405 without a body is valid; its code is compared only if it carries problem+json.
  ['405 without body', ['core.error-order'],
    [["    throw new Problem(405, 'method_not_allowed', t(`Supports ${methods.join(', ')}.`, `Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') });",
      "    { res.writeHead(405, { Allow: methods.join(', ') }); return res.end(); }"]]],
  // 5.4: a 503 says nothing about the order: the check is skipped, not failed.
  ['503 instead of the error that applies', ['skip:core.error-order'],
    [["  if (id !== undefined && !coll.rows.has(id)) throw missing(url);\n",
      "  if (id !== undefined && !coll.rows.has(id)) throw [...params.keys()].length ? new Problem(503, 'unavailable', 'x', {}, { 'Retry-After': '1' }) : missing(url);\n"]]],
  // 11.1: a non-idempotent action that changes the state gives 409 the second time, which conforms: the
  // empty body and {} each go to a new item.
  ['non-idempotent action that changes the state', ['actions.empty-body'],
    [["      restock: { on: 'item', safe: false, idempotent: false, effects: [],\n",
      "      clear: { on: 'item', safe: false, idempotent: false, effects: [], description: t('Empties its stock.', 'Vacía su stock.'),\n" +
      "        run: (coll, row) => { if (!row.stock) throw new Problem(409, 'conflict', 'No stock.'); row.stock = 0; return [200, row]; } },\n" +
      "      restock: { on: 'item', safe: false, idempotent: false, effects: [],\n"]]],
  // Council decisions 7 and 4 of draft 7: upsert with If-Match required creates with If-None-Match: *; a
  // writable datetime rejects a leap second.
  ['upsert that requires If-Match', ['core.upsert.if-match', 'core.upsert'], [UPSERT_IF_MATCH]],
  ['writable datetime field', ['core.leap-second'], [BOOKS_DATETIME]],
  // Council decisions 8 and 7 of round 3: null alone on a to-many relationship may carry quantifier some, with the
  // same selection; a GET action with an integer list param refuses what the number grammar leaves out.
  ['null on reviews declared with quantifier some', ['query.filter.none', 'query.filter.some', 'discovery.ops', 'query.filter.lists'],
    [["...(f.includes('.') && Object.hasOwn(c.some ?? {}, f.split('.')[0]) && { quantifier: 'some' }),", "...(Object.hasOwn(c.some ?? {}, f.split('.')[0]) && { quantifier: 'some' }),"]], undefined, [], true],
  ['GET action with an integer list param', ['actions.params'], [COMPARE_TOP]],
  // Council decisions 1a and 2 of round 4: a JSON body is a file where application/* or */* admits it, and */*
  // without multipart refuses an outer multipart/form-data.
  ['upload that admits application/*', ['core.upload', 'core.upload.json-file', 'core.upload.no-filename'], [FILES_APPLICATION]],
  ['upload of */* without multipart', ['core.upload', 'core.upload.json-file', 'core.upload.multipart-off'], [FILES_ANY]],
  ['requires Idempotency-Key and If-Match',['core.post', 'core.post.media-type', 'core.patch', 'core.patch.merge', 'core.delete', 'core.reserved.writes', 'writes.idempotency.replay', 'writes.if-match.stale', 'writes.if-none-match.required'],
    [['    const scope = idempotencyScope(req, url.pathname);\n', "    const scope = idempotencyScope(req, url.pathname);\n    if (!scope && coll === db.books) throw new Problem(400, 'idempotency_key_required', 'Send Idempotency-Key.');\n"],
      ['  const ifMatch = req.headers[\'if-match\'];\n', "  const ifMatch = req.headers['if-match'];\n  if (ifMatch === undefined && coll === db.books) throw new Problem(428, 'precondition_required', 'Send If-Match.');\n"]], undefined, [], true],
];

function mutate(changes) {
  let src = SERVER;
  for (const [from, to] of changes) {
    if (src.split(from).length !== 2) throw new Error(`The text does not appear exactly once in the server:\n${from}`);
    src = src.replace(from, () => to);
  }
  return src;
}

// Ports, one per run: RESTEP_CHECK_PORTS=8140-8159 for another range (8900-8949 by default).
const [PORT_FROM, PORT_TO] = (process.env.RESTEP_CHECK_PORTS ?? '8900-8949').split('-').map(Number);
let runs = 0;
async function run(src, mode, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'restep-check-'));
  const file = join(dir, 'server.mjs');
  writeFileSync(file, src);
  const p = PORT_FROM + (runs++ % (PORT_TO - PORT_FROM + 1));
  const env = { ...process.env, PORT: String(p), RESTEP_TOKEN: mode === OAUTH ? TOKEN : '' };
  const server = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, ko) => { server.stdout.once('data', ok); server.once('exit', () => ko(new Error('The server did not start'))); });
  try {
    const out = await new Promise((ok) => {
      const auth = mode === OAUTH ? ['--header', `Authorization: Bearer ${TOKEN}`] : [];
      const c = spawn(process.execPath, [CHECKER, `http://localhost:${p}/`, '--writes', '--json', ...auth, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '', err = '';
      c.stdout.on('data', (d) => { text += d; });
      c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (code) => ok({ code, text, err }));
    });
    if (out.code === 2) throw new Error(`The checker could not run: ${out.err.split('\n').filter((l) => l.startsWith('restep-check:')).join(' ')}`);
    return { code: out.code, results: JSON.parse(out.text).results };
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const only = process.argv[2];
let failed = 0;
for (const mode of only ? [] : [undefined, OAUTH]) {
  const label = mode ? `reference with ${mode}` : 'reference';
  const baseline = await run(SERVER, mode);
  const bad = baseline.results.filter((r) => r.status === 'fail' || r.status === 'warn');
  const skipped = mode === OAUTH ? baseline.results.filter((r) => r.id.startsWith('oauth.') && r.status === 'skip') : [];
  if (baseline.code !== 0 || bad.length || skipped.length) {
    failed++;
    console.log(`FAIL   ${label}: ${[...bad, ...skipped].map((r) => `${r.id} (${r.message})`).join('; ')}`);
  } else console.log(`ok     ${label}: ${baseline.results.filter((r) => r.status === 'pass').length} checks pass`);
}

for (const [name, id, changes, mode, want, args] of MUTATIONS.filter(([n]) => !only || n.includes(only))) {
  const { code, results } = await run(mutate(changes), mode, args);
  const hit = results.filter((r) => r.id === id && (r.status === 'fail' || r.status === 'warn'));
  const right = want ? hit.length && hit[0].status === want && (want === 'warn' || code === 1) : hit.length && (hit[0].status === 'warn' || code === 1);
  if (right) console.log(`ok     ${name} → ${id}${want ? ` (${want})` : ''}`);
  else {
    failed++;
    const mine = results.filter((r) => r.id === id).map((r) => `${r.status}${r.message ? `: ${r.message}` : ''}`);
    console.log(`FAIL   ${name}: ${id} does not fail (${mine.join('; ') || 'did not run'})`);
  }
}
// With strict, also, nothing fails or warns in the whole run.
for (const [name, ids, changes, mode, args, strict] of VARIANTS.filter(([n]) => !only || n.includes(only))) {
  const { results } = await run(mutate(changes), mode, args);
  const wrong = results.filter((r) => (strict || ids.includes(r.id)) && (r.status === 'fail' || r.status === 'warn'));
  // skip:id: that check must be skipped, neither passing nor failing anywhere.
  // none:id: that check does not appear in the report, not even as skipped.
  const missing = ids.filter((id) => (id.startsWith('skip:')
    ? !results.some((r) => r.id === id.slice(5) && r.status === 'skip') || results.some((r) => r.id === id.slice(5) && r.status !== 'skip')
    : id.startsWith('none:') ? results.some((r) => r.id === id.slice(5))
      : !results.some((r) => r.id === id && r.status === 'pass')));
  if (!wrong.length && !missing.length) console.log(`ok     ${name}: ${ids.join(', ')} pass`);
  else {
    failed++;
    console.log(`FAIL   ${name}: ${[...wrong.map((r) => `${r.id} ${r.status}: ${r.message}`), ...missing.map((id) => `${id} ${id.startsWith('none:') ? 'appears' : 'does not pass'}`)].join('; ')}`);
  }
}
// --schema needs ajv and ajv-formats, which the standalone file does not bring. Without them, an error that says what
// is missing and the npx command; with them installed in the folder it runs from, it works without copying the checker.
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
    const doc = JSON.stringify({ restep: '1.0-draft.7', profiles: ['core'], collections: {} });
    writeFileSync(join(tool, 'doc.json'), doc);
    const alone = await schemaMode(tool, join(tool, 'restep-check.mjs'));
    const said = alone.err;
    if (alone.code === 2 && /ajv-formats/.test(said) && said.includes('npx restep-check --schema discovery doc.json')) console.log('ok     --schema without ajv: says what is missing and gives the npx command');
    else { failed++; console.log(`FAIL   --schema without ajv: exit ${alone.code}, "${said.trim()}"`); }
    // Fake packages in the project folder: the checker finds them even though it lives in another.
    for (const [pkg, main, src] of [['ajv', 'dist/2020.js', 'module.exports = class { compile() { return () => true; } };'], ['ajv-formats', 'index.js', 'module.exports = () => {};']]) {
      mkdirSync(dirname(join(project, 'node_modules', pkg, main)), { recursive: true });
      writeFileSync(join(project, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0', main }));
      writeFileSync(join(project, 'node_modules', pkg, main), src);
    }
    writeFileSync(join(project, 'doc.json'), doc);
    const found = await schemaMode(project, join(tool, 'restep-check.mjs'));
    if (found.code === 0 && /doc\.json/.test(found.out)) console.log('ok     --schema with ajv in the working folder, the checker in another');
    else { failed++; console.log(`FAIL   --schema with ajv in the working folder: exit ${found.code}, ${found.err.trim() || found.out.trim()}`); }
    // The rules of the text that the schema does not express: the fake ajv accepts everything, so whatever
    // fails comes from those rules, which the report gives separately. A bookshop: books, authors and reviews.
    const books = { path: '/books', filter: { id: { type: 'string', ops: ['eq', 'in'] }, title: { type: 'string', ops: ['eq'] } },
      sort: ['id', 'title'], relations: { author: { to: 'authors' }, reviews: { to: 'reviews', many: true } } };
    const base = { restep: '1.0-draft.7', profiles: ['core', 'query', 'relations'],
      collections: { books, authors: { path: '/authors' }, reviews: { path: '/books/{book_id}/reviews', parent: 'books' } } };
    const RULES = [
      ['named filter named like a filter', 'discovery.named-filters', { books: { ...books, named_filters: { title: { description: 'Por título.' } } } }],
      ['subcollection whose path does not start with the parent\'s', 'discovery.subcollections', { reviews: { path: '/reviews/{book_id}/items', parent: 'books' } }],
      ['sort through a to-many relation', 'query.filter.lists', { books: { ...books, sort: ['id', 'reviews.rating'] } }],
      ['filter through a to-many relation', 'query.filter.lists', { books: { ...books, filter: { ...books.filter, 'reviews.rating': { type: 'integer', ops: ['ge'] } } } }],
      ['sync without in on the id filter', 'discovery.sync-id', { authors: { path: '/authors', sync: {}, filter: { id: { type: 'string', ops: ['eq'] } } } }],
      ['whole language map in sort', 'query.language.declared', { authors: { path: '/authors', language_maps: { bio: {} }, sort: ['bio'] } }],
      // Draft 7: what discovery declares (4.2, 4.3, 5.1, 5.9, 6.1, 11.1, 11.6).
      ['null alone on a to-many relation with quantifier some', null, { books: { ...books, filter: { ...books.filter, reviews: { type: 'string', ops: ['null'], quantifier: 'some' } } } }],
      ['upload with create that admits JSON without multipart', 'discovery.upload', { authors: { path: '/authors', schemas: { create: { type: 'object' } }, upload: { media_types: ['application/*'] } } }],
      ['path through a to-many relation with quantifier', null, { books: { ...books, filter: { ...books.filter, 'reviews.rating': { type: 'integer', ops: ['ge'], quantifier: 'some' } } } }],
      ['path through two to-many steps', 'query.filter.lists', { reviews: { path: '/books/{book_id}/reviews', parent: 'books', relations: { likes: { to: 'authors', many: true } } },
        books: { ...books, filter: { ...books.filter, 'reviews.likes.name': { type: 'string', ops: ['eq'], quantifier: 'some' } } } }],
      ['ne with quantifier', 'discovery.ops', { books: { ...books, filter: { ...books.filter, 'reviews.rating': { type: 'integer', ops: ['ne'], quantifier: 'some' } } } }],
      ['contains on id', 'discovery.ops', { books: { ...books, filter: { ...books.filter, id: { type: 'string', ops: ['eq', 'contains'] } } } }],
      ['unknown operator', 'discovery.ops', { books: { ...books, filter: { ...books.filter, title: { type: 'string', ops: ['eq', 'like'] } } } }],
      ['sync on a collection without GET', 'discovery.sync-id', { authors: { path: '/authors', methods: ['POST'], sync: {}, filter: { id: { type: 'string', ops: ['eq', 'in'] } } } }],
      ['sync with a required filter', 'discovery.sync-id', { authors: { path: '/authors', sync: {}, filter: { id: { type: 'string', ops: ['eq', 'in'], required: true } } } }],
      ['subcollection with literal segments missing', 'discovery.subcollections', { reviews: { path: '/books/{book_id}', parent: 'books' } }],
      ['subcollection variable with a hyphen', 'discovery.subcollections', { reviews: { path: '/books/{book-id}/reviews', parent: 'books' } }],
      ['upsert with id_from server', 'discovery.id-from', { authors: { path: '/authors', upsert: true } }],
      ['unknown member of an upload', 'discovery.members', { authors: { path: '/authors', upload: { media_types: ['image/*'], max_pixels: 100 } } }],
      ['localized field whose source is not a language map', 'discovery.localized', { authors: { path: '/authors', localized: { name: { source: 'name_i18n' } } } }, { default_language: 'es' }],
      ['shared_cache in a collection', 'discovery.members', { authors: { path: '/authors', shared_cache: {} } }],
      ['effect of a method keyed by GET', 'discovery.effects', { authors: { path: '/authors', method_effects: { GET: [] } } }],
      ['singleton with a parent whose path it does not extend', 'discovery.singletons', {}, { singletons: { settings: { path: '/readers/{reader_id}/settings', parent: 'authors' } } }],
      ['singleton action with on', 'discovery.actions', {}, { singletons: { me: { path: '/me', actions: { verify: { on: 'item', safe: false, idempotent: true } } } } }],
      ['safe action that is not idempotent', 'discovery.actions', { authors: { path: '/authors', actions: { look: { on: 'item', safe: true, idempotent: false } } } }],
      ['inherit_items through a to-many relation', 'discovery.inherit', { reviews: { path: '/books/{book_id}/reviews', parent: 'books', inherit_items: { from: ['reviews'] } } }, { extensions: ['inherit'] }],
      ['default on a typed named filter', 'discovery.named-filters', { books: { ...books, named_filters: { search: { type: 'string', default: true, description: 'Busca.' } } } }],
      ['notice in a fraction of a second', 'discovery.deprecations', { books: { ...books, deprecations: [{ kind: 'sort', name: 'title', announced: '2026-11-20T00:00:00.5Z' }] } }],
    ];
    writeFileSync(join(project, 'ok.json'), JSON.stringify(base));
    const ok = await schemaMode(project, join(tool, 'restep-check.mjs'), 'ok.json');
    if (ok.code === 0 && /Schema \(discovery\.json\): valid/.test(ok.out) && /Rules of the text that the schema cannot express: 0 failed/.test(ok.out))
      console.log('ok     --schema discovery: a correct document passes the schema and the rules, reported separately');
    else { failed++; console.log(`FAIL   --schema discovery with a correct document: exit ${ok.code}, ${ok.err.trim() || ok.out.trim()}`); }
    for (const [label, id, change, top = {}] of RULES) {
      writeFileSync(join(project, 'bad.json'), JSON.stringify({ ...base, ...top, collections: { ...base.collections, ...change } }));
      const text = await schemaMode(project, join(tool, 'restep-check.mjs'), 'bad.json');
      const json = await schemaMode(project, join(tool, 'restep-check.mjs'), 'bad.json', ['--json']);
      let r;
      try { r = JSON.parse(json.out).results[0]; } catch { r = null; }
      const hit = r?.rules?.find((x) => x.id === id && x.status === 'fail');
      // Without an id, a correct declaration: nothing fails.
      if (id === null) {
        if (text.code === 0 && r?.conforms === true) console.log(`ok     --schema discovery: ${label} passes`);
        else { failed++; console.log(`FAIL   --schema discovery: ${label}: ${(r?.rules ?? []).filter((x) => x.status === 'fail').map((x) => `${x.id}: ${x.message}`).join('; ') || text.err.trim()}`); }
        continue;
      }
      if (text.code === 1 && json.code === 1 && r.valid === true && r.conforms === false && hit && text.out.includes(`FAIL ${id}`) && /Schema \(discovery\.json\): valid/.test(text.out))
        console.log(`ok     --schema discovery: ${label} → ${id}`);
      else { failed++; console.log(`FAIL   --schema discovery: ${label}: ${id} does not fail (exit ${text.code}; ${(r?.rules ?? []).filter((x) => x.id === id).map((x) => `${x.status}: ${x.message}`).join('; ') || text.err.trim() || 'did not run'})`); }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// The pages' list of checks must be up to date with the code.
// And so must what is generated from other sources: the pages' table and the specification in Markdown.
const generated = !inSite ? [] : [[process.execPath, join(here, 'table.mjs')], ['python3', join(here, '../sources.py')], ['python3', join(here, '../spec-md.py')]];
for (const [cmd, script] of generated) {
  const p = spawn(cmd, [script, '--check'], { stdio: 'inherit', cwd: join(here, '../..') });
  if (await new Promise((ok) => p.on('exit', ok))) { failed++; console.log(`FAIL   out of date: run ${script.split('/tools/')[1] ? 'tools/' + script.split('/tools/')[1] : script}`); }
}
console.log(failed ? `\n${failed} tests fail` : '\nAll tests pass');
process.exit(failed ? 1 : 0);
