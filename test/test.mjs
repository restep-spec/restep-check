// Pruebas de restep-check: el servidor de referencia tiene que pasar entero, y cada versión con un
// fallo metido a propósito (una mutación) tiene que hacer fallar la comprobación que lo cubre.
//   node tools/restep-check/test.mjs            (desde projects/restep)
//   node tools/restep-check/test.mjs cursor     (solo las mutaciones cuyo nombre contiene «cursor»)
// La misma prueba va en github.com/restep-spec/restep-check (test/test.mjs, con el servidor al lado):
// allí busca el servidor y el comprobador junto a ella y se salta lo generado de la web.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
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

// [nombre, comprobación que debe fallar, [[texto del servidor, reemplazo], ...], modo]
// Con el modo OAUTH, el servidor arranca con RESTEP_TOKEN (extensión oauth) y el comprobador manda el token.
const MUTATIONS = [
  ['next ausente al final', 'core.collection.shape',
    [['items: page.map((r) => pick(r, fields)), next,', 'items: page.map((r) => pick(r, fields)), ...(next && { next }),']]],
  ['parámetro reservado ignorado', 'core.reserved.item',
    [['if (!allowed.includes(base)) throw unsupported(key);', 'if (!allowed.includes(base)) continue;']]],
  ['400 antes que 404', 'core.error-order',
    [["  if (id !== undefined && !coll.rows.has(id)) throw new Problem(404, 'not_found', `${url.pathname} does not exist.`);\n", '']]],
  ['400 antes que 405', 'core.error-order',
    [["  if (!methods.includes(method))\n    throw new Problem(405, 'method_not_allowed', `Supports ${methods.join(', ')}.`, {}, { Allow: methods.join(', ') });\n\n  // 5.3", '  // 5.3'],
      ["    if (!allowed.includes(base)) throw unsupported(key);", "    if (!allowed.includes(base)) throw unsupported(key);\n    if (!methods.includes(method)) continue;"]]],
  ['$ sin reservar', 'core.reserved.dollar',
    [["const isReserved = (base) => RESERVED.includes(base) || base.startsWith('$');", 'const isReserved = (base) => RESERVED.includes(base);']]],
  ['404 con otro código', 'core.not-found',
    [['code: p.code, detail: p.message,', "code: p.status === 404 ? 'missing' : p.code, detail: p.message,"]]],
  ['405 sin Allow', 'passive.error.405',
    [["`Supports ${methods.join(', ')}.`, {}, { Allow: methods.join(', ') }", "`Supports ${methods.join(', ')}.`, {}, {}"]]],
  ['errores como application/json', 'passive.error.media-type',
    [["status >= 400 ? 'application/problem+json' : 'application/json'", "'application/json'"]]],
  ['status distinto en el cuerpo', 'passive.error.members',
    [['title: TITLES[p.status] ?? \'Error\', status: p.status,', "title: TITLES[p.status] ?? 'Error', status: 400,"]]],
  ['errores sin Cache-Control', 'passive.cache-control',
    [["{ 'Cache-Control': 'no-store', ...p.headers }", '{ ...p.headers }']]],
  ['sin cabecera de perfil', 'passive.profile-link',
    [['res.writeHead(status, { Link: link,', 'res.writeHead(status, {']]],
  ['limit recortado en silencio', 'query.limit.range',
    [['if (!/^\\d+$/.test(params.get(\'limit\') ?? \'1\') || !Number.isInteger(limit) || limit < 1 || limit > coll.max_limit)',
      "if (!/^\\d+$/.test(params.get('limit') ?? '1') || !Number.isInteger(limit) || limit < 1)"]]],
  ['cursor sin firmar', 'query.cursor.tampered',
    [['if (parts.length === 2 && mac === sign(payload)) {', 'if (parts.length === 2) {']]],
  ['cursor sin ligar a la consulta', 'query.cursor.other-query',
    [['c.q !== print) throw', 'false) throw']]],
  // En los datos solo falta rating (en el libro 50), y rating admite ge.
  ['ge devuelve ausentes', 'query.filter.absent',
    [['items = items.filter((r) => r[field] != null && OPS[op](compare(type, r[field], v)));',
      "items = items.filter((r) => (r[field] == null && op === 'ge') || (r[field] != null && OPS[op](compare(type, r[field], v))));"]]],
  ['le como lt', 'query.filter.match',
    [['le: (c) => c <= 0,', 'le: (c) => c < 0,']]],
  ['ausentes primero al ordenar', 'query.sort.order',
    [['return x == null ? 1 : -1; } // missing values last', 'return x == null ? -1 : 1; }']]],
  ['orden sin desempate', 'query.sort.stable',
    [["for (const s of [...sort, 'id']) {", 'for (const s of sort) {'],
      ['let items = applyFilters(coll, params);', 'let items = applyFilters(coll, params).sort(() => Math.random() - 0.5);']]],
  ['filtro repetido aceptado', 'query.filter.bad-value',
    [["if (seen.has(`${field}[${op}]`)) throw bad(key, 'The same filter appears twice.');", ''],
      ["if (params.getAll(key).length > 1) throw bad(key, `Send ${key} once.`);", '']]],
  ['rango tomado por repetido', 'query.filter.same-field',
    [["if (seen.has(`${field}[${op}]`)) throw bad(key, 'The same filter appears twice.');\n    seen.add(`${field}[${op}]`);",
      "if (seen.has(field)) throw bad(key, 'The same filter appears twice.');\n    seen.add(field);"]]],
  ['filter[f] y filter[f][eq] como distintos', 'query.filter.bad-value',
    [["if (seen.has(`${field}[${op}]`)) throw bad(key, 'The same filter appears twice.');\n    seen.add(`${field}[${op}]`);",
      "if (seen.has(key)) throw bad(key, 'The same filter appears twice.');\n    seen.add(key);"]]],
  ['cursor ligado a limit', 'query.cursor.page-params',
    [["const PAGE_ONLY = ['cursor', 'limit', 'fields', 'include', 'count'];", "const PAGE_ONLY = ['cursor', 'count'];"]]],
  ['fields devuelve de más', 'query.fields',
    [['const out = { id: row.id };', 'const out = { id: row.id, year: row.year };']]],
  ['count sin declarar ignorado', 'query.count',
    [["...(count === 'true' && { total: items.length }),", '']]],
  ['ETag débil', 'writes.etag.strong',
    [['const etag = (value) => `"${hash(JSON.stringify(value))}"`;', 'const etag = (value) => `W/"${hash(JSON.stringify(value))}"`;']]],
  ['If-None-Match ignorado en GET', 'writes.if-none-match.get',
    [["if (weakMatch(req.headers['if-none-match'], tag)) return send(res, 304, undefined, headers);", '']]],
  ['If-Match ignorado', 'writes.if-match.stale',
    [["if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))\n    throw", 'if (false)\n    throw']]],
  ['If-Match no atómico', 'writes.if-match.race',
    [["    throw new Problem(412, 'precondition_failed', 'Someone changed it: read it again before writing.');",
      "    throw new Problem(412, 'precondition_failed', 'Someone changed it: read it again before writing.');\n  await new Promise((r) => setTimeout(r, 30));"]]],
  ['Idempotency-Key ignorada', 'writes.idempotency.replay',
    [['const live = saved && saved.expires > Date.now() ? saved : null;', 'const live = null;']]],
  ['precondición antes de repetir', 'writes.idempotency.replay-precondition',
    [['    if (live && live.print === print)\n', '    if (live && live.print === print && req.headers[\'if-none-match\'] === undefined)\n']]],
  ['huella con el texto literal', 'writes.idempotency.json-equality',
    [['const print = scope && hash(canonical(sent));', 'const print = scope && hash(JSON.stringify(sent));']]],
  ['clave mal formada aceptada', 'writes.idempotency.malformed',
    [["if (!m) throw new Problem(400, 'bad_request', 'Idempotency-Key must be a quoted string, such as \"8e03978e-40d5\".');",
      'if (!m) return null;']]],
  ['POST acepta id', 'core.post.id',
    [["if ('id' in body) throw invalid(", "if (false) throw invalid("]]],
  ['PATCH guarda los _', 'core.patch.underscore',
    [["const body = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));", 'const body = v;'],
      ['if (!Object.hasOwn(coll.types, f)) { errors.push(', "if (!Object.hasOwn(coll.types, f) && !f.startsWith('_')) { errors.push("]]],
  ['null no borra', 'core.patch.merge',
    [['if (v === null) delete out[k];', 'if (v === null) out[k] = out[k];']]],
  ['DELETE con 200', 'core.delete',
    [["if (method === 'DELETE') { coll.rows.delete(id); return send(res, 204); }", "if (method === 'DELETE') { coll.rows.delete(id); return send(res, 200, { deleted: true }); }"]]],
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
    [['code: p.code, detail: p.message, ...p.extra,', 'code: p.code, ...p.extra,']]],
  ['descripción vacía en el descubrimiento', 'discovery.describing',
    [['description: c.description, methods: c.methods,', "description: '', methods: c.methods,"]]],
  ['methods declarados que no coinciden con Allow', 'core.methods.allow',
    [['description: c.description, methods: c.methods,', "description: c.description, methods: ['GET', 'POST', 'DELETE'],"]]],
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
];

