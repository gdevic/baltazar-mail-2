// Unit tests for the Gmail adapter: the RFC 822 builder read back through ext/mime.js, the
// address parser, and the built adapter (dist/baltazar-mail-gmail/api.js) against the Gmail of
// gmail-mock.js, reached through fetch, with chrome mocked around it. node tools/gmail-test.mjs
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { build, parseAddresses, messageIdOf, rfcDate } from "../gmail/rfc822.js";
import { listParts, extract } from "../ext/mime.js";
import { parse, nativeQuery, check } from "../ext/query.js";

const require = createRequire(import.meta.url);
const { createGmail, FX } = require("./gmail-mock.js");

let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
const text = b => new TextDecoder().decode(b);
const headersOf = raw => { const h = {}; for (const line of text(raw).split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ").split("\r\n")) { const c = line.indexOf(":"); if (c > 0) h[line.slice(0, c).toLowerCase()] = line.slice(c + 1).trim(); } return h; };

// ---------- build ----------
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 1, 2, 3]);
  const raw = await build({
    from: { name: "Me, Myself", email: "me@x.com" }, to: [{ name: "Ann", email: "ann@x.com" }, { email: "bob@x.com" }], cc: [{ name: "Zoë", email: "z@x.com" }],
    subject: "Re: Budget — résumé", date: "Mon, 02 Nov 2026 10:00:00 +0000", messageId: "m1@baltazar-mail", inReplyTo: "<orig@x.com>", references: "<a@x.com> <orig@x.com>",
    html: "<p>Hello <img src=\"cid:img1@baltazar-mail\"> there = here</p>\n<p>" + "x".repeat(200) + "</p>\n",
    inline: [{ file: { name: "inline-1.png", type: "image/png", bytes: png }, contentId: "img1@baltazar-mail" }],
    files: [new File([new TextEncoder().encode("name,qty\nZ80,2\n")], "data.csv", { type: "text/csv" }), { name: "été.pdf", type: "application/pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }],
  });
  const h = headersOf(raw);
  ok(h.from === '"Me, Myself" <me@x.com>', "a name with a comma is quoted: " + h.from);
  ok(h.to === "Ann <ann@x.com>, bob@x.com", "address list folded and joined: " + h.to);
  ok(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <z@x.com>$/.test(h.cc), "non-ASCII name as an encoded word: " + h.cc);
  ok(/^=\?utf-8\?B\?/.test(h.subject) && !/[^\x20-\x7e]/.test(h.subject), "non-ASCII subject encoded: " + h.subject);
  ok(h["message-id"] === "<m1@baltazar-mail>" && h["in-reply-to"] === "<orig@x.com>" && h.references === "<a@x.com> <orig@x.com>", "threading headers: " + JSON.stringify([h["message-id"], h["in-reply-to"], h.references]));
  ok(h["mime-version"] === "1.0" && h.date === "Mon, 02 Nov 2026 10:00:00 +0000", "date and MIME version");
  ok(!/[^\x00-\x7f]/.test(text(raw)), "the whole message is 7-bit");
  ok(text(raw).split("\r\n").every(l => l.length <= 998) && !/[^\r]\n/.test(text(raw)), "CRLF line ends, no overlong line");
  const parsed = listParts(raw);
  const names = parsed.parts.map(p => [p.partId, p.type, p.filename]);
  ok(JSON.stringify(names) === JSON.stringify([["1.1", "text/html", ""], ["1.2", "image/png", "inline-1.png"], ["2", "text/csv", "data.csv"], ["3", "application/pdf", "été.pdf"]]), "mixed holds related holds html + inline: " + JSON.stringify(names));
  const html = text(extract(parsed, "1.1").bytes);
  ok(html.includes('<img src="cid:img1@baltazar-mail">') && html.includes("there = here") && html.includes("x".repeat(200)), "HTML survives quoted-printable: " + html.slice(0, 80));
  ok(text(raw).includes("Content-ID: <img1@baltazar-mail>") && /Content-Disposition: inline; filename="inline-1.png"/.test(text(raw)), "inline part carries its Content-ID and disposition");
  ok(JSON.stringify([...extract(parsed, "1.2").bytes]) === JSON.stringify([...png]), "inline bytes round-trip");
  ok(text(extract(parsed, "2").bytes) === "name,qty\nZ80,2\n", "a File attachment round-trips");
  ok(/filename\*=utf-8''%C3%A9t%C3%A9\.pdf/.test(text(raw)), "non-ASCII file name in RFC 2231 form");
}
// a plain-text message is one entity, with trailing white space protected
{
  const raw = await build({ from: { email: "me@x.com" }, to: [{ email: "a@x.com" }], subject: "plain", text: "line one \nline two\n" + "é".repeat(60) });
  const h = headersOf(raw);
  ok(h["content-type"] === "text/plain; charset=utf-8" && h["content-transfer-encoding"] === "quoted-printable", "plain text entity: " + h["content-type"]);
  ok(!("reply-to" in h) && !("cc" in h), "no empty headers");
  const parsed = listParts(raw);
  ok(parsed.parts.length === 1 && text(extract(parsed, "1").bytes) === "line one \r\nline two\r\n" + "é".repeat(60), "text round-trips with CRLF and soft breaks");
  ok(text(raw).split("\r\n").every(l => l.length <= 76), "quoted-printable lines stay short");
}
// a Reply-To that differs from From is written; one equal to From is not
{
  const a = headersOf(await build({ from: { email: "me@x.com" }, replyTo: { email: "other@x.com" }, subject: "s", text: "" }));
  const b = headersOf(await build({ from: { email: "me@x.com" }, replyTo: { email: "me@x.com" }, subject: "s", text: "" }));
  ok(a["reply-to"] === "other@x.com" && !("reply-to" in b), "Reply-To only when it differs");
  ok(/^<[0-9a-f-]{36}@baltazar-mail>$/.test(a["message-id"]), "a Message-ID is made up when none is given: " + a["message-id"]);
}
ok(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/.test(rfcDate(new Date(0))), "rfcDate: " + rfcDate(new Date(0)));

// ---------- parseAddresses ----------
const addrs = s => JSON.stringify(parseAddresses(s));
ok(addrs('"Doe, John" <john@x.com>, ann@x.com, <bob@x.com>') === JSON.stringify([{ name: "Doe, John", email: "john@x.com" }, { name: "", email: "ann@x.com" }, { name: "", email: "bob@x.com" }]), "quoted name with comma, bare, bracketed: " + addrs('"Doe, John" <john@x.com>, ann@x.com, <bob@x.com>'));
ok(addrs("=?UTF-8?B?Wm/DqyBRdcOpYmVj?= <z@x.com>") === JSON.stringify([{ name: "Zoë Québec", email: "z@x.com" }]), "encoded word name: " + addrs("=?UTF-8?B?Wm/DqyBRdcOpYmVj?= <z@x.com>"));
ok(addrs("=?utf-8?q?Caf=C3=A9_Team?= <c@x.com>") === JSON.stringify([{ name: "Café Team", email: "c@x.com" }]), "Q-encoded name: " + addrs("=?utf-8?q?Caf=C3=A9_Team?= <c@x.com>"));
ok(addrs("ann@x.com (Ann Example), Bob <bob@x.com> (comment)") === JSON.stringify([{ name: "", email: "ann@x.com" }, { name: "Bob", email: "bob@x.com" }]), "comments dropped: " + addrs("ann@x.com (Ann Example), Bob <bob@x.com> (comment)"));
ok(addrs("Team: a@x.com, \"B, C\" <b@x.com>; d@x.com") === JSON.stringify([{ name: "", email: "a@x.com" }, { name: "B, C", email: "b@x.com" }, { name: "", email: "d@x.com" }]), "group members, name dropped: " + addrs("Team: a@x.com, \"B, C\" <b@x.com>; d@x.com"));
ok(addrs("undisclosed-recipients:;") === "[]" && addrs("") === "[]" && addrs("MAILER-DAEMON") === "[]", "empty group and non-addresses give nothing");
ok(addrs('"Esc \\"q\\" \\\\" <e@x.com>') === JSON.stringify([{ name: 'Esc "q" \\', email: "e@x.com" }]), "escapes in a quoted name: " + addrs('"Esc \\"q\\" \\\\" <e@x.com>'));
ok(addrs("Plain Name <mailto:p@x.com>") === JSON.stringify([{ name: "Plain Name", email: "p@x.com" }]), "mailto: stripped");
ok(messageIdOf(" <abc@x.com> ") === "<abc@x.com>" && messageIdOf("none") === "", "messageIdOf");

// ---------- the adapter, built ----------
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [path.join(ROOT, "tools", "build.js"), "gmail"], { stdio: "ignore" });

