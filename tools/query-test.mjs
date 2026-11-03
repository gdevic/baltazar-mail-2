// Unit test for ext/query.js with the Yahoo dialect against a fake server with Yahoo's measured
// semantics: keyword terms OR together, field filters AND with them, negated keywords/senders are
// rejected, id:(...) ANDs with everything. node tools/query-test.mjs
import { parse, nativeQuery as native, evaluate as evaluateWith, describe, CAP } from "../ext/query.js";
import { createRequire } from "node:module";
createRequire(import.meta.url)("./build.js").build("yahoo");
const { dialect } = await import("../dist/baltazar-mail-yahoo/api.js");
const nativeQuery = ast => native(ast, dialect);
const evaluate = (ast, run, scope = "") => evaluateWith(ast, run, scope, dialect);

const mail = [
  { id: "m1", from: "alex@x.com", to: "me", subject: "Picture from Oslo", body: "alex picture oslo", date: 10, att: true, flagged: false, read: true },
  { id: "m2", from: "alex@x.com", to: "me", subject: "Meeting", body: "alex meeting budget", date: 9, att: false, flagged: true, read: true },
  { id: "m3", from: "sam@x.com", to: "me", subject: "Photo", body: "photo picture", date: 8, att: true, flagged: false, read: false },
  { id: "m4", from: "bob@x.com", to: "me", subject: "Picture day", body: "picture alex spam", date: 7, att: false, flagged: false, read: true },
  { id: "m5", from: "bob@x.com", to: "me", subject: "Nothing", body: "unrelated", date: 6, att: false, flagged: false, read: true },
];
const calls = [];
function server(query, count) {
  calls.push(query);
  // tokens: keyword:x keyword:"a b" from:("x") to:("x") subject:"x" has:attachment -has:attachment is:flagged ... id:(a OR b)
  const toks = query.match(/-?[a-z]+:(\("[^"]*"\)|\([^)]*\)|"[^"]*"|\S+)/g) || [];
  const kws = [], filters = [];
  for (const t of toks) {
    const neg = t.startsWith("-"), [, f, raw] = t.replace(/^-/, "").match(/^([a-z]+):(.*)$/);
    const v = raw.replace(/^\("?|"?\)$/g, "").replace(/^"|"$/g, "").toLowerCase();
    if (f === "keyword") { if (neg) throw new Error("ET-5006"); kws.push(v); continue; }
    if (neg && (f === "from" || f === "to" || f === "subject")) throw new Error("ET-5006");
    let p;
    if (f === "from") p = m => m.from.includes(v);
    else if (f === "to") p = m => m.to.includes(v);
    else if (f === "subject") p = m => m.subject.toLowerCase().includes(v);
    else if (f === "has") p = m => m.att;
    else if (f === "is") p = v === "flagged" ? m => m.flagged : v === "unread" ? m => !m.read : m => m.read;
    else if (f === "id") { const ids = raw.slice(1, -1).split(" OR "); p = m => ids.includes(m.id); }
    else if (f === "folderid") p = () => true;
    else throw new Error("unknown field " + f);
    filters.push(neg ? m => !p(m) : p);
  }
  const text = m => `${m.subject} ${m.body} ${m.from} ${m.to}`.toLowerCase();
  return mail.filter(m => filters.every(p => p(m)) && (!kws.length || kws.some(k => text(m).includes(k))))
    .sort((a, b) => b.date - a.date).slice(0, count).map(m => ({ id: m.id, headers: { date: String(m.date), subject: m.subject } }));
}
const run = async (q, count) => server(q, count);

let fail = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : "  want " + JSON.stringify(want)}`); };
const ids = async s => { const ast = parse(s); const nq = nativeQuery(ast); return nq ? server(nq, CAP).map(m => m.id) : (await evaluate(ast, run)).messages.map(m => m.id); };

check("native single", nativeQuery(parse("alex")), "keyword:alex");
check("native OR", nativeQuery(parse("alex OR picture")), "keyword:alex keyword:picture");
check("native fields+kw", nativeQuery(parse("from:alex has:attachment picture")), 'from:("alex") has:attachment keyword:picture');
check("native neg has", nativeQuery(parse("picture -has:attachment")), "-has:attachment keyword:picture");
check("needs eval: AND", nativeQuery(parse('"Alex" AND "Picture"')), null);
check("phrase", nativeQuery(parse('"alex picture"')), 'keyword:"alex picture"');
check("describe", describe(parse('alex (picture OR photo) -spam')), "alex AND (picture OR photo) AND NOT spam");
check("operators lowercase are words", describe(parse("alex and picture")), "alex AND and AND picture");
check("unbalanced", describe(parse("(alex OR picture")), "alex OR picture");
check("colon word", nativeQuery(parse("http://x.com")), 'keyword:"http://x.com"');
check("dates", nativeQuery(parse("after:2026/1/5 alex")), "after:2026-01-05 keyword:alex");
check("not after", nativeQuery(parse("-after:2026-01-05 alex")), "before:2026-01-05 keyword:alex");

check("AND", await ids('"Alex" AND "Picture"'), ["m1", "m4"]);
check("implicit AND", await ids("alex picture"), ["m1", "m4"]);
check("OR", await ids("oslo OR meeting"), ["m1", "m2"]);
check("AND+OR", await ids("alex (oslo OR meeting)"), ["m1", "m2"]);
check("NOT keyword", await ids("picture -alex"), ["m3"]);
check("NOT word", await ids("picture NOT spam"), ["m1", "m3"]);
check("NOT from", await ids("picture -from:bob"), ["m1", "m3"]);
check("from AND kw AND kw", await ids("from:alex picture oslo"), ["m1"]);
check("two from (OR in parens)", await ids("(from:alex OR from:sam) picture"), ["m1", "m3"]);
check("starred", await ids("alex is:starred"), ["m2"]);
check("unread", await ids("is:unread"), ["m3"]);
check("NOT (a OR b)", await ids("picture NOT (spam OR oslo)"), ["m3"]);
check("minus before group", describe(parse("picture -(spam OR oslo)")), "picture AND NOT (spam OR oslo)");
check("minus before group ids", await ids("picture -(spam OR oslo)"), ["m3"]);
check("field before group", describe(parse("from:(alex OR sam)")), "from:alex OR from:sam");
check("field before group ids", await ids("from:(alex OR sam) picture"), ["m1", "m3"]);
check("negated field group", await ids("picture -from:(alex OR bob)"), ["m3"]);
check("field group keeps inner fields", describe(parse("from:(alex OR subject:x)")), "from:alex OR subject:x");
calls.length = 0;
await ids("alex picture oslo");
check("no negated keyword sent", calls.some(c => /-keyword|-from|-subject/.test(c)), false);
let threw = null; try { parse("(a OR b) (c OR d) (e OR f) (g OR h) (i OR j)"); nativeQuery(parse("(a OR b) (c OR d) (e OR f) (g OR h) (i OR j)")); } catch (e) { threw = e.message; }
check("complexity cap", !!threw, true);
// values a field does not know are refused, not searched as words
const err = f => { try { f(); return null; } catch (e) { return e.message; } };
check("unknown is:", /is:important/.test(err(() => nativeQuery(parse("is:important"))) || ""), true);
check("unknown date", /after:yesterday/.test(err(() => nativeQuery(parse("after:yesterday alex"))) || ""), true);
check("impossible date", /2026-02-30/.test(err(() => nativeQuery(parse("before:2026-02-30"))) || ""), true);
check("unknown has:", /has:pictures/.test(err(() => nativeQuery(parse("has:pictures"))) || ""), true);
check("valid date still fine", nativeQuery(parse("after:2024-02-29")), "after:2024-02-29");
// a quoted operator is a word; empty quotes and parentheses are nothing
check("quoted OR is a word", describe(parse('alex "OR" sam')), "alex AND OR AND sam");
check("quoted OR native", nativeQuery(parse('"OR"')), "keyword:OR");
check("empty parens in quotes", parse('"()"'), null);
check("empty quotes", parse('alex ""'), parse("alex"));
// very deep nesting is refused with a message instead of overflowing the stack
check("deep NOT", /nested too deeply/.test(err(() => parse("NOT ".repeat(3000) + "x")) || ""), true);
check("deep parens", /nested too deeply/.test(err(() => parse("(".repeat(3000) + "x")) || ""), true);
check("ordinary nesting", describe(parse("((a OR b) (c OR NOT d))")), "(a OR b) AND (c OR NOT d)");
// a long OR of fields is capped instead of firing one request per term
check("OR fan-out cap", /too many/.test(await evaluate(parse(Array.from({ length: 200 }, (_, i) => `from:u${i}`).join(" OR ")), run).then(() => "", e => e.message)), true);
{
  let live = 0, peak = 0;
  const slow = async (q, n) => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; return server(q, n); };
  await evaluate(parse(Array.from({ length: 12 }, (_, i) => `from:u${i}`).join(" OR ")), slow);
  check("at most 4 queries at once", peak <= 4, true);
}
console.log(fail ? `FAILED ${fail}` : "PASS");
process.exit(fail ? 1 : 0);