function mutate(changes) {
  let src = SERVER;
  for (const [from, to] of changes) {
    if (src.split(from).length !== 2) throw new Error(`El texto no aparece exactamente una vez en el servidor:\n${from}`);
    src = src.replace(from, () => to);
  }
  return src;
}

let port = 18300;
async function run(src, mode) {
  const dir = mkdtempSync(join(tmpdir(), 'restep-check-'));
  const file = join(dir, 'server.mjs');
  writeFileSync(file, src);
  const p = ++port;
  const env = { ...process.env, PORT: String(p), RESTEP_TOKEN: mode === OAUTH ? TOKEN : '' };
  const server = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, ko) => { server.stdout.once('data', ok); server.once('exit', () => ko(new Error('El servidor no arrancó'))); });
  try {
    const out = await new Promise((ok) => {
      const auth = mode === OAUTH ? ['--header', `Authorization: Bearer ${TOKEN}`] : [];
      const c = spawn(process.execPath, [CHECKER, `http://localhost:${p}/`, '--writes', '--json', ...auth], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      c.stdout.on('data', (d) => { text += d; });
      c.on('exit', (code) => ok({ code, text }));
    });
    if (out.code === 2) throw new Error('El comprobador no pudo ejecutarse');
    return { code: out.code, results: JSON.parse(out.text).results };
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const only = process.argv[2];
let failed = 0;
for (const mode of [undefined, OAUTH]) {
  const label = mode ? `referencia con ${mode}` : 'referencia';
  const baseline = await run(SERVER, mode);
  const bad = baseline.results.filter((r) => r.status === 'fail' || r.status === 'warn');
  const skipped = mode === OAUTH ? baseline.results.filter((r) => r.id.startsWith('oauth.') && r.status === 'skip') : [];
  if (baseline.code !== 0 || bad.length || skipped.length) {
    failed++;
    console.log(`FALLA  ${label}: ${[...bad, ...skipped].map((r) => `${r.id} (${r.message})`).join('; ')}`);
  } else console.log(`ok     ${label}: ${baseline.results.filter((r) => r.status === 'pass').length} comprobaciones pasan`);
}

for (const [name, id, changes, mode] of MUTATIONS.filter(([n]) => !only || n.includes(only))) {
  const { code, results } = await run(mutate(changes), mode);
  const hit = results.filter((r) => r.id === id && (r.status === 'fail' || r.status === 'warn'));
  if (hit.length && (hit[0].status === 'warn' || code === 1)) console.log(`ok     ${name} → ${id}`);
  else {
    failed++;
    const mine = results.filter((r) => r.id === id).map((r) => `${r.status}${r.message ? `: ${r.message}` : ''}`);
    console.log(`FALLA  ${name}: ${id} no falla (${mine.join('; ') || 'no se ejecutó'})`);
  }
}
// La lista de comprobaciones de las páginas tiene que estar al día con el código.
// Y lo generado a partir de otras fuentes: la tabla de las páginas, la especificación en Markdown y los zip de las skills.
const generated = !inSite ? [] : [[process.execPath, join(here, 'tabla.mjs')], ['python3', join(here, '../fuentes.py')], ['python3', join(here, '../spec-md.py')], ['python3', join(here, '../skills.py')]];
for (const [cmd, script] of generated) {
  const p = spawn(cmd, [script, '--check'], { stdio: 'inherit', cwd: join(here, '../..') });
  if (await new Promise((ok) => p.on('exit', ok))) { failed++; console.log(`FALLA  desfasado: ejecuta ${script.split('/tools/')[1] ? 'tools/' + script.split('/tools/')[1] : script}`); }
}
console.log(failed ? `\n${failed} pruebas fallan` : '\nTodas las pruebas pasan');
process.exit(failed ? 1 : 0);
