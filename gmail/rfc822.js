// RFC 822 messages for the Gmail adapter: builds the raw message a draft or a send uploads, and
// reads address headers as Gmail returns them. Pure: no DOM, no network, so it runs in Node too.

const CRLF = "\r\n";
const enc = new TextEncoder();
const ASCII = /^[\x20-\x7e]*$/;

// ---------- encodings ----------
function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(s);
}
// base64 in lines of 76, as RFC 2045 asks of a transfer encoding
const base64Lines = bytes => base64(bytes).replace(/.{76}/g, `$&${CRLF}`).replace(/\r\n$/, "");

// Quoted-printable text: lines end in CRLF, stay under 76 characters through soft breaks, and
// carry no trailing white space, so the recipient's reader sees the text as written.
function quotedPrintable(text) {
  const bytes = enc.encode(String(text).replace(/\r?\n/g, CRLF));
  let out = "", line = "";
  const flush = () => { out += line + CRLF; line = ""; };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 13 && bytes[i + 1] === 10) { line = line.replace(/[ \t]$/, m => `=${m.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`); flush(); i++; continue; }
    const literal = (b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9;
    const piece = literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    if (line.length + piece.length > 75) { out += line + "=" + CRLF; line = ""; }
    line += piece;
  }
  if (line) out += line.replace(/[ \t]$/, m => `=${m.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return out;
}

// RFC 2047 encoded words for header text outside ASCII, each under 76 characters and split only
// between characters, folded onto continuation lines.
function encodedWords(s) {
  const chunks = [];
  let buf = [];
  for (const ch of s) {
    const b = enc.encode(ch);
    if (buf.length + b.length > 45) { chunks.push(buf); buf = []; }
    buf.push(...b);
  }
  if (buf.length) chunks.push(buf);
  return chunks.map(c => `=?utf-8?B?${base64(Uint8Array.from(c))}?=`).join(`${CRLF} `);
}
const headerText = s => ASCII.test(s) ? s : encodedWords(s);

// A display name: plain when it needs nothing, quoted when it holds specials, encoded otherwise.
const SPECIALS = /[()<>[\]:;@\\,."]/;
function formatAddress(a) {
  const email = String(a?.email || "").trim(), name = String(a?.name || "").trim();
  if (!name) return email;
  if (!ASCII.test(name)) return `${encodedWords(name)} <${email}>`;
  return SPECIALS.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}" <${email}>` : `${name} <${email}>`;
}
const addressList = list => (list || []).map(formatAddress).filter(Boolean).join(`,${CRLF} `);

// RFC 5322 date: the UTC form with a numeric zone.
export const rfcDate = (d = new Date()) => d.toUTCString().replace(/GMT$/, "+0000");

// A file name parameter: plain ASCII in quotes, otherwise RFC 2231 with an encoded-word fallback.
function nameParams(name, key) {
  const n = String(name || "attachment").replace(/[\r\n]/g, " ");
  if (ASCII.test(n)) return `${key}="${n.replace(/["\\]/g, "\\$&")}"`;
  return `${key}="${encodedWords(n).replace(/\r\n /g, " ")}"; ${key}*=utf-8''${encodeURIComponent(n)}`;
}

// ---------- entities ----------
// Each entity is its headers, a blank line and its content; a multipart entity holds others.
const entity = (headers, content) => headers.join(CRLF) + CRLF + CRLF + content;

