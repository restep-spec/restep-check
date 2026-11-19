// Restep 1 · Reference implementation of the core, query and writes profiles (and oauth, see below).
// Node 18 or later, no dependencies.  Usage:  node restep-server.mjs  →  http://localhost:8080/
// Specification: https://restep.wubytes.com/1/  (draft 4)
// With RESTEP_TOKEN=secret it also implements the oauth extension (10.5): every request needs
// Authorization: Bearer secret, and the metadata is at /.well-known/oauth-protected-resource.
// The token stands in for one from an authorization server; it does not issue or validate real ones.
// RFC 9728 requires https: behind a local http URL this only simulates the extension.
// It does not implement relations, sync or any other extension: those parameters and paths fail loudly.
// Field types: it only handles the ones its data uses (string, integer, number, decimal, enum); a server
// with date, datetime, duration or boolean fields must add their comparison rules (section 6.1).
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const SPEC = 'https://restep.wubytes.com/1/';
const PROFILES = ['core', 'query', 'writes'];
const TOKEN = process.env.RESTEP_TOKEN || null;
const EXTENSIONS = TOKEN ? ['oauth'] : [];
const STATUS = '/health'; // 4.4: any path, declared in discovery as status
const METADATA = '/.well-known/oauth-protected-resource'; // the root is /, so no path after the suffix (RFC 9728, 3.1)

// ── Data: the El Marcapáginas bookshop (https://rest.wubytes.com) ─────────────
// Field types follow the discovery vocabulary (section 4.2): they drive validation and comparison.
const rows = (list) => new Map(list.map((r) => [r.id, r]));
const db = {
  books: {
    description: 'Books in the catalogue of El Marcapáginas, one per edition.',
    methods: ['GET', 'POST'], item_methods: ['GET', 'PATCH', 'DELETE'], // 4.3: declared, so they must match Allow
    types: { id: 'string', title: 'string', price: 'decimal', rating: 'number', year: 'integer', category: 'enum' },
    values: { category: ['novela-negra', 'ciencia-ficcion', 'ensayo', 'poesia', 'infantil'] },
    required: ['title', 'price'],
    filter: { id: ['eq', 'in'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],
      year: ['eq', 'lt', 'le', 'gt', 'ge'], rating: ['ge', 'null'] },
    sort: ['id', 'title', 'price', 'rating', 'year'],
    max_limit: 50,
    count: 'exact',
    rows: rows([
      { id: '7', title: 'La niebla de Portugalete', price: '18.50', rating: 4.6, year: 2025, category: 'novela-negra' },
      { id: '12', title: 'El último ferry', price: '16.90', rating: 4.3, year: 2023, category: 'novela-negra' },
      { id: '15', title: 'Lluvia sobre Deusto', price: '14.95', rating: 4.1, year: 2022, category: 'novela-negra' },
      { id: '21', title: 'Mareas de silicio', price: '19.90', rating: 4.4, year: 2026, category: 'ciencia-ficcion' },
      { id: '23', title: 'Cartografía del ruido', price: '21.00', rating: 4.0, year: 2026, category: 'ensayo' },
      { id: '30', title: 'Cuaderno de faros', price: '12.00', rating: 4.8, year: 2024, category: 'poesia' },
      { id: '50', title: 'Bajo la niebla', price: '11.90', year: 2025, category: 'infantil' },
    ]),
  },
};
let nextId = 100;

// ── core: responses and errors ────────────────────────────────────────────────
const link = [...PROFILES, ...EXTENSIONS].map((p) => `<${SPEC}${p}>; rel="profile"`).join(', ');
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16);
// Strong ETag of an item's state: always over the whole item, whatever fields were asked for (7.2).
const etag = (value) => `"${hash(JSON.stringify(value))}"`;

