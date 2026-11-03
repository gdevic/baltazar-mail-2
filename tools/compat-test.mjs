// The browser minimum in each edition's manifest.json covers the newer JavaScript features its
// built code uses, bundled libraries included. Each feature with the Chrome (and Edge) version that shipped it,
// from MDN's browser-compat-data, web-features and Chromium's intents to ship. A library update
// that starts using something newer fails here until the minimum is raised.
// node tools/compat-test.mjs
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const FEATURES = [["Promise.try", 128], ["Uint8Array.fromBase64", 140], ["getOrInsertComputed", 145], ["Math.sumPrecise", 147]];

const { build, EDITIONS } = createRequire(import.meta.url)("./build.js");
let fail = 0;
const mins = [];
for (const edition of Object.keys(EDITIONS)) {
  const ext = build(edition);
  const min = Number(JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8")).minimum_chrome_version);
  mins.push(`${edition} ${min}`);
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name)) files.push(p);
    }
  })(ext);
  for (const [feature, version] of FEATURES) {
    const users = files.filter(f => fs.readFileSync(f, "utf8").includes(feature)).map(f => path.relative(ext, f));
    if (users.length && version > min) { fail++; console.log(`FAIL ${edition}: ${feature} needs Chrome ${version}, minimum is ${min}: ${users.join(", ")}`); }
  }
}
console.log(fail ? `${fail} FAIL` : `PASS (minimum Chrome: ${mins.join(", ")})`);
process.exit(fail ? 1 : 0);
