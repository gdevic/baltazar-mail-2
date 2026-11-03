// Search query language. Words are ANDed; AND, OR, NOT (or a leading -), parentheses and
// "quoted phrases" combine them; field terms narrow: from: to: subject: has:attachment
// is:starred is:unread is:read after:YYYY-MM-DD before:YYYY-MM-DD.
//
// The provider's adapter supplies the dialect that writes terms in its own search language:
// { atom(term, neg) } gives one term (or its negation), or null when the provider cannot express
// it, and throws for a value the field does not know; compile(ast), when present, writes a whole
// query, for a provider whose search takes any boolean query.
//
// Without compile the query is evaluated the way Yahoo's search needs: it ORs keyword terms, ANDs
// field filters with one keyword group, rejects negated keywords and senders, and ANDs an
// id:(...) list with any term. So a query is compiled to disjunctive normal form; each conjunction
// runs one native query (field filters plus its first keyword) and the remaining terms are applied
// exactly by asking which of those ids also (or do not) match them. Queries the provider can
// answer in one request go out unchanged and page.

const FIELDS = new Set(["from", "to", "subject", "has", "is", "after", "before"]);
export const CAP = 500;          // messages fetched per native query of a compound search
const MAX_CONJ = 16;
const MAX_DEPTH = 64;            // nesting of parentheses and NOT
const PARALLEL = 4;              // native queries in flight at once

// ---------- parsing ----------
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")") { out.push({ k: c }); i++; continue; }
    let neg = false;
    if (c === "-" && i + 1 < s.length && !/\s/.test(s[i + 1])) { neg = true; i++; }
    let field = null, value = "", phrase = false, quoted = false;
    const m = s.slice(i).match(/^([a-z]+):(?=\S)/i);
    if (m && FIELDS.has(m[1].toLowerCase())) { field = m[1].toLowerCase(); i += m[0].length; }
    if (s[i] === "(") {          // -( ... ) negates a group, field:( ... ) applies to its terms
      if (neg) out.push({ k: "NOT" });
      out.push({ k: "(", field });
      i++;
      continue;
    }
    if (s[i] === '"') {
      quoted = true;
      const end = s.indexOf('"', i + 1);
      value = s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 1;
      phrase = /\s/.test(value.trim());
    } else {
      const m2 = s.slice(i).match(/^[^\s()"]+/);
      value = m2 ? m2[0] : "";
      i += value.length;
    }
    value = value.trim();
    if (!field && !neg && !quoted && /^(AND|OR|NOT)$/.test(value)) { out.push({ k: value }); continue; }
    if (!clean(value)) continue;     // nothing searchable: "" or "()"
    const term = { t: "term", field, value, phrase };
    out.push({ k: "term", node: neg ? { t: "not", kid: term } : term });
  }
  return out;
}

// Gives every term without its own field the group's field.
function withField(n, field) {
  if (!n) return;
  if (n.t === "term") { if (!n.field) n.field = field; return; }
  if (n.t === "not") return withField(n.kid, field);
  for (const k of n.kids) withField(k, field);
}

export function parse(input) {
  const toks = tokenize(String(input || ""));
  let p = 0, depth = 0;
  const peek = () => toks[p]?.k;
  const deeper = () => { if (++depth > MAX_DEPTH) throw new Error("search is nested too deeply"); };
  function orExpr() {
    const kids = [andExpr()].filter(Boolean);
    while (peek() === "OR") { p++; const k = andExpr(); if (k) kids.push(k); }
    return kids.length > 1 ? { t: "or", kids } : kids[0] || null;
  }
  function andExpr() {
    const kids = [];
    for (;;) {
      const k = peek();
      if (k === undefined || k === ")" || k === "OR") break;
      if (k === "AND") { p++; continue; }
      const u = unary();
      if (u) kids.push(u);
    }
    return kids.length > 1 ? { t: "and", kids } : kids[0] || null;
  }
  function unary() {
    if (peek() === "NOT") { p++; deeper(); const u = unary(); depth--; return u ? { t: "not", kid: u } : null; }
    if (peek() === "(") {
      const field = toks[p++].field;
      deeper();
      const e = orExpr();
      depth--;
      if (peek() === ")") p++;
      if (field) withField(e, field);
      return e;
    }
    if (peek() === "term") return toks[p++].node;
    p++;            // stray ")"
    return null;
  }
  let ast = orExpr();
  while (p < toks.length) {   // text after an unmatched ")": AND it on
    p++;
    const more = orExpr();
    if (more) ast = ast ? { t: "and", kids: [ast, more] } : more;
  }
  return ast;
}

// ---------- term values, for the dialects ----------
// A value with the characters that would end a term taken out.
export const clean = v => v.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
// A real calendar date as YYYY-MM-DD, or null (2026-02-30 is not one).
export function isoDate(v) {
  const m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])], t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

const isKeyword = t => t.field === null;
const known = (t, d) => t.field === null || d.atom(t) !== null;

// Throws, with the reason, for a term whose field does not know its value (is:important).
export function check(node, d) {
  if (!node) return;
  if (node.t === "term") { if (node.field) d.atom(node); return; }
  if (node.t === "not") return check(node.kid, d);
  node.kids.forEach(k => check(k, d));
}

