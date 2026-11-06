// Smoke test for the extension UI with mocked chrome APIs and Yahoo endpoints.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

// The Yahoo build, served over HTTP.
const ROOT = require("./build.js").build("yahoo");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(ROOT, req.url.split("?")[0]));
  if (!p.startsWith(ROOT + path.sep) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  // Pages get the extension's own CSP, as they do when installed.
  const csp = path.extname(p) === ".html" ? { "content-security-policy": JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.extension_pages } : {};
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream", ...csp });
  fs.createReadStream(p).pipe(res);
});

const now = Math.floor(Date.now() / 1000);
const msg = (i, folder) => ({
  id: `MSG${i}`, conversationId: `C${i}`, modSeq: i, size: 1000, attachmentCount: i % 3 === 0 ? 1 : 0,
  flags: { read: i % 2 === 0, flagged: i % 5 === 0 },
  headers: { subject: i === 1 ? "Hit ^_Z80^_ here" : `Subject ${i}`, from: [{ name: `Sender ${i}`, email: `s${i}@x.com` }], to: [{ name: "Me", email: "me@yahoo.com" }], date: String(now - i * 40000) },
  folder: { id: folder, name: folder === "1" ? "Inbox" : "Other" }, snippet: "snip",
});
// Includes a linked account's Inbox listed before the primary one, and a record without a name or
// types: the app must open folder 1 and still start.
const folders = [
  { id: "77", acctId: "2", name: "Inbox (linked)", types: ["INBOX"], unread: 0, total: 8, highestModSeq: 17 },
  { id: "88", unread: 0, total: 0, highestModSeq: 18 },
  { id: "1", acctId: "1", name: "Inbox", types: ["INBOX"], unread: 3, total: 95, highestModSeq: 10 },
  { id: "2", name: "Sent", types: ["SENT"], unread: 0, total: 8, highestModSeq: 11 },
  { id: "4", name: "Trash", types: ["TRASH"], unread: 0, total: 1, highestModSeq: 12 },
  { id: "62", name: "Archive", types: ["ARCHIVE"], unread: 0, total: 0, highestModSeq: 16 },
  { id: "31", name: "Projects", types: ["USER"], unread: 0, total: 5, highestModSeq: 13 },
  { id: "32", name: "Projects/A-Z80", types: ["USER"], unread: 1, total: 7, highestModSeq: 14 },
  { id: "99", name: "Hidden", types: ["SYNC"], unread: 0, total: 0, highestModSeq: 15 },
  // nesting by path segment, and a subfolder whose parent does not exist
  { id: "50", name: "Work", types: ["USER"], unread: 0, total: 1, highestModSeq: 19 },
  { id: "51", name: "Work.x", types: ["USER"], unread: 0, total: 1, highestModSeq: 20 },
  { id: "52", name: "Work/Sub", types: ["USER"], unread: 0, total: 1, highestModSeq: 21 },
  { id: "53", name: "Orphan/Child", types: ["USER"], unread: 0, total: 1, highestModSeq: 22 },
];

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
  const page = await browser.newPage();
  const errors = [], mutations = [];
  // Nothing may reach the real network: hosts without a mock are recorded and refused. The test
  // message's remote image (on Yahoo's image proxy) is the one request the reader is meant to make.
  const unexpected = new Set();
  const imageHosts = [];
  // Images the reader asks the network for (requests a CSP blocks never get here).
  await page.route(/^https?:\/\//, r => { const h = new URL(r.request().url()).hostname; if (r.request().frame().url() === "about:srcdoc") imageHosts.push(h); if (h === "127.0.0.1") return r.continue(); if (h !== "ecp.yusercontent.com") unexpected.add(h); return r.abort(); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.addInitScript(() => {
    // A Mac, when the test asks for one.
    let mac = false; try { mac = !!localStorage.getItem("mac"); } catch { /* a sandboxed frame */ }
    if (mac) {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
      Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => ({ platform: "macOS" }) });
    }
    const area = (ns) => ({
      get: async k => { const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) { const v = localStorage.getItem(ns + x); if (v !== null) o[x] = JSON.parse(v); } return o; },
      set: async o => { for (const [k, v] of Object.entries(o)) localStorage.setItem(ns + k, JSON.stringify(v)); } });
    // Installed from a release ZIP unless the test switches to a store install.
    window.chrome = { storage: { session: area("s:"), local: area("l:") }, runtime: { getURL: p => p, getManifest: () => ({ version: "0.14.0" }) },
      management: { getSelf: async () => ({ installType: localStorage.getItem("installType") || "development" }) },
      action: { setIcon: async d => { (window.iconCalls ||= []).push(d); } },
      tabs: { getCurrent: async () => ({ id: 7 }), update: async (id, p) => { (window.tabUpdates ||= []).push([id, p]); } } };
  });
  await page.route("https://mail.yahoo.com/**", async route => {
    const url = route.request().url();
    if (url === "https://mail.yahoo.com/") {
      return route.fulfill({ contentType: "text/html", body: '<html><script>window.AppBootstrapData={"appId":"YMailCLDNovation","mailWssid":"w1","primaryMailbox":{"email":"me@yahoo.com","id":"MB1"}}</script></html>' });
    }
    const name = new URL(url).searchParams.get("name");
    const body = route.request().postData() || "";
    const uriM = body.match(/"uri":"([^"]+)"/);
    const uri = uriM ? uriM[1].replace(/\\u0026/g, "&") : "";
    let result;
    if (uri.endsWith("/folders")) result = { folders, accounts: [{ id: "1", highestModSeq: 1 }] };
    else if (uri.includes("/content/simplebody/full")) result = { message: msg(1, "1"), simpleBody: { html: "<p>Hello <b>body</b><img src='https://ecp.yusercontent.com/y.png'><img src='https://cloud-apis.mail.yahoo.com/z.png'></p>", attachments: [{ filename: "a.pdf", size: 2048, disposition: "attachment", downloadUrl: "https://cloud-apis.mail.yahoo.com/x" }] } };
    else {
      const q = decodeURIComponent(uri.split("q=")[1] || "");
      const folder = (q.match(/folderId:(\d+)/) || [])[1] || "1";
      const count = Number((q.match(/count:(\d+)/) || [])[1] || 100);
      const offset = Number((q.match(/offset:(\d+)/) || [])[1] || 0);
      const n = q.includes("keyword:") ? 5 : (folder === "1" ? 95 : 8);
      result = { messages: Array.from({ length: Math.max(0, Math.min(count, n - offset)) }, (_, i) => msg(offset + i + 1, folder)), query: { type: q.includes("keyword") ? "S" : "L", nextModSeq: 1 } };
    }
    if (!uri) errors.push("batch without uri: " + name);
    const reqs = (body.match(/"method":"(POST|DELETE)"/g) || []).length;
    const innerIds = [...body.matchAll(/"id":"((?:UnifiedUpdateMessage|UnifiedDeleteMessage)_\d+)"/g)].map(m => m[1]);
  const responses = reqs ? innerIds.map(id => ({ id, httpCode: 204, responseString: "" })).reverse() : [{ id: "x", httpCode: 200, response: { result } }];
    mutations.push(name + ":" + reqs);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { responses, status: { failedRequests: [], successRequests: [] } }, error: null }) });
  });
  const ghCalls = [];
  await page.route("https://api.github.com/**", r => { ghCalls.push(r.request().url()); return r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ tag_name: "v0.1.0" }) }); });
  await page.goto(`http://127.0.0.1:${port}/mail.html`);
  await page.waitForSelector("#rows .row");
  // the installed version heads Settings; the update note stays hidden when nothing newer exists
  await page.waitForFunction(() => document.getElementById("app-version").textContent === "Baltazar Mail 0.14.0", null, { timeout: 4000 }).catch(() => {});
  const versionLine = await page.locator("#app-version").textContent() + (await page.locator("#update-note").isHidden() ? "" : " +note");
  const rows = await page.locator("#rows .row").count();
  const foldersShown = await page.locator("#folders .folder").allTextContents();
  await page.keyboard.press("j"); await page.keyboard.press("j"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("r-subject").textContent.length > 0);
  const subject = await page.locator("#r-subject").textContent();
  const frameHtml = await page.frameLocator("#r-body").locator("body").innerHTML();
  await page.keyboard.press("/"); await page.keyboard.type("Z80"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("list-title").textContent.startsWith("“Z80” in Inbox"));
  const hit = await page.locator("#rows .row .sb mark").first().textContent();
  const scoped = { chip: await page.locator("#search-scope").textContent(), divider: await page.locator("#rows .elsewhere").count() };
  await page.keyboard.press("/"); await page.keyboard.press("Shift+Enter");
  await page.waitForFunction(() => document.getElementById("list-title").textContent.startsWith("“Z80” in all mail"));
  scoped.allChip = await page.locator("#search-scope").textContent();
  scoped.allDivider = await page.locator("#rows .elsewhere").count();
  await page.keyboard.press("g"); await page.keyboard.press("s");
  await page.waitForFunction(() => document.getElementById("list-title").textContent === "Sent");
  const sentRows = await page.locator("#rows .row").count();
  await page.locator("#rows .row").first().click({ button: "right" });
  // menu entries as "label|shortcut", separators as "---"
  const menu = () => page.locator("#ctx").evaluate(c => [...c.children].map(e => e.tagName === "HR" ? "---" : `${e.querySelector("span").textContent}|${e.querySelector("kbd")?.textContent || ""}`));
  const sentMenu = await menu();
  await page.keyboard.press("Escape"); await page.mouse.click(5, 5);
  await page.keyboard.press("?");
  const helpVisible = await page.locator("#help").isVisible();
  // actions: go to inbox, select two rows with x, archive, undo; context menu; move picker
  await page.keyboard.press("Escape");
  await page.keyboard.press("g"); await page.keyboard.press("i");
  await page.waitForFunction(() => document.getElementById("list-title").textContent === "Inbox");
  await page.keyboard.press("j"); await page.keyboard.press("x"); await page.keyboard.press("j"); await page.keyboard.press("x");
  const selectedText = await page.locator("#list-count").textContent();
  await page.keyboard.press("e");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Undo"));
  const afterArchive = { rows: await page.locator("#rows .row").count(), undo: await page.locator("#st-undo").textContent() };
  await page.keyboard.press("z");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Redo") && document.querySelectorAll("#rows .row").length === 95);
  const afterUndo = { rows: await page.locator("#rows .row").count(), undo: await page.locator("#st-undo").textContent() };
  await page.locator("#rows .row").nth(3).click({ button: "right" });
  const ctxItems = await menu();
  // About sender opens the contact card where the menu was; Esc closes it; hovering a list sender does not
  const rowFrom = await page.locator("#rows .row").nth(3).locator(".fr").getAttribute("data-email");
  const menuBox = await page.locator("#ctx").boundingBox();
  await page.locator("#ctx div", { hasText: "About sender" }).click();
  await page.waitForSelector("#card:not(.hidden)", { timeout: 4000 }).catch(() => {});
  const cardBox = await page.locator("#card").boundingBox();
  const aboutCard = { email: await page.locator("#card .card-head span").textContent().catch(() => ""), rowFrom, nearMenu: !!cardBox && Math.abs(cardBox.x - menuBox.x) < 40 && Math.abs(cardBox.y - menuBox.y) < 40 };
  aboutCard.find = await page.locator('#card [data-c="search"]').textContent().catch(() => "");
  await page.keyboard.press("Escape");
  aboutCard.closed = await page.locator("#card").isHidden();
  await page.locator("#rows .row").nth(5).locator(".fr").hover(); await page.waitForTimeout(800);
  aboutCard.noHover = await page.locator("#card").isHidden();
  await page.keyboard.press("v");
  await page.waitForSelector("#movebox:not(.hidden)");
  await page.keyboard.type("Proj");
  const moveChoices = await page.locator("#move-list div").allTextContents();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.includes("Undo: move"));
  const afterMove = await page.locator("#st-undo").textContent();
  await page.keyboard.press("x"); await page.keyboard.press("j"); await page.keyboard.press("x");
  await page.locator("#rows .row").nth(6).click({ button: "right" });
  await page.screenshot({ path: path.join(__dirname, "..", "out", "actions.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("u");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.includes("Undo: mark"));
  const afterRead = await page.locator("#st-undo").textContent();
  console.log("actions", JSON.stringify({ selectedText, afterArchive, afterUndo, ctxItems, moveChoices, afterMove, afterRead, mutations }));
  const expect = (cond, what) => { if (!cond) errors.push("assert: " + what); };
  expect(versionLine === "Baltazar Mail 0.14.0", "version line: " + versionLine);
  expect(subject === "Hit Z80 here" && hit === "Z80", "search markers become highlights, not text: " + JSON.stringify({ subject, hit }));
  expect(frameHtml.includes("Hello <b>body</b>"), "message body shown: " + frameHtml.slice(0, 80));
  expect(sentRows === 8 && helpVisible, "Sent opens with g s, ? shows help: " + JSON.stringify({ sentRows, helpVisible }));
  expect(rows === 95 && foldersShown.some(f => f.startsWith("Folder 88")) && foldersShown.some(f => f.startsWith("Inbox (linked)")), "starts with odd folders, opening the primary Inbox: " + JSON.stringify({ rows, foldersShown }));
  expect(foldersShown.filter(f => f.startsWith("Starred")).length === 1 && foldersShown.slice(0, 3).join("|") === "Inbox3|Starred95|Inbox (linked)8" && !foldersShown.some(f => f.startsWith("Hidden")),
    "one Starred, after the primary Inbox; SYNC folders hidden: " + JSON.stringify(foldersShown));
  expect(scoped.chip === "in Inbox" && scoped.divider === 1 && scoped.allChip === "All mail" && scoped.allDivider === 0, "search scope: " + JSON.stringify(scoped));
  expect(selectedText.endsWith("2 selected"), "two selected");
  expect(afterArchive.rows === 93 && afterArchive.undo.startsWith("Undo: archive 2"), "archive removed two rows with undo label");
  expect(afterUndo.rows === 95, "undo restored rows");
  expect(sentMenu.slice(-2).join() === "Find all to|,About recipient...|", "Sent rows find and describe the recipient: " + JSON.stringify(sentMenu));
  expect(/^Reply\|r,Reply all\|a,Forward\|f,---,Archive\|e,Move\.\.\.\|v,Spam\|!,Delete\|Del,---,Mark (un)?read\|u,(Star|Unstar)\|s,---,Find all from\|,About sender\.\.\.\|$/.test(ctxItems.join()),
    "context menu items, in order, with shortcuts: " + JSON.stringify(ctxItems));
  expect(aboutCard.email === aboutCard.rowFrom && aboutCard.nearMenu && aboutCard.closed && aboutCard.noHover && aboutCard.find === "Find all from", "About sender card: " + JSON.stringify(aboutCard));
  expect(moveChoices[0] === "Projects", "move picker filter");
  expect(mutations.includes("messages.move:2") && mutations.includes("messages.readFlagUpdate:1"), "mutation calls");
  await page.keyboard.press(",");
  await page.click('input[name=layout][value=horizontal]');
  await page.click('input[name=theme][value=light]');
  await page.selectOption("#lightTheme", "sky");
  await page.locator("#contrast").fill("7");
  await page.click("#settings-close");
  const box = await page.locator("#split2").boundingBox();
  await page.mouse.move(box.x + 10, box.y + 2); await page.mouse.down(); await page.mouse.move(box.x + 10, box.y + 150, { steps: 5 }); await page.mouse.up();
  const b1 = await page.locator("#split1").boundingBox();
  await page.mouse.move(b1.x + 2, b1.y + 100); await page.mouse.down(); await page.mouse.move(b1.x + 80, b1.y + 100, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, "..", "out", "smoke.png") });
  // A store install never asks GitHub: switch to one and forget the last check before reloading.
  const ghAfterZip = ghCalls.length;
  await page.evaluate(() => { localStorage.setItem("installType", "normal"); localStorage.removeItem("l:updateCheck"); });
  await page.reload();
  await page.waitForSelector("#rows .row");
  await page.waitForTimeout(500);
  const ghAfterStore = ghCalls.length;
  const persisted = await page.evaluate(() => ({ layout: document.getElementById("app").className, theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue("--bg"),
    folderW: getComputedStyle(document.documentElement).getPropertyValue("--folder-w"), listH: getComputedStyle(document.documentElement).getPropertyValue("--list-h") }));
  console.log("persisted", JSON.stringify(persisted));
  // Contrast level and palette survive a reload; a palette id that no longer exists falls back to Paper.
  const { roles } = await import(require("url").pathToFileURL(path.join(__dirname, "..", "ext", "themes.js")).href);
  const cssVar = v => page.evaluate(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim(), v);
  const level7 = { line: await cssVar("--line"), contrast: await page.evaluate(async () => (await chrome.storage.local.get("settings")).settings.contrast), field: await page.locator("#contrast").inputValue(), shown: await page.locator("#contrast-n").textContent() };
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("l:settings")); s.lightTheme = "gone"; s.contrast = 0; localStorage.setItem("l:settings", JSON.stringify(s)); });
  await page.reload();
  await page.waitForSelector("#rows .row");
  const stale = { bg: await cssVar("--bg"), line: await cssVar("--line"), choice: await page.locator("#lightTheme").inputValue() };
  console.log("contrast", JSON.stringify({ level7, stale }));
  const expectTheme = (cond, what) => { if (!cond) errors.push("assert: " + what); };
  expectTheme(level7.contrast === 7 && level7.field === "7" && level7.shown === "7" && level7.line === roles("sky", 7).line && level7.line !== roles("sky", 0).line, "contrast 7 persists: " + JSON.stringify(level7));
  expectTheme(stale.bg === roles("light").bg && stale.line === roles("light").line && stale.choice === "light", "missing palette falls back to Paper: " + JSON.stringify(stale));
  // Windows Contrast themes: the cursor row, a marked row and the active folder stay visible
  await page.emulateMedia({ forcedColors: "active" });
  await page.locator("#list").focus(); await page.keyboard.press("j"); await page.keyboard.press("x"); await page.keyboard.press("j");
  const outline = sel => page.locator(sel).first().evaluate(e => { const c = getComputedStyle(e); return `${c.outlineStyle} ${parseFloat(c.outlineWidth)}`; });
  const forced = { sel: await outline("#rows .row.sel"), marked: await outline("#rows .row.marked:not(.sel)"), folder: await outline("#folder-list .folder.active"),
    hit: await page.locator("#rows .row .sb mark").first().evaluate(e => { const c = getComputedStyle(e); return c.color !== c.backgroundColor && !/rgba\([^)]*,\s*0\)$/.test(c.backgroundColor); }) };
  await page.keyboard.press("k"); await page.keyboard.press("x");
  await page.emulateMedia({ forcedColors: "none" });
  // Start-up clears a toolbar dot left by an earlier load and keeps the tab from being discarded.
  const startup = await page.evaluate(() => ({ icon: JSON.stringify((window.iconCalls || [])[0] || null), tab: JSON.stringify(window.tabUpdates || []) }));
  // Subfolders sit under their own parent; one without a parent folder is still listed.
  await page.locator("#folder-list .folder").filter({ has: page.locator('.tw[data-tw="closed"]') }).filter({ has: page.locator(".nm", { hasText: /^Work$/ }) }).locator(".tw").click();
  const tree = await page.locator("#folder-list .folder").evaluateAll(els => els.map(e => `${e.querySelector(".nm").textContent}@${parseInt(e.style.paddingLeft)}`));
  await page.locator("#folder-list .folder").filter({ has: page.locator('.tw[data-tw="open"]') }).filter({ has: page.locator(".nm", { hasText: /^Work$/ }) }).locator(".tw").click();
  // Ctrl-click adds single rows to the selection, starting from the row already selected
  const marks = () => page.evaluate(() => [...document.querySelectorAll("#rows .row")].map((r, i) => r.classList.contains("marked") ? i : -1).filter(i => i >= 0).join());
  const ctrlSel = {};
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(300);
  await page.locator("#rows .row").nth(3).click({ modifiers: ["Control"] });
  await page.locator("#rows .row").nth(5).click({ modifiers: ["Control"] });
  ctrlSel.three = { marks: await marks(), count: await page.locator("#list-count").textContent() };
  await page.locator("#rows .row").nth(3).click({ modifiers: ["Control"] });
  ctrlSel.untoggled = await marks();
  await page.locator("#list").focus(); await page.keyboard.press("Escape");
  // Deletes here are checked by the row count, not the undo label, which an earlier delete
  // already set; each undo waits for the full list again.
  let listRows = 0;
  const rowsBelow = n => page.waitForFunction(n => document.querySelectorAll("#rows .row").length < n, n, { timeout: 5000 }).catch(() => {}).then(() => page.waitForTimeout(300));
  const rowsBack = () => page.waitForFunction(() => document.querySelectorAll("#rows .row").length >= 95, null, { timeout: 5000 }).catch(() => {});
  // The trash icon: shown on the row under the pointer, the cursor row and marked rows; it deletes its row,
  // or the whole selection when it is one of the selected rows.
  const trash = {};
  const shown = () => page.locator("#rows .row .tr").evaluateAll(ts => ts.slice(0, 6).map(t => getComputedStyle(t).visibility === "visible" ? 1 : 0).join(""));
  const undoNow = () => page.locator("#st-undo").textContent();
  await page.locator("#list").focus(); await page.keyboard.press("Home"); await page.keyboard.press("Escape");
  await page.locator("#rows .row").nth(4).hover();
  trash.hover = await shown();
  await page.keyboard.press("j"); await page.keyboard.press("x"); await page.keyboard.press("j"); await page.keyboard.press("x");
  await page.mouse.move(2, 2);
  trash.marked = await shown();
  trash.before = await page.locator("#rows .row").count();
  listRows = await page.locator("#rows .row").count();
  await page.locator("#rows .row").nth(2).locator(".tr").click();
  await rowsBelow(listRows);
  trash.two = { rows: await page.locator("#rows .row").count(), undo: await undoNow() };
  await page.locator("#list").focus(); await page.keyboard.press("z"); await rowsBack();
  // a row outside the selection: only that row goes, and the selection and cursor stay
  await page.keyboard.press("Escape"); await page.keyboard.press("Home");
  await page.keyboard.press("j"); await page.keyboard.press("x"); await page.keyboard.press("j"); await page.keyboard.press("x");
  const selState = () => page.evaluate(() => ({ marked: [...document.querySelectorAll("#rows .row.marked .fr")].map(e => e.dataset.email).join(), cursor: document.querySelector("#rows .row.sel .fr")?.dataset.email }));
  const selBefore = await selState();
  await page.locator("#rows .row").nth(5).hover(); const sel5 = await page.locator("#rows .row").nth(5).locator(".fr").getAttribute("data-email");
  listRows = await page.locator("#rows .row").count();
  await page.locator("#rows .row").nth(5).locator(".tr").click();
  await rowsBelow(listRows);
  trash.one = { rows: await page.locator("#rows .row").count(), undo: await undoNow(), gone: !(await page.locator(`#rows .row .fr[data-email="${sel5}"]`).count()), selBefore, selAfter: await selState() };
  await page.locator("#list").focus(); await page.keyboard.press("z"); await rowsBack();
  // a click a few pixels outside the drawn icon still deletes
  { const svg = await page.locator("#rows .row").nth(7).locator(".tr svg").boundingBox(); await page.locator("#rows .row").nth(7).hover();
    listRows = await page.locator("#rows .row").count();
    await page.mouse.click(svg.x - 5, svg.y + svg.height / 2);
    await rowsBelow(listRows);
    trash.near = { rows: await page.locator("#rows .row").count(), opened: await page.locator("#r-subject").textContent() }; }
  await page.locator("#list").focus(); await page.keyboard.press("z"); await rowsBack();
  // the icon sits right beside the date
  trash.gap = await page.locator("#rows .row").nth(1).evaluate(r => { const t = r.querySelector(".tr svg").getBoundingClientRect(), d = r.querySelector(".dt"); const range = document.createRange(); range.selectNodeContents(d.lastChild); return Math.round(range.getBoundingClientRect().left - t.right); });
  // The reader's own Delete, after a separator, acts on the open message alone and the reader
  // moves on; in Trash it reads Undelete and moves the message to Inbox.
  const rdel = {};
  await page.locator("#list").focus(); await page.keyboard.press("Escape"); await page.keyboard.press("Home");
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(400);
  rdel.actions = await page.locator("#reader-head .r-actions").evaluate(s => [...s.children].filter(e => e.id !== "r-dark").map(e => e.classList.contains("sep") ? "|" : e.textContent).join(" "));
  rdel.before = await page.locator("#rows .row").count();
  await page.locator("#r-delete").click();
  await rowsBelow(rdel.before);
  rdel.deleted = { rows: await page.locator("#rows .row").count(), undo: await undoNow() };
  await page.locator("#list").focus(); await page.keyboard.press("z"); await rowsBack();
  await page.keyboard.press("g"); await page.keyboard.press("t");
  await page.waitForFunction(() => document.getElementById("list-title").textContent === "Trash" && document.querySelectorAll("#rows .row").length === 8);
  await page.locator("#rows .row").nth(0).click();
  await page.waitForFunction(() => document.getElementById("r-delete").textContent === "Undelete", null, { timeout: 4000 }).catch(() => {});
  rdel.inTrash = { label: await page.locator("#r-delete").textContent(), rows: await page.locator("#rows .row").count() };
  await page.locator("#r-delete").click();
  await rowsBelow(rdel.inTrash.rows);
  rdel.restored = { rows: await page.locator("#rows .row").count(), undo: await undoNow() };
  await page.locator("#list").focus(); await page.keyboard.press("g"); await page.keyboard.press("i"); await rowsBack();
  // The message zoom: + / - / 0 scale the open message in place while the interface stays as it
  // is, a badge over the pane shows the level and fades, the next message opens at the same zoom,
  // and so does the composer, where Ctrl+= / Ctrl+- / Ctrl+0 change it and the size control still
  // shows the real font size.
  const zoom = {};
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(400);
  const frameZoom = () => page.locator("#r-body").evaluate(f => getComputedStyle(f.contentDocument.documentElement).zoom);
  const badge = () => page.locator("#zoom-badge").evaluate(b => b.classList.contains("show") ? b.textContent : "");
  const uiSize = () => page.evaluate(() => [getComputedStyle(document.documentElement).getPropertyValue("--fs"), document.getElementById("list").getBoundingClientRect().width].join());
  zoom.ui = await uiSize();
  await page.locator("#list").focus(); await page.keyboard.press("+"); await page.keyboard.press("+");
  zoom.up = { badge: await badge(), frame: await frameZoom(), ui: await uiSize() };
  zoom.over = await page.evaluate(() => { const b = document.getElementById("zoom-badge").getBoundingClientRect(), r = document.getElementById("r-body").getBoundingClientRect(); return b.left > r.left && b.right < r.right && b.top > r.top && b.bottom < r.bottom; });
  await page.waitForTimeout(1400);
  zoom.faded = await badge();
  await page.keyboard.press("0");
  zoom.reset = { badge: await badge(), frame: await frameZoom() };
  await page.keyboard.press("-");
  zoom.down = await frameZoom();
  await page.locator("#rows .row").nth(2).click(); await page.waitForTimeout(400);
  zoom.next = await frameZoom();
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(400);   // the mock's body belongs to the top row
  await page.locator("#list").focus(); await page.keyboard.press("r");
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 5000 }).catch(() => {});
  await page.locator("#c-editor").click(); await page.waitForTimeout(200);
  const editorZoom = () => page.locator("#c-editor").evaluate(e => getComputedStyle(e).zoom);
  zoom.compose = { zoom: await editorZoom(), size: await page.locator("#c-size").inputValue() };
  await page.keyboard.press("Control+="); await page.keyboard.press("Control+=");
  zoom.composeUp = { badge: await badge(), zoom: await editorZoom(), size: await page.locator("#c-size").inputValue() };
  await page.keyboard.press("Control+0");
  zoom.composeReset = await editorZoom();
  await page.locator("#c-discard").click().catch(() => {}); await page.waitForTimeout(500);
  // The toolbar's order, with Delete between separators; the menu's Reply and Find all from
  // (the mock's body is always message 1, the top row)
  const menuActs = {};
  menuActs.toolbar = await page.locator("#toolbar").evaluate(t => [...t.children].map(e => e.classList.contains("sep") ? "|" : e.classList.contains("sp") ? "_" : e.textContent).join(" "));
  await page.locator("#rows .row").nth(0).click({ button: "right" });
  menuActs.rowFrom = await page.locator("#rows .row").nth(0).locator(".fr").getAttribute("data-email");
  await page.locator("#ctx div[data-act=reply]").click();
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 5000 }).catch(() => {});
  menuActs.reply = { title: await page.locator("#c-title").textContent(), to: await page.locator("#c-to").textContent() };
  await page.locator("#c-discard").click().catch(() => {}); await page.waitForTimeout(500);
  await page.locator("#rows .row").nth(0).click({ button: "right" });
  await page.locator("#ctx div", { hasText: "Reply all" }).click();
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 5000 }).catch(() => {});
  menuActs.replyAll = await page.locator("#c-title").textContent();
  await page.locator("#c-discard").click().catch(() => {}); await page.waitForTimeout(500);
  await page.locator("#rows .row").nth(0).click({ button: "right" });
  await page.locator("#ctx div", { hasText: "Find all from" }).click();
  await page.waitForTimeout(800);
  menuActs.find = { term: await page.inputValue("#search") };
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  await page.locator("#search").focus(); await page.keyboard.press("Escape"); await page.waitForTimeout(600);
  // Keys: Backspace deletes in the list, a symbol typed with Alt (Option, AltGr) still counts, Alt
  // with a letter does not; on a Mac the shortcuts are labelled with the Command key.
  const keys = {};
  const undoText = () => page.locator("#st-undo").textContent();
  const rowCount = () => page.locator("#rows .row").count();
  await page.locator("#list").focus(); await page.keyboard.press("Home");
  keys.before = await rowCount();
  listRows = await page.locator("#rows .row").count();
  await page.keyboard.press("Backspace");
  await rowsBelow(listRows);
  keys.backspace = { rows: await rowCount(), undo: await undoText() };
  await page.keyboard.press("z"); await rowsBack();
  const altKey = key => page.locator("#list").evaluate((l, key) => l.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true })), key);
  await altKey("e"); await page.waitForTimeout(400);
  keys.altLetter = await rowCount();
  listRows = await page.locator("#rows .row").count();
  await altKey("#");
  await rowsBelow(listRows);
  keys.altHash = { rows: await rowCount(), undo: await undoText() };
  await page.keyboard.press("z"); await rowsBack();
  // In the message: shortcuts work, scroll keys and copy stay with the message. Backspace deletes
  // outside text fields too, but not in the search box.
  const sel = () => page.locator("#rows .row").evaluateAll(rs => rs.findIndex(r => r.classList.contains("sel")));
  const inBody = () => page.frameLocator("#r-body").locator("body").click({ position: { x: 5, y: 5 } });
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(600);
  await inBody(); keys.frameFocus = await page.evaluate(() => document.activeElement.id);
  listRows = await page.locator("#rows .row").count();
  await page.keyboard.press("Delete");
  await rowsBelow(listRows);
  keys.frameDelete = { rows: await rowCount(), undo: await undoText() };
  await page.keyboard.press("z"); await rowsBack();
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(600);
  await inBody(); await page.keyboard.press("ArrowDown"); await page.waitForTimeout(300);
  keys.frameArrow = await sel();
  keys.frameCopy = await page.frameLocator("#r-body").locator("body").evaluate(b => { const e = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }); b.dispatchEvent(e); return e.defaultPrevented; });
  await page.keyboard.press("j"); await page.waitForTimeout(600);
  keys.frameJ = await sel();
  await page.locator("#r-subject").click(); keys.before2 = await rowCount();
  listRows = await page.locator("#rows .row").count();
  await page.keyboard.press("Backspace");
  await rowsBelow(listRows);
  keys.headerBackspace = { rows: await rowCount(), undo: await undoText() };
  await page.keyboard.press("z"); await rowsBack();
  await page.locator("#search").focus(); const undoBefore = await undoText(); await page.keyboard.press("Backspace"); await page.waitForTimeout(400);
  keys.searchBackspace = (await undoText()) === undoBefore && await rowCount() === keys.before2;
  await page.keyboard.press("Escape");
  // a frame with the reader's sandbox runs no script, even one that skipped the cleaning
  keys.sandbox = await page.evaluate(async () => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", document.getElementById("r-body").getAttribute("sandbox"));
    f.srcdoc = `<script>parent.pwnedFrame = 1</script><img src="data:," onerror="parent.pwnedFrame = 1"><svg onload="parent.pwnedFrame = 1"></svg>`;
    await new Promise(r => { f.onload = r; document.body.appendChild(f); });
    await new Promise(r => setTimeout(r, 300));
    f.remove();
    return { attr: f.getAttribute("sandbox"), pwned: window.pwnedFrame ?? null };
  });
  const labels = () => page.evaluate(() => ({ send: document.getElementById("c-send").title, help: [...document.querySelectorAll("#help td")].map(t => t.textContent).filter(t => /Ctrl|⌘/.test(t)).join(" | ") }));
  keys.pc = await labels();
  await page.evaluate(() => localStorage.setItem("mac", "1")); await page.reload(); await page.waitForSelector("#rows .row");
  keys.mac = await labels();
  await page.evaluate(() => localStorage.removeItem("mac"));
  const expectEnd = (cond, what) => { if (!cond) errors.push("assert: " + what); };
  expectEnd(keys.backspace.rows === keys.before - 1 && /Undo: delete/.test(keys.backspace.undo) && keys.altLetter === keys.before &&
    keys.altHash.rows === keys.before - 1 && /Undo: delete/.test(keys.altHash.undo), "Backspace and Alt+# delete, Alt+letter does nothing: " + JSON.stringify(keys));
  expectEnd(keys.frameFocus === "r-body" && keys.frameDelete.rows === keys.before - 1 && /Undo: delete/.test(keys.frameDelete.undo) && keys.frameArrow === 0 && !keys.frameCopy && keys.frameJ === 1,
    "shortcuts work while the message has focus; scrolling and copy stay with it: " + JSON.stringify(keys));
  expectEnd(keys.headerBackspace.rows === keys.before2 - 1 && keys.searchBackspace, "Backspace deletes outside text fields: " + JSON.stringify(keys));
  expectEnd(!/allow-scripts/.test(keys.sandbox.attr) && keys.sandbox.pwned === null, "the reader's sandbox runs no script: " + JSON.stringify(keys.sandbox));
  expectEnd(imageHosts.includes("ecp.yusercontent.com") && !imageHosts.some(h => /yahoo\.com$/.test(h)), "the reader loads images only from Yahoo's proxy: " + JSON.stringify([...new Set(imageHosts)]));
  expectEnd(ctrlSel.three.marks === "0,3,5" && /3 selected/.test(ctrlSel.three.count) && ctrlSel.untoggled === "0,5", "Ctrl-click selects single rows: " + JSON.stringify(ctrlSel));
  expectEnd(trash.hover === "100010" && trash.marked === "011000" && trash.two.rows === trash.before - 2 && /Undo: delete 2/.test(trash.two.undo) &&
    trash.one.rows === trash.before - 1 && trash.one.gone && trash.one.selBefore.marked.split(",").length === 2 &&
    trash.one.selAfter.marked === trash.one.selBefore.marked && trash.one.selAfter.cursor === trash.one.selBefore.cursor && trash.gap >= 10 && trash.gap <= 16 && trash.near.rows === trash.before - 1, "the row trash icon shows on hover and selection and deletes: " + JSON.stringify(trash));
  expectEnd(zoom.up.badge === "120%" && zoom.up.frame === "1.2" && zoom.up.ui === zoom.ui && zoom.over && zoom.faded === "" && zoom.reset.badge === "100%" && zoom.reset.frame === "1" &&
    zoom.down === "0.9" && zoom.next === "0.9", "the message zoom scales the open message alone, with a badge over it: " + JSON.stringify(zoom));
  expectEnd(zoom.compose.zoom === "0.9" && zoom.compose.size === "13" && zoom.composeUp.badge === "110%" && zoom.composeUp.zoom === "1.1" && zoom.composeUp.size === "13" && zoom.composeReset === "1",
    "the composer opens at the message zoom and Ctrl+= / Ctrl+0 change it: " + JSON.stringify(zoom));
  expectEnd(rdel.actions === "Reply Reply all Forward Print | Delete" && rdel.deleted.rows === rdel.before - 1 && /^Undo: delete 1 message/.test(rdel.deleted.undo) && 
    rdel.inTrash.label === "Undelete" && rdel.inTrash.rows === 8 && rdel.restored.rows === 7 && /^Undo: restore 1 message to Inbox/.test(rdel.restored.undo), "the reader's Delete and Undelete: " + JSON.stringify(rdel));
  expectEnd(menuActs.toolbar === "Archive Move... Spam | Delete | Mark read Star _ Undo Redo" || menuActs.toolbar === "Archive Move... Spam | Delete | Mark unread Star _ Undo Redo",
    "toolbar order: " + menuActs.toolbar);
  expectEnd(menuActs.reply.title === "Reply" && menuActs.replyAll === "Reply all" && menuActs.reply.to.includes(menuActs.rowFrom) && menuActs.find.term === `from:${menuActs.rowFrom}`,
    "the menu's Reply answers the clicked row and Find all from searches its sender: " + JSON.stringify(menuActs));
  expectEnd(keys.pc.send === "Send (Ctrl+Enter)" && keys.mac.send === "Send (⌘Enter)" && !/Ctrl/.test(keys.mac.help) && /⌘Z/.test(keys.mac.help) && /⌘-click/.test(keys.mac.help),
    "Mac shortcut labels: " + JSON.stringify([keys.pc, keys.mac]));
  expectEnd(persisted.layout.includes("horizontal") && persisted.theme === "light" && persisted.bg === roles("sky", 7).bg && persisted.folderW !== "230px" && persisted.listH !== "40%",
    "layout, palette and pane sizes survive a reload: " + JSON.stringify(persisted));
  expectEnd(ghAfterZip === 1 && ghAfterStore === 1, "a ZIP install asks GitHub once, a store install never: " + JSON.stringify({ ghAfterZip, ghAfterStore }));
  expectEnd(forced.sel === "solid 2" && forced.marked === "dashed 1" && forced.folder === "solid 2" && forced.hit, "selection, marks, the active folder and search hits show in forced colours: " + JSON.stringify(forced));
  expectEnd(startup.icon.includes("icons/16.png") && startup.tab === '[[7,{"autoDiscardable":false}]]', "start-up resets the toolbar icon and keeps the tab: " + JSON.stringify(startup));
  const at = n => tree.findIndex(t => t.startsWith(n + "@"));
  expectEnd(at("Sub") === at("Work") + 1 && tree[at("Sub")].endsWith("@20") && at("Work.x") > at("Sub") && tree.includes("Orphan/Child@8"),
    "subfolders nest under their own parent, orphans stay listed: " + JSON.stringify(tree));
  expectEnd(!unexpected.size, "no request left for the real network: " + [...unexpected].join(", "));
  console.log(JSON.stringify({ rows, foldersShown, subject, frameHtml: frameHtml.slice(0, 80), hit, sentRows, helpVisible, errors }, null, 1));
  await browser.close();
  server.close();
  // Expected: images outside Yahoo's proxy refused by the reader's CSP, scripts refused by the sandbox.
  const real = errors.filter(e => !e.includes("img-src 'none'") && !e.includes(`"img-src https://*.yusercontent.com data:"`) && !(e.includes("cloud-apis.mail.yahoo.com/z.png") && e.includes("img-src 'self' data: blob: https://*.yusercontent.com")) && !e.includes("the 'allow-scripts' permission is not set") && !e.includes("ERR_TUNNEL_CONNECTION_FAILED") && !e.includes("net::ERR_"));
  if (real.length) { console.error("FAILED:", real); process.exit(1); }
  console.log("PASS");
})().catch(e => { console.error(e); process.exit(1); });