function send(res, status, data, headers = {}, head = false) {
  const body = data === undefined ? '' : JSON.stringify(data);
  // 7.3: with credentials, every response depends on them.
  const cc = headers['Cache-Control'];
  if (TOKEN && cc && !cc.includes('no-store')) headers = { ...headers, 'Cache-Control': `private, ${cc.replace(/^public, /, '')}` };
  const type = status >= 400 ? 'application/problem+json' : 'application/json';
  res.writeHead(status, { Link: link, ...(body && { 'Content-Type': type }), ...headers });
  res.end(head ? undefined : body);
}

class Problem extends Error {
  constructor(status, code, detail, extra = {}, headers = {}) { super(detail); Object.assign(this, { status, code, extra, headers }); }
}
const TITLES = {
  400: 'Bad request', 401: 'Unauthenticated', 404: 'Not found', 405: 'Method not allowed', 409: 'Conflict', 412: 'The resource has changed',
  415: 'Unsupported media type', 422: 'Invalid data', 500: 'Internal error',
};
function problem(res, p, method) {
  send(res, p.status, {
    type: `${SPEC}errors#${p.code}`, title: TITLES[p.status] ?? 'Error', status: p.status,
    code: p.code, detail: p.message, ...p.extra,
  }, { 'Cache-Control': 'no-store', ...p.headers }, method === 'HEAD'); // 7.3: errors to GET carry Cache-Control too
}

const bad = (parameter, detail) => new Problem(400, 'invalid_parameter', detail, { parameter });
const unsupported = (parameter, detail = `This resource does not support ${parameter}.`) =>
  new Problem(400, 'unsupported_parameter', detail, { parameter });
const invalid = (errors, detail = 'Invalid data.') => new Problem(422, 'invalid', detail, { errors });

// 4.3: JSON Schemas of an item and of the bodies of POST and PATCH, built from the same types,
// required fields and enum values that validate() checks, so a body they reject gets a 422.
function schemas(c) {
  const json = (f) => {
    const t = c.types[f];
    return t === 'decimal' ? { type: 'string', pattern: DECIMAL.source, description: 'A decimal in a string, such as "18.50".' }
      : t === 'enum' ? { type: 'string', enum: c.values[f] } : { type: t };
  };
  const fields = Object.keys(c.types).filter((f) => f !== 'id');
  const props = (nullable) => Object.fromEntries(fields.map((f) => {
    const s = json(f);
    return [f, nullable && !c.required.includes(f) ? { anyOf: [s, { type: 'null' }] } : s];
  }));
  const reserved = { '^_': {} }; // members starting with _ are ignored on writes (5.1)
  return {
    item: { type: 'object', required: ['id', ...c.required], properties: { id: { type: 'string', readOnly: true }, ...props(true) } },
    create: { type: 'object', required: c.required, properties: props(true), patternProperties: reserved, additionalProperties: false },
    update: {
      type: 'object', description: 'A JSON Merge Patch: absent leaves a field untouched, null deletes it.',
      properties: { id: { type: 'string', description: 'If present, the item\'s own id.' }, ...props(true) },
      patternProperties: reserved, additionalProperties: false,
    },
  };
}