// chrome: session storage, the manifest with a client id, and a Google sign-in window that answers
// a token (silently only when the test allows it).
const store = {}, local = {};
const flows = [];
let silentOk = false, tokens = 0;
const area = o => ({ get: async k => ({ [k]: o[k] }), set: async x => Object.assign(o, x), remove: async k => { delete o[k]; } });
globalThis.chrome = {
  storage: { session: area(store), local: area(local) },
  runtime: { getManifest: () => ({ name: "Baltazar Mail for Gmail", version: "0.18.0", oauth2: { client_id: "cid.apps.googleusercontent.com" } }) },
  identity: {
    getRedirectURL: () => "https://extid.chromiumapp.org/",
    launchWebAuthFlow: async ({ url, interactive }) => {
      flows.push({ interactive, url });
      const u = new URL(url);
      if (!interactive && !silentOk) throw new Error("The user did not approve access.");
      return `https://extid.chromiumapp.org/#access_token=tok${++tokens}&token_type=Bearer&expires_in=3600&state=${u.searchParams.get("state")}`;
    },
  },
};
// FileReader, for the data: URLs the adapter makes of images
globalThis.FileReader = class { readAsDataURL(blob) { blob.arrayBuffer().then(b => { this.result = `data:${blob.type};base64,${Buffer.from(b).toString("base64")}`; this.onload?.(); }); } };

