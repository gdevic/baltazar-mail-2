// Builds the two extensions: ext/ (the shared client) with an edition's folder laid over it, yahoo/
// into dist/baltazar-mail-yahoo/ and gmail/ into dist/baltazar-mail-gmail/. Each edition gives its
// manifest, its icons (so the two tell apart when both are pinned), its adapter (api.js) and its
// request rules (rules.js); the version comes from VERSION.
// An edition's local.json (not in git) may give the key that pins the extension id of an unpacked
// copy and, for Gmail, the OAuth client id. node tools/build.js [yahoo|gmail] [--store]; with no edition named, both
// are built. --store leaves the key out, for the package a browser store takes, since a store
// assigns the id itself and refuses a key.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHARED = path.join(ROOT, "ext");
// What every edition must give, and the files it may add besides; each edition's own hosts, which
// no other edition's code may name outside a comment.
const SLOTS = ["manifest.json", "icons", "api.js", "rules.js"];
const EDITIONS = {
  yahoo: { added: [], hosts: /yahoo|yusercontent/i },
  gmail: { added: ["auth.js", "rfc822.js"], hosts: /googleapis|accounts\.google|google\.com/i },
};
const NOT_COPIED = new Set(["local.json"]);
const outOf = edition => path.join(ROOT, "dist", `baltazar-mail-${edition}`);
const version = () => fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();

function build(edition, { store = false } = {}) {
  const ed = EDITIONS[edition];
  if (!ed) throw new Error(`unknown edition ${edition}`);
  const over = path.join(ROOT, edition), out = outOf(edition);
  const shared = new Set(fs.readdirSync(SHARED));
  for (const name of SLOTS) if (shared.has(name)) throw new Error(`ext/${name} belongs in an edition's folder`);
  // The folder is emptied rather than removed: Windows refuses to remove a folder that a browser
  // has loaded or a window shows, and the browser keeps the extension loaded from the same path.
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(out)) fs.rmSync(path.join(out, name), { recursive: true, force: true });
  fs.cpSync(SHARED, out, { recursive: true });
  for (const name of fs.readdirSync(over)) {
    if (NOT_COPIED.has(name)) continue;
    if (!SLOTS.includes(name) && !ed.added.includes(name)) throw new Error(`${edition}/${name} is neither an edition file nor listed as added`);
    if (shared.has(name)) throw new Error(`${edition}/${name} would replace the shared ext/${name}`);
    fs.cpSync(path.join(over, name), path.join(out, name), { recursive: true });
  }
  const given = JSON.parse(fs.readFileSync(path.join(over, "manifest.json"), "utf8"));
  if ("version" in given) throw new Error(`${edition}/manifest.json must not name a version; VERSION does`);
  const { manifest_version, name, ...rest } = given;
  const manifest = { manifest_version, name, version: version(), ...rest };
  const localPath = path.join(over, "local.json");
  if (fs.existsSync(localPath)) {
    const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
    if (local.client_id && manifest.oauth2) manifest.oauth2.client_id = local.client_id;
    if (local.key && !store) manifest.key = local.key;
  }
  if (store) delete manifest.key;
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  check(edition, out, manifest);
  return out;
}

// No edition's code names another edition's hosts outside a comment, and only Yahoo asks for
// request rules.
function check(edition, out, manifest) {
  const files = walk(out).filter(f => !f.includes(`${path.sep}vendor${path.sep}`) && /\.(js|html|css|json)$/.test(f));
  for (const [other, { hosts }] of Object.entries(EDITIONS)) {
    if (other === edition) continue;
    const hits = files.filter(f => hosts.test(fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")));
    if (hits.length) throw new Error(`${other} addresses in the ${edition} build: ${hits.map(f => path.relative(out, f)).join(", ")}`);
  }
  for (const name of [...SLOTS, ...EDITIONS[edition].added]) if (!fs.existsSync(path.join(out, name))) throw new Error(`missing ${name}`);
  if ((edition === "yahoo") !== manifest.permissions.includes("declarativeNetRequest")) throw new Error(`the ${edition} manifest's declarativeNetRequest permission is wrong`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

if (require.main === module) {
  const named = process.argv.slice(2).filter(a => !a.startsWith("--"));
  for (const edition of named.length ? named : Object.keys(EDITIONS)) {
    const out = build(edition, { store: process.argv.includes("--store") });
    console.log(`built ${path.relative(ROOT, out)} (version ${version()})`);
  }
}

module.exports = { build, outOf, EDITIONS };