// ── Typed comparison (6.1): exact decimals, numbers, text by code points ──────
const DECIMAL = /^-?\d+(\.\d+)?$/;
function cmpDecimal(a, b) { // exact: compares digit strings, never through Number
  const neg = (s) => s.startsWith('-') && /[1-9]/.test(s); // -0 and 0 are the same number
  if (neg(a) !== neg(b)) return neg(a) ? -1 : 1;
  const sign = neg(a) ? -1 : 1;
  const [ai, af = ''] = a.replace('-', '').split('.'), [bi, bf = ''] = b.replace('-', '').split('.');
  if (!neg(a) && !neg(b) && !/[1-9]/.test(a + b)) return 0;
  const i1 = ai.replace(/^0+(?=\d)/, ''), i2 = bi.replace(/^0+(?=\d)/, '');
  if (i1.length !== i2.length) return sign * (i1.length - i2.length);
  if (i1 !== i2) return sign * (i1 < i2 ? -1 : 1);
  const n = Math.max(af.length, bf.length), f1 = af.padEnd(n, '0'), f2 = bf.padEnd(n, '0');
  return f1 === f2 ? 0 : sign * (f1 < f2 ? -1 : 1);
}
function cmpText(a, b) { // by Unicode code points, not UTF-16 units (6.1)
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
function compare(type, a, b) {
  if (type === 'decimal') return cmpDecimal(String(a), String(b));
  if (type === 'integer' || type === 'number') return a - b;
  return cmpText(String(a), String(b));
}
// Parses a filter value from the URL according to the field's type; a mismatch is invalid_parameter.
function parseValue(type, raw, key) {
  if (type === 'decimal' && DECIMAL.test(raw)) return raw;
  if (type === 'integer' && /^-?\d+$/.test(raw)) return Number(raw);
  if (type === 'number' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return Number(raw);
  if (type === 'string') return raw;
  if (Array.isArray(type)) {
    if (type.includes(raw)) return raw;
    throw bad(key, `${raw} is not one of: ${type.join(', ')}.`);
  }
  throw bad(key, `${raw} is not a valid ${type}.`);
}
const OPS = {
  eq: (c) => c === 0, ne: (c) => c !== 0, lt: (c) => c < 0, le: (c) => c <= 0, gt: (c) => c > 0, ge: (c) => c >= 0,
};

// ── query: filters, sorting, fields, pagination and counts ───────────────────
const RESERVED = ['filter', 'sort', 'fields', 'include', 'count', 'limit', 'cursor', 'since'];
const reservedName = (k) => k.replace(/\[.*$/, '');
const isReserved = (base) => RESERVED.includes(base) || base.startsWith('$');

function pick(row, fields) {
  if (!fields) return row;
  const out = { id: row.id };
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}
function parseFields(params, coll) {
  if (params.getAll('fields').length > 1) throw bad('fields', 'Send fields once.');
  const raw = params.get('fields');
  if (raw === null) return null;
  const fields = raw.split(',');
  for (const f of fields) {
    if (f.includes('.')) throw unsupported('fields', 'Dotted paths in fields need the relations profile.');
    if (!Object.hasOwn(coll.types, f)) throw bad('fields', `There is no field ${f || '(empty)'}.`);
  }
  return fields;
}

function applyFilters(coll, params) {
  let items = [...coll.rows.values()];
  const seen = new Set();
  for (const [key, value] of params) {
    if (reservedName(key) !== 'filter') continue;
    if (key === 'filter') throw unsupported(key, 'filter as an expression needs the filter-expr extension.');
    const m = key.match(/^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/);
    if (!m) throw unsupported(key, 'This resource supports filter[field] and filter[field][op].');
    const [, field, op = 'eq'] = m;
    if (!Object.hasOwn(coll.filter, field)) throw unsupported(key);
    if (!coll.filter[field].includes(op)) throw unsupported(key, `${field} supports: ${coll.filter[field].join(', ')}.`);
    if (seen.has(`${field}[${op}]`)) throw bad(key, 'The same filter appears twice.');
    seen.add(`${field}[${op}]`);
    const type = coll.types[field] === 'enum' ? coll.values[field] : coll.types[field]; // an enum parses as its list of values
    if (op === 'null') {
      if (value !== 'true' && value !== 'false') throw bad(key, 'Use true or false.');
      items = items.filter((r) => (r[field] === undefined || r[field] === null) === (value === 'true'));
    } else if (op === 'in') {
      const values = value.split(',');
      if (values.some((v) => v === '')) throw bad(key, 'in needs a non-empty, comma-separated list.');
      const parsed = values.map((v) => parseValue(type, v, key));
      items = items.filter((r) => r[field] != null && parsed.some((v) => compare(type, r[field], v) === 0));
    } else {
      const v = parseValue(type, value, key);
      items = items.filter((r) => r[field] != null && OPS[op](compare(type, r[field], v)));
    }
  }
  return items;
}

function parseSort(coll, params) {
  if (params.getAll('sort').length > 1) throw bad('sort', 'Send sort once.');
  const sort = (params.get('sort') ?? 'id').split(',');
  for (const s of sort) {
    const f = s.replace(/^-/, '');
    if (!f) throw bad('sort', 'Empty sort key.');
    if (!coll.sort.includes(f)) throw unsupported('sort', `${f} is not sortable. Sortable: ${coll.sort.join(', ')}.`);
  }
  return sort;
}

// A cursor is opaque to clients but bound to the collection, filters and sort it was issued for (6.4),
// not to what each page carries: limit, fields, include and count may change between pages.
const PAGE_ONLY = ['cursor', 'limit', 'fields', 'include', 'count'];
const queryPrint = (path, params) => {
  const q = [...params].filter(([k]) => !PAGE_ONLY.includes(k)).sort();
  return hash(`${path}?${new URLSearchParams(q)}`);
};
const CURSOR_KEY = randomBytes(32); // cursors are signed, so a tampered one is rejected
const sign = (text) => createHmac('sha256', CURSOR_KEY).update(text).digest('base64url').slice(0, 22);
const makeCursor = (o, print) => {
  const payload = Buffer.from(JSON.stringify({ o, q: print })).toString('base64url');
  return `${payload}.${sign(payload)}`;
};
function readCursor(params, print) {
  if (!params.has('cursor')) return 0;
  let c = {};
  const parts = params.get('cursor').split('.');
  const [payload, mac] = parts;
  if (parts.length === 2 && mac === sign(payload)) {
    try { c = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch {}
  }
  if (!Number.isInteger(c.o) || c.o < 0 || c.q !== print) throw bad('cursor', 'Invalid or expired cursor, or one issued for another query.');
  return c.o;
}

function list(coll, params, path) {
  let items = applyFilters(coll, params);
  const sort = parseSort(coll, params);
  items.sort((a, b) => {
    for (const s of [...sort, 'id']) {
      const f = s.replace(/^-/, '');
      const x = a[f], y = b[f];
      if (x == null || y == null) { if (x == null && y == null) continue; return x == null ? 1 : -1; } // missing values last
      const d = compare(coll.types[f], x, y) * (s.startsWith('-') ? -1 : 1);
      if (d) return d;
    }
    return 0;
  });
  if (params.getAll('limit').length > 1) throw bad('limit', 'Send limit once.');
  const limit = params.has('limit') ? Number(params.get('limit')) : Math.min(20, coll.max_limit);
  if (!/^\d+$/.test(params.get('limit') ?? '1') || !Number.isInteger(limit) || limit < 1 || limit > coll.max_limit)
    throw bad('limit', `Between 1 and ${coll.max_limit}.`);
  const print = queryPrint(path, params);
  const offset = readCursor(params, print);
  const count = params.get('count');
  if (count !== null && count !== 'true' && count !== 'false') throw bad('count', 'Use true or false.');
  if (count === 'true' && !coll.count) throw unsupported('count');
  const fields = parseFields(params, coll);
  const page = items.slice(offset, offset + limit);
  let next = null;
  if (offset + limit < items.length) {
    const q = new URLSearchParams(params);
    q.set('cursor', makeCursor(offset + limit, print));
    next = `${path}?${q}`; // always starts with "/" (section 3)
  }
  return {
    items: page.map((r) => pick(r, fields)), next,
    ...(count === 'true' && { total: items.length }),
    ...(count === 'true' && coll.count === 'estimated' && { total_estimated: true }),
  };
}

// ── writes: body, Merge Patch, conditional requests and Idempotency-Key ──────
async function readJson(req, types) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!types.includes(type))
    throw new Problem(415, 'unsupported_media_type', `Send ${types.join(' or ')}.`, {},
      types.includes('application/merge-patch+json') ? { 'Accept-Patch': 'application/merge-patch+json' } : {});
  let text = '';
  for await (const chunk of req) text += chunk;
  let v;
  try { v = JSON.parse(text); } catch {}
  if (isObject(v)) { // members starting with _ belong to Restep (_etag, _actions): a write ignores them (5.1)
    const body = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));
    return [body, v]; // [what the write applies, the body as sent, for the idempotency fingerprint]
  }
  throw new Problem(400, 'bad_request', 'The body is not a valid JSON object.');
}
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function mergePatch(target, patch) { // RFC 7396, section 2
  if (!isObject(patch)) return patch;
  const out = isObject(target) ? { ...target } : {}; // a non-object target is replaced by {} first
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}
const ptr = (f) => `/${f.replace(/~/g, '~0').replace(/\//g, '~1')}`; // a JSON Pointer to a member (RFC 6901)
function validate(coll, row, label) {
  const errors = [];
  for (const f of coll.required) if (row[f] === undefined || row[f] === null) errors.push({ pointer: ptr(f), code: 'required', detail: `${f} is required.` });
  for (const [f, v] of Object.entries(row)) {
    if (!Object.hasOwn(coll.types, f)) { errors.push({ pointer: ptr(f), code: 'unknown', detail: `There is no field ${f}.` }); continue; }
    const t = coll.types[f];
    if (v === null || f === 'id') continue;
    const ok = t === 'decimal' ? typeof v === 'string' && DECIMAL.test(v)
      : t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' : typeof v === 'string';
    if (ok && t === 'enum' && !coll.values[f].includes(v)) {
      errors.push({ pointer: ptr(f), code: 'format', detail: `${f} must be one of: ${coll.values[f].join(', ')}.` });
      continue;
    }
    if (!ok) errors.push({ pointer: ptr(f), code: 'type', detail: `${f} must be a ${t}${t === 'decimal' ? ' in a string, such as "18.50"' : ''}.` });
  }
  if (errors.length) throw invalid(errors, label);
}