// ---------- normal form ----------
// Returns an array of conjunctions; each is an array of { term, neg }.
function dnf(node, neg = false) {
  if (!node) return [[]];
  if (node.t === "term") return [[{ term: node, neg }]];
  if (node.t === "not") return dnf(node.kid, !neg);
  const asAnd = (node.t === "and") !== neg;
  const parts = node.kids.map(k => dnf(k, neg));
  if (!asAnd) {
    const all = parts.flat();
    if (all.length > MAX_CONJ) throw new Error("search is too complex (too many alternatives joined by OR)");
    return all;
  }
  let acc = [[]];
  for (const p of parts) {
    const next = [];
    for (const a of acc) for (const b of p) next.push(a.concat(b));
    if (next.length > MAX_CONJ) throw new Error("query is too complex (too many OR combinations)");
    acc = next;
  }
  return acc;
}

// Splits a conjunction into what one native query can carry and what must be applied after.
function plan(conj, d) {
  const native = [], seenField = new Set(), verify = [], exclude = [];
  let keyword = null;
  for (const { term, neg } of conj) {
    if (!known(term, d)) { if (!neg) verify.push(term); else exclude.push(term); continue; }
    const a = d.atom(term, neg);
    if (neg) { if (a) native.push(a); else exclude.push(term); continue; }
    if (isKeyword(term)) { if (!keyword) keyword = term; else verify.push(term); continue; }
    const key = term.field === "is" || term.field === "has" ? a : term.field;
    if (seenField.has(key)) verify.push(term); else { seenField.add(key); native.push(a); }
  }
  return { native, keyword, verify, exclude };
}

// A query that is one native request: with a dialect that compiles whole queries, always;
// otherwise one with no AND among keywords and no negations the provider cannot do.
// Returns the query string, or null when it needs evaluation.
export function nativeQuery(ast, d) {
  if (!ast) return null;
  if (d.compile) return d.compile(ast);
  // OR of plain keywords: the provider's own keyword semantics.
  if (ast.t === "or" && ast.kids.every(k => k.t === "term" && isKeyword(k))) return ast.kids.map(k => d.atom(k)).join(" ");
  const conjs = dnf(ast);
  if (conjs.length !== 1) return null;
  const p = plan(conjs[0], d);
  if (p.verify.length || p.exclude.length) return null;
  return [...p.native, p.keyword ? d.atom(p.keyword) : null].filter(Boolean).join(" ") || null;
}

// ---------- evaluation ----------
// fn with at most n calls running at once; the rest wait their turn.
function limited(fn, n) {
  let live = 0;
  const queue = [];
  const next = () => { if (live < n && queue.length) { live++; queue.shift()(); } };
  return (...args) => new Promise((ok, no) => {
    queue.push(() => Promise.resolve().then(() => fn(...args)).then(ok, no).finally(() => { live--; next(); }));
    next();
  });
}
// run(query, count) -> Promise<message[]> runs one query in the provider's language (scope
// already applied by the caller for base queries; id-filter queries need none).
// Returns { messages, truncated }.
export async function evaluate(ast, run, scope = "", d) {
  const conjs = dnf(ast);
  let truncated = false;
  const byId = new Map();
  run = limited(run, PARALLEL);
  await Promise.all(conjs.map(async conj => {
    const p = plan(conj, d);
    const fixed = [scope, ...p.native].filter(Boolean).join(" ");
    let base;
    if (p.keyword && p.verify.some(isKeyword)) {
      // Several keywords: fetch each, keep the smallest list as the base (complete if under CAP).
      const kws = [p.keyword, ...p.verify.filter(isKeyword)];
      const lists = await Promise.all(kws.map(k => run(`${fixed} ${d.atom(k)}`, CAP).then(m => ({ k, m }))));
      lists.sort((a, b) => a.m.length - b.m.length);
      base = lists[0].m;
      p.verify = p.verify.filter(t => t !== lists[0].k).concat(lists[0].k === p.keyword ? [] : [p.keyword]);
    } else {
      base = await run([fixed, p.keyword ? d.atom(p.keyword) : ""].filter(Boolean).join(" "), CAP);
    }
    if (base.length >= CAP) truncated = true;
    let ids = base.map(m => m.id);
    const idq = () => `id:(${ids.join(" OR ")})`;
    for (const t of p.verify) {
      if (!ids.length) break;
      const a = d.atom(t) || `keyword:"${clean(t.value)}"`;
      const hit = new Set((await run(`${idq()} ${a}`, ids.length)).map(m => m.id));
      ids = ids.filter(id => hit.has(id));
    }
    for (const t of p.exclude) {
      if (!ids.length) break;
      const a = d.atom(t) || `keyword:"${clean(t.value)}"`;
      const hit = new Set((await run(`${idq()} ${a}`, ids.length)).map(m => m.id));
      ids = ids.filter(id => !hit.has(id));
    }
    const keep = new Set(ids);
    for (const m of base) if (keep.has(m.id)) byId.set(m.id, m);
  }));
  const messages = [...byId.values()].sort((a, b) => Number(b.headers?.date || 0) - Number(a.headers?.date || 0));
  return { messages, truncated };
}

// Human-readable form of the parsed query, for the list title and tooltips.
export function describe(ast) {
  if (!ast) return "";
  const term = t => (t.field ? `${t.field}:` : "") + (t.phrase || /\s/.test(t.value) ? `"${t.value}"` : t.value);
  const walk = (n, top) => {
    if (n.t === "term") return term(n);
    if (n.t === "not") return `NOT ${walk(n.kid)}`;
    const s = n.kids.map(k => walk(k)).join(n.t === "and" ? " AND " : " OR ");
    return top ? s : `(${s})`;
  };
  return walk(ast, true);
}