const gm = createGmail({ mime: { listParts, extract } });
const mock = gm.state;
globalThis.fetch = async (url, init = {}) => {
  const method = init.method || "GET", headers = init.headers || {};
  let body = init.body;
  if (body instanceof Blob) body = Buffer.from(await body.arrayBuffer()).toString("latin1");
  const r = gm.respond(method, String(url), body, headers);
  if (r.text != null) return new Response(r.text, { status: r.status, headers: { "content-type": r.contentType } });
  return new Response(r.json == null ? null : JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
};

const api = await import("../dist/baltazar-mail-gmail/api.js");
const outcome = async p => { try { return { value: await p }; } catch (e) { return { e }; } };
const lastCall = (method, re) => [...mock.calls].reverse().find(c => c.method === method && re.test(c.path));
const labelsOf = id => mock.messages.get(id).labelIds;
// label changes as { ids, addLabelIds, removeLabelIds }, made one message each or in bulk
const modsOf = () => mock.calls.filter(c => c.path === "/messages/batchModify" || /^\/messages\/[^/]+\/modify$/.test(c.path)).map(c => c.path.endsWith("/modify") ? { ids: [c.path.split("/")[2]], ...c.body, single: true } : c.body);
const lastMod = () => modsOf().at(-1);

// search dialect: the whole query in Gmail's language
{
  const nq = s => nativeQuery(parse(s), api.dialect);
  ok(nq("alex (picture OR photo) -spam from:bob after:2026-01-05 is:unread -has:attachment") === "alex (picture OR photo) -spam from:bob after:2026/01/05 is:unread -has:attachment", "compiled query: " + nq("alex (picture OR photo) -spam from:bob after:2026-01-05 is:unread -has:attachment"));
  ok(nq("-(a OR b) c") === "-a -b c" && nq("NOT (a b)") === "-a OR -b" && nq("(a b) OR c") === "(a b) OR c" && nq('"quarterly review" subject:"x y"') === '"quarterly review" subject:"x y"', "De Morgan, grouping and phrases: " + JSON.stringify([nq("-(a OR b) c"), nq("NOT (a b)"), nq("(a b) OR c"), nq('"quarterly review" subject:"x y"')]));
  ok(nq('"Alex" AND "Picture"') === "Alex Picture" && nq("-is:unread -after:2026-02-01") === "is:read before:2026/02/01", "AND of words needs no evaluation; negations flip: " + JSON.stringify([nq('"Alex" AND "Picture"'), nq("-is:unread -after:2026-02-01")]));
  let err = ""; try { check(parse("is:important"), api.dialect); } catch (e) { err = e.message; }
  ok(/is:important/.test(err), "unknown is: refused: " + err);
  ok(api.queries.starred(true) === "is:starred is:unread" && api.queries.person('a@x.com") OR x') === "(from:a@x.comORx OR to:a@x.comORx OR cc:a@x.comORx)", "named queries, with only address characters: " + api.queries.person('a@x.com") OR x'));
}
// batch encoding and decoding
{
  const enc = api.encodeBatch([{ method: "GET", path: "/labels/INBOX", query: { fields: "id,messagesTotal" } }, { method: "POST", path: "/messages/batchModify", json: { ids: ["a"] } }], "B");
  ok(enc.includes("GET /gmail/v1/users/me/labels/INBOX?fields=id%2CmessagesTotal HTTP/1.1") && enc.includes('{"ids":["a"]}') && enc.endsWith("--B--\r\n"), "batch request parts: " + enc.slice(0, 200));
  const dec = api.decodeBatch(`--R\r\nContent-Type: application/http\r\nContent-ID: <response-item1>\r\n\r\nHTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"error":{"code":404}}\r\n--R\r\nContent-Type: application/http\r\nContent-ID: <response-item0>\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{"id":"INBOX","messagesTotal":10}\r\n--R--\r\n`, "R", 2);
  ok(dec[0].status === 200 && dec[0].json.messagesTotal === 10 && dec[1].status === 404 && dec[1].json.error.code === 404, "answers matched to their items by Content-ID: " + JSON.stringify(dec));
}
// sign-in: nothing opens by itself; the button does, and the token is kept
{
  const a = await outcome(api.bootstrap());
  ok(a.e instanceof api.NotSignedIn && flows.length === 0, "with no account signed in, nothing is tried and no window opens: " + JSON.stringify({ e: a.e?.name, flows: flows.length }));
  const s = await api.signIn();
  ok(s.email === "me@gmail.com" && flows.length === 1 && flows[0].interactive && /prompt=select_account\+consent/.test(flows[0].url) && store.gmToken?.access_token === "tok1" && local.gmAccount === "me@gmail.com", "the sign-in button opens Google's window and keeps the token and the account: " + JSON.stringify({ s, token: store.gmToken, local }));
  const b = await api.bootstrap();
  ok(b.email === "me@gmail.com" && flows.length === 1, "a stored token is reused without a flow");
}
// folders: labels become folders; counts come in one batch; All Mail stands for the archive
{
  const r = await api.folders();
  const f = Object.fromEntries(r.folders.map(x => [x.id, x]));
  ok(r.folders.map(x => x.id).join() === "INBOX,SENT,DRAFT,TRASH,SPAM,Label_1,Label_2,Label_3,Label_4,Label_5,ALL", "folder list: " + r.folders.map(x => x.id).join());
  ok(f.INBOX.types[0] === "INBOX" && f.INBOX.name === "Inbox" && f.INBOX.unread === 4 && f.INBOX.total === 8 && f.SPAM.types[0] === "BULK" && f.DRAFT.types[0] === "DRAFT" && f.DRAFT.total === 1, "system folders: " + JSON.stringify(f.INBOX));
  ok(f.Label_2.name === "Projects/FPGA" && f.Label_2.types.join() === "USER" && f.Label_2.total === 3 && f.Label_3.types.join() === "USER,INVISIBLE", "user labels as paths; hidden ones invisible");
  ok(f.ALL.types[0] === "ARCHIVE" && f.ALL.name === "All Mail" && f.ALL.total === mock.messages.size, "All Mail: " + JSON.stringify(f.ALL));
  ok(mock.calls.filter(c => c.path === "/labels").length === 1 && mock.calls.filter(c => /^\/labels\//.test(c.path)).length === 10, "counts through one batch, one get per shown label");
  // history: a change touching Projects stamps it, and All Mail, but not FPGA
  const before = Object.fromEntries(r.folders.map(x => [x.id, x.highestModSeq]));
  mock.history.push({ id: "1001", labelsAdded: [{ message: { id: "p2", labelIds: ["Label_1", "STARRED"] }, labelIds: ["STARRED"] }] });
  mock.profile.historyId = "1001"; mock.nextHistory = 1002;
  const r2 = await api.folders();
  const after = Object.fromEntries(r2.folders.map(x => [x.id, x.highestModSeq]));
  ok(after.Label_1 !== before.Label_1 && after.ALL !== before.ALL && after.Label_2 === before.Label_2 && after.SENT === before.SENT, "history stamps the labels it names: " + JSON.stringify({ before, after }));
  ok(lastCall("GET", /^\/history$/).q.startHistoryId === "1000", "history is asked from the last id seen");
  // a count change alone also stamps
  mock.addMessage({ id: "s9", labels: ["SENT"], subject: "Subject s-9", from: "Me <me@gmail.com>" });
  const r3 = await api.folders();
  ok(r3.folders.find(x => x.id === "SENT").highestModSeq !== after.SENT, "a changed count stamps the folder");
  // a history Gmail no longer has stamps everything once
  mock.historyGone = true; mock.profile.historyId = "2000"; mock.nextHistory = 2001;
  const r4 = await api.folders();
  ok(r4.folders.every(x => /^2000:all/.test(String(x.highestModSeq))), "expired history stamps every folder: " + r4.folders[0].highestModSeq);
  mock.historyGone = false;
  // a label whose counts Gmail refuses inside the batch keeps the counts it had, unstamped; one
  // refused once is asked again
  const r5 = await api.folders();
  mock.failItems = { status: 503, times: 99, match: /\/labels\/INBOX/ };
  const r6 = await api.folders();
  mock.failItems = { status: 429, times: 1, match: /\/labels\/INBOX/ };
  const r7 = await api.folders();
  const left = mock.failItems.times;
  mock.failItems = null;
  const [i5, i6, i7] = [r5, r6, r7].map(x => x.folders.find(f => f.id === "INBOX"));
  ok(i6.unread === i5.unread && i6.total === i5.total && i6.highestModSeq === i5.highestModSeq, "failed counts keep the last ones: " + JSON.stringify([i5, i6]));
  ok(left === 0 && i7.unread === i5.unread && i7.total === i5.total, "a refused item is asked again: " + JSON.stringify(i7));
}
// lists: rows in the client's shape, paged by offset over Gmail's tokens
{
  const r = await api.list("INBOX", 3, 0);
  const m = r.messages[0];
  ok(r.messages.map(x => x.id).join() === "m1,m2,m3" && m.headers.subject === "Subject m-1" && m.headers.from[0].name === "Sender 1" && m.headers.from[0].email === "s1@x.com" && Number(m.headers.date) === Math.floor(Number(mock.messages.get("m1").internalDate) / 1000) && m.flags.read === false && m.flags.flagged === false, "rows: " + JSON.stringify({ ids: r.messages.map(x => x.id), m }));
  ok(m.folder.id === "INBOX" && m.folder.name === "Inbox" && m.attachments.length === 1 && m.attachments[0].disposition === "inline" && m.attachmentCount === 0 && r.messages[2].attachmentCount === 7, "folder and attachments from the parts: " + JSON.stringify([m.folder, m.attachments, r.messages[2].attachmentCount]));
  ok(r.messages[1].flags.read === true && r.messages[1].flags.flagged === true && r.messages[1].folder.id === "INBOX", "a read, starred message listed in Inbox stays in Inbox");
  mock.calls.length = 0;
  const r2 = await api.list("INBOX", 3, 3);
  ok(r2.messages.map(x => x.id).join() === "m4,m5,m6" && lastCall("GET", /^\/messages$/).q.pageToken === "p3", "the next page uses Gmail's token: " + JSON.stringify(lastCall("GET", /^\/messages$/).q));
  mock.calls.length = 0;
  const r3 = await api.list("INBOX", 3, 6);
  ok(r3.messages.map(x => x.id).join() === "m7,m8" && mock.calls.filter(c => c.path === "/messages").length === 1, "paging on: " + r3.messages.map(x => x.id).join());
  // the address-book build lists in the background, with cursors of its own
  const bg = await api.list("INBOX", 2, 0, { background: true });
  ok(bg.messages.map(x => x.id).join() === "m1,m2", "a background list: " + bg.messages.map(x => x.id).join());
  mock.calls.length = 0;
  const r4 = await api.list("INBOX", 2, 4);
  ok(r4.messages.map(x => x.id).join() === "m5,m6" && mock.calls.filter(c => c.path === "/messages").length === 2, "an offset off the cursor is walked to from the start: " + r4.messages.map(x => x.id).join());
  const all = await api.list("ALL", 100, 0);
  const notSpamTrash = [...mock.messages.values()].filter(x => !x.labelIds.some(l => l === "SPAM" || l === "TRASH")).length;
  ok(all.messages.length === notSpamTrash && !lastCall("GET", /^\/messages$/).q.labelIds, "All Mail lists without a label, Spam and Trash left out: " + all.messages.length);
  const un = await api.query(api.queries.unreadIn("Label_1"), 100, 0);
  ok(lastCall("GET", /^\/messages$/).q.labelIds === "Label_1" && lastCall("GET", /^\/messages$/).q.q === "is:unread" && un.messages.map(x => x.id).join() === "p1,p3,p5", "unreadIn names the label outside the search: " + JSON.stringify([lastCall("GET", /^\/messages$/).q, un.messages.map(x => x.id)]));
  const st = await api.search(api.queries.starred(), null, 100, 0, true);
  ok(st.messages.map(x => x.id).join() === "f1,m2" && st.messages[0].folder.id === "Label_2" && st.messages[0].folder.name === "Projects/FPGA", "a search result's folder is its user label: " + JSON.stringify(st.messages.map(x => [x.id, x.folder])));
  const sc = await api.searchScoped("Subject", { include: { ids: ["Label_1", "Label_2"] } }, 50, 0);
  ok(lastCall("GET", /^\/messages$/).q.q === '(label:"Projects" OR label:"Projects/FPGA") Subject' && sc.messages.map(x => x.id).join() === "p1,p2,p3,p4,p5", "a folder with subfolders is searched by label names: " + JSON.stringify([lastCall("GET", /^\/messages$/).q.q, sc.messages.map(x => x.id)]));
  const el = await api.searchScoped("Subject", { exclude: { ids: ["Label_1", "Label_2"] } }, 50, 0);
  ok(lastCall("GET", /^\/messages$/).q.q === '-label:"Projects" -label:"Projects/FPGA" Subject' && el.messages.length > 0 && el.messages.every(x => !x.labelIds.includes("Label_1") && !x.labelIds.includes("Label_2")), "elsewhere: everything less the scope's labels: " + el.messages.length);
  // rows seen before are not fetched again, and show the labels they have now
  mock.calls.length = 0;
  const seen = await api.list("INBOX", 3, 0);
  ok(seen.messages.map(x => x.id).join() === "m1,m2,m3" && mock.calls.filter(c => c.path === "/messages").length === 1 && !mock.calls.some(c => /^\/messages\/m\d$/.test(c.path)), "a list seen before costs one list call: " + JSON.stringify(mock.calls.map(c => c.path)));
  ok(await api.starredCount() === [...mock.messages.values()].filter(m => m.labelIds.includes("STARRED")).length && lastCall("GET", /^\/labels\/STARRED$/), "the Starred count is the label's own");
  // a row Gmail refuses once inside the batch is asked again; one it keeps refusing fails the list
  // rather than leaving a hole that would end the paging
  for (const id of ["x1", "x2", "x3", "x4"]) mock.addMessage({ id, labels: ["Label_x"], subject: id, from: "x <x@x.com>", cc: "", html: "<p>x</p>" });
  mock.failItems = { status: 500, times: 1, match: /\/messages\/x2\?/ };
  const rf = await api.list("Label_x", 3, 0);
  ok(rf.messages.map(x => x.id).join() === "x1,x2,x3" && mock.failItems.times === 0, "a refused row is asked again: " + rf.messages.map(x => x.id).join());
  mock.failItems = { status: 500, times: 99, match: /\/messages\/x4\?/ };
  const rg = await outcome(api.list("Label_x", 4, 0));
  mock.failItems = null;
  ok(rg.e instanceof api.ApiError && /x4/.test(rg.e.message), "a row that keeps failing fails the list: " + (rg.e?.message || rg.value?.messages.length));
  for (const id of ["x1", "x2", "x3", "x4"]) mock.messages.delete(id);
  // a list longer than Gmail's 500-id page (a refresh of many loaded rows) takes several pages
  const t = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 520; i++) mock.addMessage({ id: `b${i}`, labels: ["Label_bulk"], subject: `bulk ${i}`, from: "b <b@x.com>", cc: "", date: t - i, html: "<p>b</p>" });
  mock.calls.length = 0;
  const big = await api.list("Label_bulk", 511, 0);
  ok(big.messages.length === 511 && big.messages[510].id === "b510" && mock.calls.filter(c => c.path === "/messages").length === 2, "a long refresh follows Gmail's pages: " + JSON.stringify([big.messages.length, mock.calls.filter(c => c.path === "/messages").map(c => c.q.maxResults)]));
  for (let i = 0; i < 520; i++) mock.messages.delete(`b${i}`);
}
// body: the HTML part, the inline image by cid, the attachment's bytes
{
  const b = await api.body("m3");
  ok(b.html.startsWith("<p>Body of <b>m3</b></p>") && b.html.includes('<img src="cid:m3-pic@x">') && b.message.id === "m3" && b.message.headers.messageId === "<m3@x.com>" && b.message.threadId === "t-m3", "body html and message: " + JSON.stringify([b.html.slice(0, 60), b.message.headers.messageId]));
  ok(b.attachments.length === 8 && b.attachments[0].partId === "0.1" && b.attachments[0].contentId === "m3-pic@x" && b.attachments[0].disposition === "inline" && b.attachments[1].filename === "report.pdf" && b.attachments[1].type === "application" && b.attachments[1].subtype === "pdf" && b.attachments[1].disposition === "attachment", "attachments: " + JSON.stringify(b.attachments.slice(0, 2)));
  ok(api.isInlineRef("cid:m3-pic@x") && !api.isInlineRef("https://x/y.png") && api.isStrayImage("cid:gone@x") && !api.isStrayImage("https://x/y.png"), "inline references are cid: sources");
  const src = await api.inlineSource("cid:m3-pic@x", b);
  ok(src?.startsWith("data:image/png;base64,") && lastCall("GET", /attachments/).path.endsWith("/att-m3-0.1"), "an inline image is fetched by its attachment id as a data URL: " + String(src).slice(0, 30));
  const pdf = await api.partBytes("m3", b.attachments[1]);
  ok(pdf.bytes.length === fs.statSync(path.join(FX, "report.pdf")).size && pdf.type === "application/pdf" && pdf.filename === "report.pdf", "attachment bytes: " + JSON.stringify([pdf.bytes.length, pdf.type]));
  const th = await api.thumbnail("m3", b.attachments[0]);
  ok(th?.startsWith("data:image/png"), "an image's thumbnail is the image itself");
  ok(api.originalUrl(b.attachments[1]) === null && api.docPages === undefined && api.extractText === undefined, "no download link, converter or text extraction");
  const gone = await outcome(api.body("nope"));
  ok(gone.e && api.isGone(gone.e), "a missing message is gone: " + gone.e?.message);
  const d = await api.body("d1");
  ok(d.message.csid === "r-d1" && d.message.inReplyTo?.messageReference?.id === "m3" && d.message.inReplyTo.replied && !d.message.inReplyTo.forwarded, "a draft carries its draft id and the message it answers: " + JSON.stringify([d.message.csid, d.message.inReplyTo]));
  // as some mailers send it: text, a file marked inline that the text does not show, more text
  const leaf = (partId, mimeType, value, headers = []) => ({ partId, mimeType, filename: "", headers: [{ name: "Content-Type", value: `${mimeType}; charset=utf-8` }, ...headers], body: { size: value.length, data: Buffer.from(value).toString("base64url") } });
  mock.attachments.set("att-apple-pdf", Buffer.from("%PDF-1.4 x"));
  mock.messages.set("apple1", { id: "apple1", threadId: "t-apple1", labelIds: ["INBOX"], snippet: "", internalDate: String(Date.now()), sizeEstimate: 100, payload: { partId: "", mimeType: "multipart/mixed", filename: "", headers: [{ name: "Subject", value: "Apple" }, { name: "From", value: "a <a@x.com>" }], body: { size: 0 }, parts: [
    { partId: "0", mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts: [leaf("0.0", "text/plain", "Before"), leaf("0.1", "text/html", "<p>Before</p>")] },
    { partId: "1", mimeType: "application/pdf", filename: "scan.pdf", headers: [{ name: "Content-Type", value: "application/pdf; name=scan.pdf" }, { name: "Content-Disposition", value: "inline; filename=scan.pdf" }, { name: "Content-ID", value: "<scan@x>" }], body: { size: 10, attachmentId: "att-apple-pdf" } },
    leaf("2", "text/plain", "After"),
  ] } });
  const ap = await api.body("apple1");
  ok(ap.text === "Before\nAfter" && ap.html.startsWith("<p>Before</p>") && ap.html.includes(">After</div>") && ap.attachments.length === 1 && ap.attachments[0].filename === "scan.pdf" && ap.attachments[0].disposition === "attachment" && ap.message.attachments[0].disposition === "attachment", "an inline-marked file the text does not show is an attachment, and text after it is shown: " + JSON.stringify([ap.text, ap.html, ap.attachments]));
  const [arow] = (await api.search("apple1", null, 10, 0, true)).messages;
  ok(arow?.attachmentCount === 1, "the row counts it: " + JSON.stringify(arow?.attachments));
  mock.messages.delete("apple1");
}
// mutations: label changes, a few one message each, more in bulk; a move trades the placing
// labels for the target's
{
  mock.calls.length = 0;
  const r = await api.setRead(["m1", "m3"], true);
  ok(modsOf().length === 2 && modsOf().every(b => b.single) && !mock.calls.some(c => c.path === "/messages/batchModify"), "a few messages change one each, not in bulk: " + JSON.stringify(modsOf()));
  ok(r.ok.join() === "m1,m3" && !r.failed.length && lastMod().removeLabelIds[0] === "UNREAD" && !labelsOf("m1").includes("UNREAD"), "mark read: " + JSON.stringify(lastMod()));
  await api.setStarred(["m1"], true);
  ok(lastMod().addLabelIds[0] === "STARRED" && labelsOf("m1").includes("STARRED"), "star");
  mock.calls.length = 0;
  const mv = await api.move(["m1", "p2"], "Label_2", { from: { m1: "INBOX", p2: "Label_1" } });
  const mods = modsOf();
  ok(mv.ok.join() === "m1,p2" && mods.length === 2 && mods.some(b => b.ids.join() === "m1" && b.removeLabelIds.join() === "INBOX" && b.addLabelIds.join() === "Label_2") && mods.some(b => b.ids.join() === "p2" && b.removeLabelIds.join() === "Label_1" && b.addLabelIds.join() === "Label_2"), "a move removes Inbox or the user label, one call per label set: " + JSON.stringify(mods));
  ok(labelsOf("m1").join() === "STARRED,Label_2", "the star survives a move: " + labelsOf("m1").join());
  mock.calls.length = 0;
  await api.move(["m1"], "ALL", { from: { m1: "Label_2" } });
  ok(lastMod().addLabelIds.length === 0 && lastMod().removeLabelIds.join() === "Label_2" && labelsOf("m1").join() === "STARRED", "archive from a label's folder adds nothing: " + JSON.stringify(lastMod()));
  await api.move(["m1"], "INBOX");
  ok(labelsOf("m1").includes("INBOX"), "a move to Inbox puts Inbox back");
  mock.calls.length = 0;
  mock.addMessage({ id: "n1", labels: ["INBOX", "Label_1"], subject: "n", from: "a <a@x.com>" });
  const unknown = await api.move(["n1"], "TRASH", { from: { n1: "INBOX" } });
  ok(unknown.ok.join() === "n1" && mock.calls.some(c => c.path === "/messages/n1" && c.q.format === "minimal") && labelsOf("n1").join() === "Label_1,TRASH", "a message not seen yet has its labels fetched first: " + JSON.stringify(labelsOf("n1")));
  // other labels stay through Trash, Archive and a move, and undo takes back exactly the move
  mock.addMessage({ id: "w1", labels: ["INBOX", "Label_1", "Label_4"], subject: "w", from: "a <a@x.com>" });
  const sorted = id => labelsOf(id).slice().sort().join();
  const tr = await api.move(["w1"], "TRASH", { from: { w1: "INBOX" } });
  ok(sorted("w1") === "Label_1,Label_4,TRASH", "Trash keeps the message's labels: " + sorted("w1"));
  await tr.undo();
  ok(sorted("w1") === "INBOX,Label_1,Label_4", "undo of a delete puts back what it took: " + sorted("w1"));
  const ar = await api.move(["w1"], "ALL", { from: { w1: "INBOX" } });
  ok(sorted("w1") === "Label_1,Label_4", "archive from Inbox takes only Inbox: " + sorted("w1"));
  await ar.undo();
  const lm = await api.move(["w1"], "Label_2", { from: { w1: "Label_1" } });
  ok(sorted("w1") === "Label_2,Label_4", "a move from a label's folder trades that label and Inbox for the target: " + sorted("w1"));
  const lu = await lm.undo();
  ok(sorted("w1") === "INBOX,Label_1,Label_4" && lu.ok.join() === "w1", "and its undo puts both back: " + sorted("w1"));
  const fromAll = await api.move(["w1"], "TRASH", { from: { w1: "ALL" } });
  await fromAll.undo();
  ok(sorted("w1") === "INBOX,Label_1,Label_4", "a delete from All Mail undone keeps Inbox: " + sorted("w1"));
  const bad = await outcome(api.move(["x) OR y"], "TRASH"));
  ok(bad.e instanceof api.ApiError && /malformed/.test(bad.e.message), "malformed ids are refused");
  // more than ten go in bulk
  const many = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "p1", "p3", "p4"];
  mock.calls.length = 0;
  const bulk = await api.setRead(many, false);
  ok(bulk.ok.length === 11 && mock.calls.filter(c => c.path === "/messages/batchModify").length === 1 && !modsOf().some(b => b.single), "more than ten change in bulk: " + JSON.stringify(modsOf().length));
  // a label changed elsewhere reaches a kept row through the history
  await api.folders();
  const before = (await api.search("m1", null, 10, 0, true)).messages[0];
  mock.messages.get(before.id).labelIds = mock.messages.get(before.id).labelIds.filter(l => l !== "UNREAD");
  mock.history.push({ id: String(mock.nextHistory), labelsRemoved: [{ message: { id: before.id, labelIds: mock.messages.get(before.id).labelIds }, labelIds: ["UNREAD"] }] });
  mock.profile.historyId = String(mock.nextHistory++);
  await api.folders();
  const after = (await api.search("m1", null, 10, 0, true)).messages[0];
  ok(before.id === after.id && !before.flags.read && after.flags.read, "a kept row follows a change made elsewhere: " + JSON.stringify([before.flags, after.flags]));
}
// folder operations, with the rename cascading to nested labels
{
  const c = await api.createFolder("Projects/New");
  ok(c.result.name === "Projects/New" && lastCall("POST", /^\/labels$/).body.labelListVisibility === "labelShow", "create: " + JSON.stringify(c.result));
  await api.folders();
  mock.calls.length = 0;
  await api.renameFolder("Label_1", "Work");
  const patches = mock.calls.filter(x => x.method === "PATCH").map(x => [x.path, x.body.name]);
  ok(JSON.stringify(patches) === JSON.stringify([["/labels/Label_1", "Work"], ["/labels/Label_2", "Work/FPGA"], [`/labels/${c.result.id}`, "Work/New"]]), "rename cascades: " + JSON.stringify(patches));
  await api.deleteFolder(c.result.id);
  ok(!mock.labels.some(l => l.id === c.result.id), "delete");
  const badId = await outcome(api.deleteFolder("ALL"));
  ok(badId.e instanceof api.ApiError, "All Mail cannot be deleted");
  mock.calls.length = 0;
  const unread = [...mock.messages.values()].filter(m => m.labelIds.includes("INBOX") && m.labelIds.includes("UNREAD")).length;
  const mr = await api.markFolderRead("INBOX", unread);
  ok(unread > 0 && mr.changed === unread && lastCall("GET", /^\/messages$/).q.labelIds === "INBOX,UNREAD" && !("includeSpamTrash" in lastCall("GET", /^\/messages$/).q) && [...mock.messages.values()].every(m => !m.labelIds.includes("INBOX") || !m.labelIds.includes("UNREAD")), "mark folder read: " + JSON.stringify([unread, mr.changed, lastCall("GET", /^\/messages$/).q]));
  const inTrash = [...mock.messages.values()].filter(m => m.labelIds.includes("TRASH")).length;
  const em = await api.emptyFolder("TRASH", inTrash);
  ok(inTrash > 0 && em.changed === inTrash && ![...mock.messages.values()].some(m => m.labelIds.includes("TRASH")) && lastCall("GET", /^\/messages$/).q.includeSpamTrash === "true", "empty Trash deletes for good: " + JSON.stringify([inTrash, em.changed]));
}
// accounts
{
  const a = await api.accounts();
  ok(a.accounts.length === 2 && a.accounts[0].email === "me@gmail.com" && a.accounts[0].isPrimary && a.accounts[0].sendingName === "Me Myself" && a.accounts[0].signatureActive && a.accounts[1].type === "ALIAS" && a.accounts[1].replyToAddress === "r@x.com", "accounts from sendAs: " + JSON.stringify(a.accounts));
}
// drafts: the draft id is the csid; saves keep it while the message id changes; send consumes it
{
  const d = { csid: "1762000000000", from: { name: "Me", email: "me@gmail.com" }, to: [{ email: "a@x.com" }], cc: [], bcc: [], subject: "Re: Subject m-3", inReplyTo: { id: "m3", replied: true }, files: [new File([new Uint8Array([1, 2, 3])], "x.bin")], refs: [{ messageId: "m3", partId: "1", filename: "report.pdf", size: 4 }], html: "<p>hi</p>", inline: [] };
  mock.uploads.length = 0;
  const s1 = await api.saveDraft(d);
  const up = mock.uploads[0];
  ok(/^r-new\d+$/.test(s1.message.csid) && /^dm\d+$/.test(s1.message.id) && s1.message.attachments.length === 0 && !s1.partial, "first save creates the draft: " + JSON.stringify(s1.message));
  ok(up.path === "/upload/drafts" && up.method === "POST" && up.meta.message.threadId === "t-m3", "multipart upload names the thread: " + JSON.stringify(up.meta));
  const h = headersOf(new TextEncoder().encode(up.raw));
  ok(h["in-reply-to"] === "<m3@x.com>" && h.references === "<m3@x.com>" && h.subject === "Re: Subject m-3" && h.to === "a@x.com", "reply headers chain to the original: " + JSON.stringify(h));
  const parts = listParts(new TextEncoder().encode(up.raw)).parts.map(p => [p.partId, p.type, p.filename]);
  ok(JSON.stringify(parts) === JSON.stringify([["1", "text/html", ""], ["2", "application/octet-stream", "x.bin"], ["3", "application/pdf", "report.pdf"]]), "files and forwarded parts are embedded: " + JSON.stringify(parts));
  const s2 = await api.saveDraft({ ...d, csid: s1.message.csid });
  ok(mock.uploads[1].path === `/upload/drafts/${s1.message.csid}` && mock.uploads[1].method === "PUT" && s2.message.csid === s1.message.csid && s2.message.id !== s1.message.id, "a second save updates the same draft, with a new message id: " + JSON.stringify(s2.message));
  const rows = await api.list("DRAFT", 10, 0);
  ok(rows.messages.find(m => m.id === "d1")?.csid === "r-d1" && rows.messages.find(m => m.id === s2.message.id)?.csid === s2.message.csid, "draft rows carry their draft ids");
  const del = await api.deleteForever([s2.message.id]);
  ok(del.ok.join() === s2.message.id && lastCall("DELETE", /^\/drafts\//).path === `/drafts/${s2.message.csid}`, "discarding a draft deletes the draft: " + JSON.stringify(lastCall("DELETE", /^\/drafts\//)));
  const s3 = await api.saveDraft({ ...d, subject: "New thread", inReplyTo: null, refs: [], files: [] });
  ok(!mock.uploads.at(-1).meta.message.threadId, "a new message starts its own thread");
  const sent = await api.send({ ...d, csid: s3.message.csid, subject: "New thread", inReplyTo: null, refs: [], files: [] }, "SENT");
  ok(/^sent\d+$/.test(sent.message.id) && mock.uploads.at(-1).path === "/upload/drafts/send" && mock.uploads.at(-1).meta.id === s3.message.csid && !mock.drafts.some(x => x.id === s3.message.csid), "sending a saved draft sends that draft: " + JSON.stringify(mock.uploads.at(-1).meta));
  const sent2 = await api.send({ ...d, csid: "9", inReplyTo: null, refs: [], files: [], subject: "Fwd: Subject m-3" }, "SENT");
  ok(/^sent\d+$/.test(sent2.message.id) && mock.uploads.at(-1).path === "/upload/messages/send", "a message never saved is sent on its own");
  await api.send({ ...d, csid: "10", inReplyTo: { id: "m3", replied: true }, subject: "Something else", refs: [], files: [] }, "SENT");
  ok(!mock.uploads.at(-1).meta.threadId, "a changed subject leaves the thread: " + JSON.stringify(mock.uploads.at(-1).meta));
  // a draft deleted elsewhere: the next save makes a new draft, and a send goes out on its own
  const plain = { ...d, subject: "Gone", inReplyTo: null, refs: [], files: [] };
  const g1 = await api.saveDraft(plain);
  mock.drafts.splice(mock.drafts.findIndex(x => x.id === g1.message.csid), 1);
  const g2 = await api.saveDraft({ ...plain, csid: g1.message.csid });
  ok(g2.message.csid !== g1.message.csid && mock.drafts.some(x => x.id === g2.message.csid) && mock.uploads.at(-1).path === "/upload/drafts", "a save of a draft gone elsewhere creates a new one: " + JSON.stringify([g1.message.csid, g2.message.csid]));
  mock.drafts.splice(mock.drafts.findIndex(x => x.id === g2.message.csid), 1);
  const g3 = await api.send({ ...plain, csid: g2.message.csid }, "SENT");
  ok(/^sent\d+$/.test(g3.message.id) && mock.uploads.at(-1).path === "/upload/messages/send", "a send of a draft gone elsewhere is sent on its own: " + mock.uploads.at(-1).path);
}
// tokens: a 401 renews once silently; a second one means signed out; rate limits are retried
{
  silentOk = true;
  mock.calls.length = 0;
  mock.fail = { status: 401, times: 1 };
  const r = await api.folders();
  const hint = new URL(flows.at(-1).url).searchParams;
  ok(r.folders.length > 0 && store.gmToken.access_token === "tok2" && mock.calls.some(c => c.auth === "Bearer tok2") && !flows.at(-1).interactive && hint.get("prompt") === "none" && hint.get("login_hint") === "me@gmail.com", "a 401 gets one silent renewal for the same account and the call is repeated: " + JSON.stringify({ token: store.gmToken?.access_token, url: flows.at(-1).url }));
  // a renewal Google answers for another account is refused, and the account is kept
  mock.profile.emailAddress = "other@gmail.com";
  mock.fail = { status: 401, times: 1 };
  const rx = await outcome(api.folders());
  mock.profile.emailAddress = "me@gmail.com";
  ok(rx.e instanceof api.NotSignedIn && /other@gmail\.com/.test(rx.e.message) && !store.gmToken && local.gmAccount === "me@gmail.com", "a token for another account is refused: " + JSON.stringify({ e: rx.e?.message, token: store.gmToken, local }));
  await api.bootstrap();
  silentOk = false;
  mock.fail = { status: 401, times: 2 };
  const r2 = await outcome(api.folders());
  ok(r2.e instanceof api.NotSignedIn, "a 401 that renewal cannot fix means signed out: " + r2.e?.name);
  silentOk = true; await api.bootstrap();
  mock.fail = { status: 429, times: 2 };
  const t0 = Date.now();
  const r3 = await outcome(api.folders());
  ok(r3.value?.folders.length > 0 && Date.now() - t0 >= 500, "429 is retried after a pause: " + (r3.e?.message || `${Date.now() - t0} ms`));
  mock.fail = { status: 403, times: 1, body: { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }], message: "slow down" } } };
  ok((await outcome(api.folders())).value?.folders.length > 0, "a 403 rate limit is retried too");
  // a quota refusal names Gmail's minute: every call waits until it is over, then asks again
  const windowStart = Math.floor(Date.now() / 1000) - 58;
  mock.fail = { status: 403, times: 1, body: { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }], status: "PERMISSION_DENIED", message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "6000", window_start_time: String(windowStart) } }] } } };
  const tq = Date.now();
  const rq = await outcome(api.list("INBOX", 3, 0));
  ok(rq.value?.messages.length === 3 && Date.now() >= (windowStart + 60) * 1000, "a quota refusal waits for Gmail's minute to end: " + (rq.e?.message || `${Date.now() - tq} ms`));
  mock.fail = { status: 403, times: 1, body: { error: { code: 403, status: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", message: "scope" } } };
  const r4 = await outcome(api.folders());
  ok(r4.e instanceof api.NotSignedIn && /permission/.test(r4.e.message), "a missing scope asks for a new sign-in: " + r4.e?.message);
  await api.bootstrap();
  const held = store.gmToken.access_token;
  mock.failRevoke = 1;
  const so1 = await outcome(api.signOut());
  ok(/still signed in/.test(so1.e?.message) && store.gmToken?.access_token === held && local.gmAccount === "me@gmail.com", "a sign-out Google does not confirm leaves the user signed in: " + so1.e?.message);
  mock.calls.length = 0;
  await api.signOut();
  const rv = mock.calls.find(c => c.path === "/revoke");
  ok(!store.gmToken && !local.gmAccount && mock.revoked.includes(held) && rv && !rv.q.token, "sign-out revokes the token, sent in the body, and forgets the token and the account: " + JSON.stringify({ rv, local }));
  const n = flows.length;
  const r5 = await outcome(api.bootstrap());
  ok(r5.e instanceof api.NotSignedIn && flows.length === n, "after sign-out nothing signs in again until the button is pressed: " + JSON.stringify({ e: r5.e?.name, flows: flows.length - n }));
}
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