// If-Match / If-None-Match lists (RFC 9110, 13.1): "*", strong and weak comparison.
const tags = (header) => (header ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const strongMatch = (header, tag) => tags(header).some((t) => t === '*' || (!t.startsWith('W/') && t === tag));
const weakMatch = (header, tag) => tags(header).some((t) => t === '*' || t.replace(/^W\//, '') === tag);

// Idempotency-Key: an sf-string (RFC 9651), scoped to the client and the target (7.1).
const idempotency = new Map(); // scope → { print, response, expires }. In production: a durable store.
const TTL = 24 * 3600 * 1000;
function idempotencyScope(req, path) {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return null;
  const m = raw.trim().match(/^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/);
  if (!m) throw new Problem(400, 'bad_request', 'Idempotency-Key must be a quoted string, such as "8e03978e-40d5".');
  const client = hash(req.headers.authorization ?? 'anonymous');
  return `${client} ${req.method} ${path} ${m[1]}`;
}
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v));

// ── Routing ───────────────────────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const params = url.searchParams;
  const segments = url.pathname.split('/').filter(Boolean);
  const [name, id, ...rest] = segments;
  const method = req.method;
  const read = method === 'GET' || method === 'HEAD';
  const prefer = /(^|[ ,;])return=minimal\b/.test(req.headers.prefer ?? '');
  const applied = prefer ? { 'Preference-Applied': 'return=minimal' } : {};

  // 4.4: the service status, outside the API (no profile links, no problem+json); public, it says only its status.
  if (url.pathname === STATUS) {
    if (!read) throw new Problem(405, 'method_not_allowed', 'Only GET and HEAD.', {}, { Allow: 'GET, HEAD' });
    res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' });
    return res.end(method === 'HEAD' ? undefined : JSON.stringify({ status: 'pass' }));
  }
  // oauth (10.5): the metadata is public, is not a resource of the API and never gives 401.
  if (TOKEN && url.pathname === METADATA) {
    if (!read) throw new Problem(405, 'method_not_allowed', 'Only GET and HEAD.', {}, { Allow: 'GET, HEAD' });
    const meta = { resource: `http://${req.headers.host}/`, authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['books:read', 'books:write'], bearer_methods_supported: ['header'] };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    return res.end(method === 'HEAD' ? undefined : JSON.stringify(meta));
  }
  const bearer = /^bearer +(\S+)$/i.exec(req.headers.authorization ?? ''); // the scheme ignores case (RFC 9110, 11.1)
  if (TOKEN && bearer?.[1] !== TOKEN) {
    // RFC 6750, 3: a challenge carries at least one parameter, and a wrong token says invalid_token.
    // Only the exact root points at the metadata: its resource is the root (RFC 9728, 3.3).
    const sent = bearer ? ', error="invalid_token"' : ''; // no error code for another scheme (RFC 6750, 3.1)
    const challenge = req.url !== '/' ? `Bearer realm="restep"${sent}`
      : `Bearer realm="restep", resource_metadata="http://${req.headers.host}${METADATA}"${sent}`;
    throw new Problem(401, 'unauthenticated', 'Send Authorization: Bearer with a valid token.', {}, { 'WWW-Authenticate': challenge });
  }

  if (!name) { // Discovery document, at the API root
    if (!read) throw new Problem(405, 'method_not_allowed', 'Only GET and HEAD.', {}, { Allow: 'GET, HEAD' });
    for (const key of new Set(params.keys())) if (isReserved(reservedName(key))) throw unsupported(key);
    const collections = Object.fromEntries(Object.entries(db).map(([n, c]) => [n, {
      path: `/${n}`, description: c.description, methods: c.methods, item_methods: c.item_methods,
      schemas: schemas(c), max_limit: c.max_limit, count: c.count, sort: c.sort,
      filter: Object.fromEntries(Object.entries(c.filter).map(([f, ops]) => [f, { type: c.types[f], ...(c.types[f] === 'enum' ? { values: c.values[f] } : {}), ops }])),
    }]));
    const doc = { restep: '1.0', version: '1', profiles: PROFILES, extensions: EXTENSIONS, idempotency: { ttl: TTL / 1000 }, status: STATUS, collections };
    const headers = { ETag: etag(doc), 'Cache-Control': 'public, max-age=300' };
    if (weakMatch(req.headers['if-none-match'], headers.ETag)) return send(res, 304, undefined, headers);
    return send(res, 200, doc, headers, method === 'HEAD');
  }
  const coll = Object.hasOwn(db, name) ? db[name] : undefined;
  if (!coll || rest.length || (id !== undefined && id.includes(':')))
    throw new Problem(404, 'not_found', `${url.pathname} does not exist.`);

  // 5.4: 404 comes before 400, so a missing item is reported before its parameters are looked at.
  if (id !== undefined && !coll.rows.has(id)) throw new Problem(404, 'not_found', `${url.pathname} does not exist.`);

  // 5.4: 405 comes before 400, so an unsupported method is reported before its parameters are looked at.
  const methods = [...(id === undefined ? coll.methods : coll.item_methods), 'HEAD'];
  if (!methods.includes(method))
    throw new Problem(405, 'method_not_allowed', `Supports ${methods.join(', ')}.`, {}, { Allow: methods.join(', ') });

  // 5.3: a reserved parameter this resource and method do not implement fails loudly.
  const allowed = !read ? [] : id === undefined ? ['filter', 'sort', 'fields', 'count', 'limit', 'cursor'] : ['fields'];
  for (const key of new Set(params.keys())) {
    const base = reservedName(key);
    if (!isReserved(base)) continue; // non-reserved parameters belong to the API
    if (!allowed.includes(base)) throw unsupported(key);
    if (base !== 'filter' && key !== base) throw unsupported(key); // only filter has bracketed forms
    if (params.getAll(key).length > 1) throw bad(key, `Send ${key} once.`);
  }
  const location = (r) => `/${name}/${r.id}`;

  if (read) {
    let data, tag;
    if (id === undefined) { data = list(coll, params, url.pathname); tag = etag(data); }
    else if (coll.rows.has(id)) {
      const row = coll.rows.get(id), fields = parseFields(params, coll);
      // The ETag header validates the representation sent; If-Match uses the item's ETag (7.2),
      // which a partial representation carries in _etag.
      data = fields ? { ...pick(row, fields), _etag: etag(row) } : row;
      tag = etag(data);
    }
    else throw new Problem(404, 'not_found', `${url.pathname} does not exist.`);
    const headers = { ETag: tag, 'Cache-Control': 'no-cache' };
    const itemTag = id === undefined ? tag : etag(coll.rows.get(id));
    if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], itemTag))
      throw new Problem(412, 'precondition_failed', 'If-Match does not match the current representation.');
    if (weakMatch(req.headers['if-none-match'], tag)) return send(res, 304, undefined, headers);
    return send(res, 200, data, headers, method === 'HEAD');
  }

  if (id === undefined) {
    const scope = idempotencyScope(req, url.pathname);
    const [body, sent] = await readJson(req, ['application/json']);
    // From here to the end of the request there is no await: check and write are atomic.
    // 7.1: a replay returns the stored response; preconditions were evaluated for the first request only.
    const print = scope && hash(canonical(sent));
    const saved = scope && idempotency.get(scope);
    const live = saved && saved.expires > Date.now() ? saved : null;
    if (live && live.print === print)
      return send(res, ...live.response.slice(0, 2), { ...live.response[2], 'Idempotent-Replayed': 'true' });
    // 5.4: 412 comes before 422, so preconditions are checked before a key reused with another body.
    const collTag = etag(list(coll, new URLSearchParams(), url.pathname));
    if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], collTag))
      throw new Problem(412, 'precondition_failed', 'If-Match does not match the current collection.');
    if (weakMatch(req.headers['if-none-match'], collTag))
      throw new Problem(412, 'precondition_failed', 'If-None-Match matches the current collection.');
    if (live) throw new Problem(422, 'idempotency_mismatch', 'That Idempotency-Key was already used with a different request.');
    if ('id' in body) throw invalid([{ pointer: '/id', code: 'read_only', detail: 'The server assigns id.' }]);
    validate(coll, body, 'Invalid data.');
    const row = { ...body, id: String(nextId++) };
    coll.rows.set(row.id, row);
    const response = [201, prefer ? undefined : row, { Location: location(row), ETag: etag(row), ...applied }];
    if (scope) idempotency.set(scope, { print, response, expires: Date.now() + TTL });
    return send(res, ...response);
  }

  const [patch] = method === 'PATCH' ? await readJson(req, ['application/merge-patch+json', 'application/json']) : [null];
  // No await from here on: the If-Match check and the write are atomic (7.2).
  const current = coll.rows.get(id);
  if (!current) throw new Problem(404, 'not_found', `${url.pathname} does not exist.`);
  const ifMatch = req.headers['if-match'];
  if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))
    throw new Problem(412, 'precondition_failed', 'Someone changed it: read it again before writing.');
  if (weakMatch(req.headers['if-none-match'], etag(current)))
    throw new Problem(412, 'precondition_failed', 'If-None-Match matches the current item.');
  if (method === 'DELETE') { coll.rows.delete(id); return send(res, 204); }
  if ('id' in patch && patch.id !== id) throw invalid([{ pointer: '/id', code: 'read_only', detail: 'id cannot change.' }]);
  // 4.3: the patch itself must fit schemas.update, so an unknown member is rejected even when it is null.
  const unknown = Object.keys(patch).filter((f) => !f.startsWith('_') && !Object.hasOwn(coll.types, f));
  if (unknown.length) throw invalid(unknown.map((f) => ({ pointer: ptr(f), code: 'unknown', detail: `There is no field ${f}.` })));
  const row = { ...mergePatch(current, patch), id };
  validate(coll, row, 'The result of the patch is not valid.');
  coll.rows.set(id, row);
  return send(res, prefer ? 204 : 200, prefer ? undefined : row, { ETag: etag(row), ...applied });
}

const port = Number(process.env.PORT ?? 8080);
createServer((req, res) => handle(req, res).catch((e) => {
  if (!(e instanceof Problem)) { console.error(e); e = new Problem(500, 'internal', 'Something went wrong on the server.'); }
  if (!res.headersSent) problem(res, e, req.method);
})).listen(port, () => console.log(`Restep 1 (${[...PROFILES, ...EXTENSIONS].join(', ')}) on http://localhost:${port}/`));