function textEntity(type, text) {
  return entity([`Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: quoted-printable"], quotedPrintable(text));
}

// file: a File, or { name, type, bytes: Uint8Array }
async function fileEntity(file, { inline = false, contentId = null } = {}) {
  const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(await file.arrayBuffer());
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.type || "") ? file.type : "application/octet-stream";
  const headers = [
    `Content-Type: ${type}; ${nameParams(file.name, "name")}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${inline ? "inline" : "attachment"}; ${nameParams(file.name, "filename")}; size=${bytes.length}`,
  ];
  if (contentId) headers.push(`Content-ID: <${String(contentId).replace(/[<>\s]/g, "")}>`);
  return entity(headers, base64Lines(bytes));
}

const boundary = () => `=_${crypto.randomUUID()}`;
function multipart(subtype, parts) {
  const b = boundary();
  return entity([`Content-Type: multipart/${subtype}; boundary="${b}"`], parts.map(p => `--${b}${CRLF}${p}${CRLF}`).join("") + `--${b}--${CRLF}`);
}

// ---------- the message ----------
// m: { from, replyTo, to, cc, bcc: [{ name, email }], subject, date, messageId, inReplyTo, references,
//   html | text, inline: [{ file, contentId }], files: File[], extra: [{ name, type, bytes }] }
// Returns the message bytes. A plain or HTML body alone, with its inline images in a related
// entity, and with files in a mixed one.
export async function build(m) {
  let body = m.html != null ? textEntity("text/html", m.html) : textEntity("text/plain", m.text || "");
  if (m.inline?.length) body = multipart("related", [body, ...await Promise.all(m.inline.map(i => fileEntity(i.file, { inline: true, contentId: i.contentId })))]);
  const files = [...(m.files || []), ...(m.extra || [])];
  if (files.length) body = multipart("mixed", [body, ...await Promise.all(files.map(f => fileEntity(f)))]);
  const headers = [`From: ${formatAddress(m.from)}`];
  if (m.to?.length) headers.push(`To: ${addressList(m.to)}`);
  if (m.cc?.length) headers.push(`Cc: ${addressList(m.cc)}`);
  if (m.bcc?.length) headers.push(`Bcc: ${addressList(m.bcc)}`);
  if (m.replyTo?.email && m.replyTo.email !== m.from?.email) headers.push(`Reply-To: ${formatAddress(m.replyTo)}`);
  headers.push(`Subject: ${headerText(String(m.subject || "").replace(/[\r\n]+/g, " "))}`);
  headers.push(`Date: ${m.date || rfcDate()}`);
  headers.push(`Message-ID: <${m.messageId || `${crypto.randomUUID()}@baltazar-mail`}>`);
  if (m.inReplyTo) headers.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references) headers.push(`References: ${String(m.references).replace(/\s+/g, `${CRLF} `)}`);
  headers.push("MIME-Version: 1.0");
  return enc.encode(headers.join(CRLF) + CRLF + body);
}

// ---------- address headers ----------
function decodeWords(s) {
  return String(s || "").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(\s+(?==\?))?/gi, (m, cs, e, text) => {
    try {
      const bin = e.toLowerCase() === "b" ? atob(text) : text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16)));
      let dec; try { dec = new TextDecoder(cs); } catch { dec = new TextDecoder(); }
      return dec.decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    } catch { return m; }
  });
}

// Splits an address list on commas outside quotes, comments and angle brackets. A group's name
// (up to its colon) is dropped and its semicolon ends it.
function splitList(s) {
  const out = [];
  let cur = "", q = false, depth = 0, angle = false, hasAddr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && (q || depth)) { cur += ch + (s[i + 1] || ""); i++; continue; }
    if (q) { if (ch === '"') q = false; cur += ch; continue; }
    if (depth) { if (ch === "(") depth++; else if (ch === ")") depth--; continue; }
    if (ch === '"') { q = true; cur += ch; continue; }
    if (ch === "(") { depth = 1; continue; }
    if (ch === "<") angle = true; else if (ch === ">") angle = false;
    if (ch === "@" || ch === "<") hasAddr = true;
    if (!angle && ch === ":" && !hasAddr) { cur = ""; continue; }
    if (!angle && (ch === "," || ch === ";")) { out.push(cur); cur = ""; hasAddr = false; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const unquote = s => s.trim().replace(/^"(.*)"$/s, "$1").replace(/\\(.)/g, "$1").trim();

// "Name" <a@b>, a@b, <a@b>, =?utf-8?B?...?= <a@b>, Group: a@b, c@d; -> [{ name, email }]
export function parseAddresses(header) {
  const out = [];
  for (const item of splitList(String(header || ""))) {
    const m = item.match(/^(.*)<([^<>]*)>\s*$/s);
    const email = (m ? m[2] : item).trim().replace(/^mailto:/i, "").replace(/\s+/g, "");
    if (!email.includes("@")) continue;
    const name = m ? decodeWords(unquote(m[1])) : "";
    out.push(name ? { name, email } : { name: "", email });
  }
  return out;
}

// The address part of a Message-ID or In-Reply-To header, with its angle brackets.
export const messageIdOf = v => { const m = String(v || "").match(/<[^<>\s]+>/); return m ? m[0] : ""; };
