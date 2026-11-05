// Runtime test of the Gmail extension: the build in dist/baltazar-mail-gmail loaded into Chromium
// against the Gmail of gmail-mock.js, driven through sign-in, reading, search, actions with undo,
// folders, compose, drafts and polling. node tools/gmail-runtime.js
const path = require("path");
const fs = require("fs");
const { launch } = require("./harness");
const { FX } = require("./gmail-mock.js");

(async () => {
  const mime = await import("../ext/mime.js");
  const h = await launch({ provider: "gmail", gmail: { mime } });
  const { ctx, page, extId, profile, gmail, errors, cspViolations, unexpectedHosts } = h;
  const results = {};
  const expect = (c, w) => { if (!c) errors.push("assert: " + w); };
  const frameText = async () => page.frameLocator("#r-body").locator("body").innerText({ timeout: 3000 }).catch(() => "FRAME-ERR");
  const folder = async name => { await page.locator("#folder-list .folder", { hasText: name }).first().click(); await page.waitForTimeout(600); };
  const menu = async (act, timeout = 4000) => { await page.locator(`#ctx [data-act="${act}"]`).click(); await page.waitForTimeout(timeout === 0 ? 0 : 400); };
  const lastUpload = () => gmail.uploads.at(-1);
  const partsOf = up => mime.listParts(Buffer.from(up.raw, "latin1")).parts.map(p => [p.partId, p.type, p.filename]);
  const headersOf = up => { const o = {}; for (const line of up.raw.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ").split("\r\n")) { const c = line.indexOf(":"); if (c > 0) o[line.slice(0, c).toLowerCase()] = line.slice(c + 1).trim(); } return o; };

  // without a token the sign-in page asks, with the provider's wording, and opens no window
  await page.goto(`chrome-extension://${extId}/mail.html`);
  await page.waitForSelector("#signin:not(.hidden)", { timeout: 20000 });
  results.signIn = { title: await page.locator("#signin-title").textContent(), text: await page.locator("#signin-text").textContent(), button: await page.locator("#retry").textContent(),
    link: await page.locator("#signin-link").isHidden(), app: await page.locator("#app").isHidden(), tab: await page.title(), brand: await page.locator("#brand").textContent(), fails: await page.locator("#signin-fail").isHidden() };
  await h.signIn();
  await page.waitForSelector("#rows .row", { timeout: 20000 });
  await page.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.storage.local.get("updateCheck")).updateCheck; i++) await new Promise(r => setTimeout(r, 100)); });
  await page.evaluate(() => chrome.storage.local.set({ settings: { pollSec: 5, undoSendSec: 2 } }));
  await page.reload();
  await page.waitForSelector("#rows .row", { timeout: 20000 });
  results.signedIn = { account: await page.locator("#account").textContent(), tab: await page.title(), flows: gmail.calls.filter(c => c.path === "/profile").length > 0 };

  // the folder tree: Gmail's labels as folders, Starred after Inbox, All Mail for the archive
  results.tree = { names: await page.locator("#folder-list .folder .nm").allTextContents(), counts: await page.locator("#folder-list .folder .ct").allTextContents(),
    unread: await page.locator("#folder-list .folder.unread .nm").allTextContents(), rows: await page.locator("#rows .row").count(),
    clips: await page.locator("#rows .row .fl").evaluateAll(els => els.map(e => e.innerHTML ? 1 : 0).join("")), unreadRows: await page.locator("#rows .row.unread").count() };

  // reading: the HTML body with its cid image inlined, hostile markup removed, both spacers kept flat
  await page.locator("#rows .row").nth(2).click(); await page.waitForTimeout(800);
  results.read = { subject: await page.locator("#r-subject").textContent(), from: await page.locator("#r-from").textContent(), folder: await page.locator("#r-folder").textContent(), body: (await frameText()).slice(0, 20),
    imgs: await page.frameLocator("#r-body").locator("img").evaluateAll(els => els.map(e => (e.getAttribute("src") || "").slice(0, 22))),
    spacer: await page.frameLocator("#r-body").locator("#spacer").evaluate(e => e.getBoundingClientRect().height),
    spacer2: await page.frameLocator("#r-body").locator("#spacer2").evaluate(e => e.getBoundingClientRect().height),
    csp: await page.frameLocator("#r-body").locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content") };
  // attachments: seven cards, the image with a thumbnail, no converter for the deck
  results.attach = { cards: await page.locator("#r-attach .att-card").count(), labels: await page.locator("#r-attach .att-thumb").allTextContents() };
  await page.waitForFunction(() => document.querySelectorAll("#r-attach .att-thumb img").length === 1, null, { timeout: 5000 }).catch(() => {});
  results.attach.thumbs = await page.locator("#r-attach .att-thumb img").evaluateAll(els => els.map(e => e.src.slice(0, 15)));
  const view = async i => { await page.locator("#r-attach .att-card").nth(i).click(); await page.waitForSelector("#viewer:not(.hidden)"); await page.waitForFunction(() => !document.getElementById("v-body").textContent.startsWith("Loading"), null, { timeout: 15000 }); };
  const next = async name => { await page.locator("#v-next").click(); await page.waitForFunction(n => document.getElementById("v-name").textContent === n && !document.getElementById("v-body").textContent.startsWith("Loading"), name, { timeout: 15000 }); };
  const box = async () => { for (let i = 0; i < 100; i++) { const f = page.frames().find(f => f.url().endsWith("/render.html") && !f.isDetached()); if (f) return f; await page.waitForTimeout(100); } throw new Error("no render frame"); };
  await view(0);
  let f = await box();
  await f.waitForFunction(() => document.querySelector(".pdfViewer .page canvas") && /Quarterly/.test(document.querySelector(".textLayer")?.textContent || ""), null, { timeout: 15000 });
  results.viewer = { pdfPages: await f.evaluate(() => document.querySelectorAll(".pdfViewer .page").length), sandboxFetch: await f.evaluate(async () => { try { await fetch("https://gmail.googleapis.com/"); return "allowed"; } catch { return "blocked"; } }) };
  const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await page.locator("#v-dl").click();
  const d = await dl;
  results.viewer.download = d ? d.suggestedFilename() + ":" + (fs.statSync(await d.path()).size === fs.statSync(path.join(FX, "report.pdf")).size) : "none";
  await next("data.csv"); results.viewer.csv = await (await box()).evaluate(() => [...document.querySelectorAll("td")].map(t => t.textContent).join(","));
  await next("src.zip"); results.viewer.zip = await (await box()).evaluate(() => [...document.querySelectorAll("td:first-child")].map(t => t.textContent).join(","));
  await next("photo.png"); results.viewer.img = await page.locator("#v-body img.v-img").count();
  await next("cv.docx"); f = await box(); await f.waitForFunction(() => /Jorge Ruiz/.test(document.body.textContent), null, { timeout: 8000 }).catch(() => {}); results.viewer.doc = (await f.evaluate(() => document.body.textContent)).includes("Jorge Ruiz");
  await next("budget.xlsx"); f = await box(); results.viewer.sheet = await f.evaluate(() => [...document.querySelectorAll(".grid td")].map(t => t.textContent).join(","));
  // the deck has no renderer and Gmail no converter: offered as text, since its bytes are text
  await next("deck.pptx");
  await page.waitForSelector("#v-raw", { timeout: 15000 });
  results.viewer.deck = { note: (await page.locator("#v-body").textContent()).slice(0, 60), raw: await page.locator("#v-raw").textContent() };
  await page.locator("#v-raw").click();
  f = await box(); await f.waitForFunction(() => document.querySelector("pre"), null, { timeout: 5000 }).catch(() => {});
  results.viewer.deck.text = await f.evaluate(() => document.querySelector("pre")?.textContent || "");
  results.viewer.deck.label = await f.evaluate(() => document.querySelector(".note")?.textContent || "");
  await f.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.waitForSelector("#viewer.hidden", { state: "attached", timeout: 5000 }).catch(() => {});
  results.viewer.closed = await page.locator("#viewer").isHidden();

  // the reader's cleaning of a hostile message (Projects)
  await folder("Projects");
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(800);
  results.unsafe = await page.frameLocator("#r-body").locator("body").evaluate(b => {
    const d = b.ownerDocument;
    return { scripts: d.querySelectorAll("script").length, forms: d.querySelectorAll("form, input, button, textarea, select").length, frames: d.querySelectorAll("iframe, object, embed").length,
      refresh: d.querySelectorAll('meta[http-equiv="refresh" i]').length, handlers: [...d.querySelectorAll("*")].flatMap(e => [...e.attributes].filter(a => /^on/i.test(a.name)).map(a => a.name)).length,
      link: (() => { const l = d.getElementById("h-link"); return l && { ping: l.hasAttribute("ping"), target: l.target }; })() };
  }).catch(e => ({ error: e.message }));
  results.unsafe.pwned = await page.evaluate(() => window.pwned ?? null);
  // bidi controls never reach the page (Projects/FPGA)
  await page.locator("#folder-list .folder", { hasText: "Projects" }).locator(".tw").click();
  await folder("FPGA");
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(600);
  results.bidi = await page.evaluate(() => [...document.querySelectorAll("#rows, #r-subject, #r-from, #list-title")].map(e => e.textContent).join(" "));
  await page.locator("#folder-list .folder", { hasText: "Projects" }).locator(".tw").click();

  // Starred: a search across folders, with the label as the folder
  await folder("Starred");
  results.starred = { rows: await page.locator("#rows .row").count(), count: await page.locator("#folder-list .folder.view .ct").textContent(), folders: await page.locator("#rows .row .sb em").allTextContents(), q: gmail.calls.filter(c => c.path === "/messages" && /starred/.test(c.q?.q || "")).at(-1)?.q?.q };

  // search from Projects: the folder and its subfolder by label names, the rest below a divider
  await folder("Projects");
  await page.locator("#search").click(); await page.keyboard.type("Subject");
  results.search = { chip: await page.locator("#search-scope").textContent() };
  await page.keyboard.press("Enter");
  await page.waitForSelector("#rows .elsewhere", { timeout: 8000 });
  const qs = gmail.calls.filter(c => c.path === "/messages" && c.q.q?.includes("Subject")).map(c => c.q);
  results.search.inQ = qs.some(q => q.q === '(label:"Projects" OR label:"Projects/FPGA") Subject');
  results.search.outQ = qs.some(q => q.q === '-label:"Projects" -label:"Projects/FPGA" Subject');
  results.search.title = await page.locator("#list-title").textContent();
  results.search.divider = await page.locator("#rows .elsewhere span").textContent();
  results.search.scoped = await page.locator("#rows .row:not(.else)").count();
  results.search.elseRows = await page.locator("#rows .row.else").count();
  // a compound query goes out as one Gmail query
  await page.locator("#search").click(); await page.keyboard.press("Control+A"); await page.keyboard.type('"Subject" AND m-2 -from:bob'); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("list-title").textContent.startsWith("“\"Subject\" AND m-2"), null, { timeout: 5000 });
  await page.waitForTimeout(500);
  results.search.compound = { q: gmail.calls.filter(c => c.path === "/messages" && /m-2 -from:bob/.test(c.q.q || "")).map(c => c.q.q), tip: await page.locator("#list-title").getAttribute("title"), rows: await page.locator("#rows .row:not(.else)").count() };
  await page.locator("#search").focus(); await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  results.search.back = await page.locator("#list-title").textContent();

  // actions with undo: read, star, archive (to All Mail and back), spam, delete, permanent delete
  await folder("Inbox");
  const row = i => page.locator("#rows .row").nth(i);
  // label changes as { ids, addLabelIds, removeLabelIds }, made one message each or in bulk
  const mods = () => gmail.calls.filter(c => c.path === "/messages/batchModify" || /^\/messages\/[^/]+\/modify$/.test(c.path)).map(c => c.path.endsWith("/modify") ? { ids: [c.path.split("/")[2]], ...c.body } : c.body);
  await row(0).click(); await page.waitForTimeout(700);
  const n0 = mods().length;
  await page.locator("#list").focus(); await page.keyboard.press("u"); await page.waitForTimeout(500);
  results.actions = { inboxUnread: [...gmail.messages.values()].filter(m => m.labelIds.includes("INBOX") && m.labelIds.includes("UNREAD")).length, readCall: mods()[n0], readRow: await row(0).evaluate(e => e.classList.contains("unread")), inboxCount: await page.locator("#folder-list .folder", { hasText: "Inbox" }).locator(".ct").textContent() };
  await page.keyboard.press("s"); await page.waitForTimeout(500);
  results.actions.starCall = mods().at(-1);
  results.actions.starOn = await row(0).locator(".st.on").count();
  const rowsBefore = await page.locator("#rows .row").count();
  const archivedSubject = await page.locator("#r-subject").textContent();
  await page.keyboard.press("e");
  await page.waitForFunction(n => document.querySelectorAll("#rows .row").length === n - 1, rowsBefore, { timeout: 5000 });
  results.actions.archive = { call: mods().at(-1), undo: await page.locator("#st-undo").textContent(), rows: await page.locator("#rows .row").count() };
  await page.keyboard.press("z");
  await page.waitForFunction(n => document.querySelectorAll("#rows .row").length === n, rowsBefore, { timeout: 5000 });
  await page.waitForFunction(s => document.getElementById("r-subject").textContent === s, archivedSubject, { timeout: 4000 }).catch(() => {});
  results.actions.undone = { call: mods().at(-1), subject: await page.locator("#r-subject").textContent(), was: archivedSubject };
  await page.keyboard.press("!"); await page.waitForTimeout(600);
  results.actions.spam = { call: mods().at(-1), undo: await page.locator("#st-undo").textContent() };
  await page.keyboard.press("z"); await page.waitForTimeout(800);
  await page.keyboard.press("#"); await page.waitForTimeout(600);
  results.actions.trash = { call: mods().at(-1), rows: await page.locator("#rows .row").count() };
  // in Trash, delete is for good, after asking
  await folder("Trash");
  await page.locator("#rows .row").first().click(); await page.waitForTimeout(500);
  page.once("dialog", d => d.accept());
  const trashRows = await page.locator("#rows .row").count();
  await page.locator("#list").focus(); await page.keyboard.press("#");
  await page.waitForFunction(n => document.querySelectorAll("#rows .row").length === n - 1, trashRows, { timeout: 5000 }).catch(() => {});
  results.actions.forever = { deleted: gmail.calls.some(c => c.path === "/messages/batchDelete"), rows: trashRows - await page.locator("#rows .row").count(), undo: await page.locator("#st-undo").textContent() };
  // Empty Trash and Mark all read from the folder menus
  page.once("dialog", d => d.accept());
  await page.locator("#folder-list .folder", { hasText: "Trash" }).click({ button: "right" });
  await menu("empty");
  await page.waitForFunction(() => document.querySelector("#rows .list-empty"), null, { timeout: 8000 }).catch(() => {});
  results.folderOps = { emptied: await page.locator("#rows .list-empty").count() === 1 && ![...gmail.messages.values()].some(m => m.labelIds.includes("TRASH")), trashCount: await page.locator("#folder-list .folder", { hasText: "Trash" }).locator(".ct").textContent() };
  await page.locator("#folder-list .folder", { hasText: "Projects" }).first().click({ button: "right" });
  await menu("mark-read");
  await page.waitForFunction(() => !document.querySelector("#folder-list .folder.unread .nm")?.textContent.includes("Projects") || true, null, { timeout: 4000 });
  await page.waitForTimeout(500);
  results.folderOps.markRead = { status: await page.locator("#st-msg").textContent(), unreadLeft: [...gmail.messages.values()].filter(m => m.labelIds.includes("Label_1") && m.labelIds.includes("UNREAD")).length };
  // create, rename (cascading to the subfolder), move and delete folders
  await page.locator("#folder-list .folders-head").click({ button: "right" });
  await menu("new", 0);
  await page.waitForSelector("#promptbox:not(.hidden)");
  await page.keyboard.type("Zeta"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#folder-list .folder .nm")].some(e => e.textContent === "Zeta"), null, { timeout: 5000 });
  await page.locator("#folder-list .folder", { hasText: "Projects" }).first().click({ button: "right" });
  await menu("rename", 0);
  await page.waitForSelector("#promptbox:not(.hidden)");
  await page.keyboard.press("Control+A"); await page.keyboard.type("Work"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#folder-list .folder .nm")].some(e => e.textContent === "Work"), null, { timeout: 5000 });
  await page.locator("#folder-list .folder", { hasText: "Work" }).first().locator(".tw").click();
  await page.waitForTimeout(300);
  results.folderOps.renamed = { names: await page.locator("#folder-list .folder .nm").allTextContents(), labels: gmail.labels.filter(l => l.type === "user").map(l => l.name) };
  await page.locator("#folder-list .folder", { hasText: "Work" }).first().locator(".tw").click();
  page.once("dialog", d => d.accept());
  await page.locator("#folder-list .folder", { hasText: "Zeta" }).click({ button: "right" });
  await menu("delete");
  await page.waitForFunction(() => ![...document.querySelectorAll("#folder-list .folder .nm")].some(e => e.textContent === "Zeta"), null, { timeout: 5000 }).catch(() => {});
  results.folderOps.deleted = !gmail.labels.some(l => l.name === "Zeta") && !(await page.locator("#folder-list .folder .nm").allTextContents()).includes("Zeta");

  // contact card: recent mail with the person, through the search
  await folder("Inbox");
  await page.locator("#rows .row", { hasText: "Subject m-2" }).click(); await page.waitForTimeout(600);
  await page.locator("#r-from .who").first().hover();
  await page.waitForSelector("#card:not(.hidden)", { timeout: 4000 });
  await page.waitForSelector("#card .card-recent div", { timeout: 4000 }).catch(() => {});
  results.card = { head: await page.locator("#card .card-head").textContent(), recent: await page.locator("#card .card-recent div").count(), q: gmail.calls.find(c => c.path === "/messages" && /from:s2@x\.com/.test(c.q.q || ""))?.q?.q };
  await page.mouse.move(5, 600); await page.waitForTimeout(400);

  // print: the open message, images embedded only
  const [printPage] = await Promise.all([ctx.waitForEvent("page"), page.keyboard.press("p")]);
  await printPage.waitForSelector(".msg .body", { timeout: 8000 });
  results.print = { body: (await printPage.locator(".msg .body p").first().innerText()).slice(0, 12), csp: await printPage.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content),
    imgs: await printPage.evaluate(() => [...document.querySelector(".msg .body").shadowRoot.querySelectorAll("img")].map(i => (i.getAttribute("src") || "").slice(0, 15))) };
  await printPage.close(); await page.bringToFront();

  // reply: the quote, the thread and the chained headers
  await page.locator("#rows .row", { hasText: "Subject m-3" }).click(); await page.waitForTimeout(600);
  await page.locator("#list").focus(); await page.keyboard.press("r"); await page.waitForSelector("#compose:not(.hidden)");
  results.reply = { title: await page.locator("#c-title").textContent(), to: (await page.locator("#c-to .chip").allTextContents()).join(" | "), subject: await page.inputValue("#c-subject") };
  await page.locator("#c-editor").focus(); await page.keyboard.type("Thanks!");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Sending in"));
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 10000 });
  const reply = lastUpload();
  results.reply.upload = { path: reply.path, meta: reply.meta, headers: headersOf(reply), parts: partsOf(reply), quoted: /Body of/.test(reply.raw), cid: /cid:/.test(reply.raw) };

  // forward: the original's files travel again as parts
  await page.locator("#rows .row", { hasText: "Subject m-3" }).click(); await page.waitForTimeout(600);
  await page.locator("#list").focus(); await page.keyboard.press("f"); await page.waitForSelector("#compose:not(.hidden)");
  results.fwd = { chips: await page.locator("#c-filelist .c-file").allTextContents() };
  await page.locator("#c-to input").type("fwd@example.com"); await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 15000 });
  results.fwd.parts = partsOf(lastUpload());
  results.fwd.meta = lastUpload().meta;

  // new message with an attachment and an inline image: held, cancelled, then sent
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  await page.locator("#c-to input").type("Alice <alice@example.com>, bob@example.com"); await page.keyboard.press("Tab");
  await page.fill("#c-subject", "Gmail runtime test");
  await page.locator("#c-editor").click({ position: { x: 20, y: 12 } }); await page.keyboard.type("Hello from the Gmail runtime test.");
  await page.setInputFiles("#c-files", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("attached text") });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  await page.locator("#c-editor").click({ position: { x: 300, y: 12 } });
  await page.setInputFiles("#c-imgfile", { name: "shot.png", mimeType: "image/png", buffer: png });
  await page.waitForSelector("#c-editor img");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Sending in"));
  results.send = { pending: await page.locator("#st-undo").textContent() };
  await page.keyboard.press("z");
  await page.waitForSelector("#compose:not(.hidden)");
  results.send.afterCancel = { to: (await page.locator("#c-to .chip").allTextContents()).join(" | "), files: await page.locator("#c-filelist").textContent() };
  const uploadsBefore = gmail.uploads.length;
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 15000 });
  const sent = lastUpload();
  results.send.upload = { path: sent.path, headers: headersOf(sent), parts: partsOf(sent), cid: /src=(3D)?"cid:/.test(sent.raw), uploads: gmail.uploads.length - uploadsBefore, sentLabel: [...gmail.messages.values()].some(m => m.labelIds.includes("SENT") && m.payload.headers.some(x => x.name === "Subject" && x.value === "Gmail runtime test")) };
  results.send.closed = await page.locator("#compose").isHidden();
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("address book:"), null, { timeout: 15000 }).catch(() => {});

  // a draft: opened with its file and inline image, saved again under the same draft id with a
  // new message id, reopened, discarded
  await folder("Drafts");
  const draftRowsBefore = await page.locator("#rows .row").count();
  await page.locator("#rows .row", { hasText: "Re: Subject m-3" }).first().click();
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 15000 });
  results.draft = { title: await page.locator("#c-title").textContent(), chips: await page.locator("#c-filelist .c-file").allTextContents(), to: (await page.locator("#c-to .chip").allTextContents()).join(" | "),
    imgs: await page.locator("#c-editor img").evaluateAll(els => els.map(e => (e.getAttribute("src") || "").slice(0, 15))),
    overlay: await page.evaluate(() => { const b = [...document.querySelectorAll("#c-editor div")].find(d => d.textContent === "Session expired"); return b ? getComputedStyle(b).position : "gone"; }) };
  await page.locator("#c-editor").click({ position: { x: 20, y: 12 } }); await page.keyboard.type("edited ");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("compose").classList.contains("hidden"), null, { timeout: 8000 });
  await page.waitForTimeout(800);
  const saved = lastUpload();
  results.draft.save = { path: saved.path, method: saved.method, meta: saved.meta, parts: partsOf(saved), headers: headersOf(saved), edited: /edited/.test(saved.raw), rows: await page.locator("#rows .row").count(), rowsBefore: draftRowsBefore, drafts: gmail.drafts.map(d => d.id) };
  await page.locator("#rows .row", { hasText: "Re: Subject m-3" }).first().click();
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 15000 });
  results.draft.reopened = { chips: await page.locator("#c-filelist .c-file").allTextContents(), text: (await page.locator("#c-editor").innerText()).slice(0, 20) };
  page.once("dialog", d => d.accept());
  await page.click("#c-discard");
  await page.waitForFunction(() => !document.querySelector("#rows .row"), null, { timeout: 8000 }).catch(() => {});
  results.draft.discarded = { deleteCall: gmail.calls.filter(c => c.method === "DELETE" && /^\/drafts\//.test(c.path)).map(c => c.path), rows: await page.locator("#rows .row").count(), drafts: gmail.drafts.length };

  // address book: learned from Inbox and Sent through the API's pages
  await page.locator("#list").focus(); await page.keyboard.press(",");
  await page.waitForFunction(() => /addresses learned/.test(document.getElementById("ab-summary").textContent), null, { timeout: 5000 }).catch(() => {});
  results.ab = { summary: await page.locator("#ab-summary").textContent(), signOut: await page.locator("#signout").isVisible(), version: await page.locator("#app-version").textContent() };
  await page.keyboard.press("Escape");

  // new mail while the tab is in the background: history names Inbox, the count rises, the dot shows
  await folder("Inbox");
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }));
  gmail.deliver("m99", "Fresh mail");
  await page.waitForFunction(() => document.querySelector('link[rel="icon"]').href.startsWith("data:image/png"), null, { timeout: 15000 }).catch(() => {});
  const dotted = await page.evaluate(() => document.querySelector('link[rel="icon"]').href);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForFunction(() => [...document.querySelectorAll("#rows .row .sb")].some(e => e.textContent.startsWith("Fresh mail")), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  results.newMail = { title: await page.title(), unread: [...gmail.messages.values()].filter(m => m.labelIds.includes("INBOX") && m.labelIds.includes("UNREAD")).length, dotted: dotted.slice(0, 22), listed: await page.locator("#rows .row .sb", { hasText: "Fresh mail" }).count(), history: gmail.calls.filter(c => c.path === "/history").length > 0 };

  // sign out: the token is revoked and forgotten, the sign-in page comes back
  await page.locator("#list").focus(); await page.keyboard.press(",");
  await page.locator("#signout").click();
  await page.waitForSelector("#signin:not(.hidden)", { timeout: 8000 });
  results.signOut = { panel: await page.locator("#signin-none").isVisible(), app: await page.locator("#app").isHidden(), revoked: gmail.calls.some(c => c.path === "/revoke"), token: await page.evaluate(async () => (await chrome.storage.session.get("gmToken")).gmToken ?? null) };

  results.cspViolations = cspViolations;
  console.log(JSON.stringify(results, null, 1));
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });

  const s = results.signIn;
  expect(s.title === "Baltazar Mail for Gmail" && /Sign in with your Google account/.test(s.text) && s.button === "Sign in with Google" && s.link && s.app && s.tab === "Baltazar Mail for Gmail" && s.brand === "Baltazar Mail for Gmail" && s.fails, "the sign-in page in Gmail's words: " + JSON.stringify(s));
  expect(results.signedIn.account === "me@gmail.com" && /Baltazar Mail for Gmail$/.test(results.signedIn.tab), "signed in with the planted token: " + JSON.stringify(results.signedIn));
  const t = results.tree;
  expect(t.names.join(",") === "Inbox,Starred,Drafts,Sent,All Mail,Spam,Trash,Projects,Travel" && t.unread.join() === "Inbox,Projects" && t.counts.join() === "4,2,1,8,32,2,1,3," && t.rows === 8 && t.clips === "00100100" && t.unreadRows === 4, "folder tree from labels: " + JSON.stringify(t));
  const r = results.read;
  expect(r.subject === "Subject m-3" && r.from.includes("s3@x.com") && r.folder === "Inbox" && r.body.startsWith("Body of") && r.imgs[0]?.startsWith("data:image/png") && r.imgs[1]?.startsWith("data:image/png") && r.spacer <= 2 && r.spacer2 <= 6 && /img-src https: data:/.test(r.csp), "reading with the cid image inlined: " + JSON.stringify(r));
  expect(results.attach.cards === 7 && results.attach.labels.join(",") === "PDF,CSV,ZIP,,DOC,XLS,PPT" && results.attach.thumbs.length === 1 && results.attach.thumbs[0].startsWith("data:image/png"), "attachment strip: " + JSON.stringify(results.attach));
  const v = results.viewer;
  expect(v.pdfPages === 2 && v.sandboxFetch === "blocked" && v.download === "report.pdf:true" && v.csv === "Z80,2,6502,1" && v.zip.includes("src/main.c") && v.img === 1 && v.doc && v.sheet === "Item,Cost,Z80,2.5,6502,1.25", "viewer through attachments.get: " + JSON.stringify(v));
  expect(/No preview available for this file \(no preview available\)/.test(v.deck.note) && v.deck.raw === "View as text" && v.deck.text === "not really a deck" && v.deck.label === "" && v.closed, "no converter: the deck is offered as text: " + JSON.stringify(v.deck));
  const u = results.unsafe;
  expect(!u.error && !u.scripts && !u.forms && !u.frames && !u.refresh && !u.handlers && u.link && !u.link.ping && u.link.target === "_blank" && u.pwned === null, "the reader cleans the sender's own HTML: " + JSON.stringify(u));
  expect(!/[‪-‮⁦-⁩]/.test(results.bidi) && results.bidi.includes("Pay eulav") && results.bidi.includes("Bobevil"), "bidi controls removed: " + JSON.stringify(results.bidi));
  expect(results.starred.rows === 2 && results.starred.count === "2" && results.starred.folders.join() === "Projects/FPGA,Inbox" && results.starred.q === "is:starred", "starred view: " + JSON.stringify(results.starred));
  const q = results.search;
  expect(q.chip === "in Projects" && q.inQ && q.outQ && q.title === "“Subject” in Projects" && q.scoped === 5 && /\d+ matches in other folders/.test(q.divider) && q.elseRows >= 20 && q.back === "Projects", "scoped search by label names: " + JSON.stringify(q));
  expect(q.compound.q.includes('(label:"Projects" OR label:"Projects/FPGA") Subject m-2 -from:bob') && q.compound.tip === "Searched for: Subject AND m-2 AND NOT from:bob" && q.compound.rows === 0, "a compound search is one Gmail query: " + JSON.stringify(q.compound));
  const a = results.actions;
  expect(a.readCall?.removeLabelIds?.join() === "UNREAD" && !a.readRow && a.inboxCount === String(a.inboxUnread) && a.starCall?.addLabelIds?.join() === "STARRED" && a.starOn === 1, "read and star: " + JSON.stringify([a.readCall, a.readRow, a.inboxCount, a.inboxUnread, a.starCall, a.starOn]));
  expect(a.archive.call?.removeLabelIds?.join() === "INBOX" && a.archive.call.addLabelIds.length === 0 && /^Undo: archive 1 message/.test(a.archive.undo) && a.archive.rows === 7 && a.undone.call?.addLabelIds?.join() === "INBOX" && a.undone.subject === a.undone.was, "archive to All Mail and back: " + JSON.stringify([a.archive, a.undone]));
  expect(a.spam.call?.addLabelIds?.join() === "SPAM" && a.spam.call.removeLabelIds.join() === "INBOX" && /as spam/.test(a.spam.undo) && a.trash.call?.addLabelIds?.join() === "TRASH" && a.trash.rows === 7, "spam and trash are label moves: " + JSON.stringify([a.spam, a.trash]));
  expect(a.forever.deleted && a.forever.rows === 1, "delete from Trash is for good: " + JSON.stringify(a.forever));
  const fo = results.folderOps;
  expect(fo.emptied && fo.trashCount === "" && /^marked Projects read/.test(fo.markRead.status) && fo.markRead.unreadLeft === 0, "empty Trash and mark all read: " + JSON.stringify([fo.emptied, fo.trashCount, fo.markRead]));
  expect(fo.renamed.labels.includes("Work") && fo.renamed.labels.includes("Work/FPGA") && !fo.renamed.labels.includes("Projects") && fo.renamed.names.includes("Work") && fo.renamed.names.includes("FPGA") && fo.renamed.names.includes("Zeta") && fo.deleted, "folders created, renamed with the subfolder, deleted: " + JSON.stringify(fo.renamed) + " " + fo.deleted);
  expect(results.card.head.includes("s2@x.com") && results.card.recent >= 1 && /\(from:s2@x\.com OR to:s2@x\.com OR cc:s2@x\.com\)/.test(results.card.q || ""), "contact card through a person search: " + JSON.stringify(results.card));
  expect(results.print.body.startsWith("Body of") && /img-src data: https:/.test(results.print.csp) && results.print.imgs.length > 0 && results.print.imgs.every(i => i.startsWith("data:")), "print page with the Gmail image policy: " + JSON.stringify(results.print));
  const rp = results.reply;
  expect(rp.title === "Reply" && rp.to.includes("s3@x.com") && rp.subject === "Re: Subject m-3" && rp.upload.path === "/upload/messages/send" && rp.upload.meta.threadId === "t-m3" && rp.upload.headers["in-reply-to"] === "<m3@x.com>" && rp.upload.headers.references === "<m3@x.com>" && rp.upload.quoted && rp.upload.cid, "a reply joins the thread with chained headers: " + JSON.stringify(rp));
  expect(results.fwd.chips.length === 7 && results.fwd.parts.filter(p => p[2] && !/^inline-/.test(p[2])).length === 7 && results.fwd.parts.some(p => p[2] === "report.pdf") && results.fwd.parts.some(p => p[2] === "deck.pptx") && results.fwd.meta.threadId === "t-m3", "a forward embeds the original's files and stays in its thread: " + JSON.stringify(results.fwd));
  const sd = results.send;
  expect(/^Sending in \d s: send "Gmail runtime test"/.test(sd.pending) && sd.afterCancel.to.includes("alice@example.com") && /note\.txt/.test(sd.afterCancel.files), "undo-send holds and restores: " + JSON.stringify([sd.pending, sd.afterCancel]));
  expect(sd.upload.path === "/upload/messages/send" && sd.upload.headers.to === "Alice <alice@example.com>, bob@example.com" && sd.upload.headers.subject === "Gmail runtime test" && sd.upload.parts.some(p => p[2] === "note.txt") && sd.upload.parts.some(p => p[1] === "image/png" && /^inline-1\.png$/.test(p[2])) && sd.upload.cid && sd.upload.uploads === 1 && sd.upload.sentLabel && sd.closed, "a new message goes out as one upload with its file and inline image: " + JSON.stringify(sd.upload));
  const dr = results.draft;
  expect(dr.title === "Draft" && dr.chips.length === 1 && /^notes\.txt/.test(dr.chips[0]) && dr.to.includes("s3@x.com") && dr.imgs.every(s => s.startsWith("data:")) && dr.imgs.length >= 1 && dr.overlay !== "fixed", "a draft opens with its file and inline image: " + JSON.stringify([dr.title, dr.chips, dr.to, dr.imgs, dr.overlay]));
  expect(dr.save.path === "/upload/drafts/r-d1" && dr.save.method === "PUT" && dr.save.meta.message.threadId === "t-m3" && dr.save.headers["in-reply-to"] === "<m3@x.com>" && dr.save.parts.some(p => p[2] === "notes.txt") && dr.save.parts.some(p => p[1] === "image/png") && dr.save.edited && dr.save.rows === dr.save.rowsBefore && dr.save.drafts.includes("r-d1"), "saving the draft keeps its draft id, file and image: " + JSON.stringify(dr.save));
  expect(dr.reopened.chips.length === 1 && /^notes\.txt/.test(dr.reopened.chips[0]) && dr.reopened.text.includes("edited") && dr.discarded.deleteCall.includes("/drafts/r-d1") && dr.discarded.rows === 0 && dr.discarded.drafts === 0, "the saved draft reopens and discards: " + JSON.stringify([dr.reopened, dr.discarded]));
  expect(/^\d+ addresses learned from Inbox and Sent/.test(results.ab.summary) && results.ab.signOut && /^Baltazar Mail for Gmail \d+\.\d+\.\d+$/.test(results.ab.version), "address book and the sign-out button: " + JSON.stringify(results.ab));
  const nm = results.newMail;
  expect(nm.title === `(${nm.unread}) Baltazar Mail for Gmail` && nm.unread >= 1 && nm.dotted === "data:image/png;base64," && nm.listed === 1 && nm.history, "new mail through history: " + JSON.stringify(nm));
  const so = results.signOut;
  expect(so.panel && so.app && so.revoked && so.token === null, "sign out: " + JSON.stringify(so));
  // Blocked on purpose: the sandbox's own fetch (tried above), images where the reader has them
  // off (Trash), and a cid: source that was never meant to load from the network.
  const unexpectedCsp = (results.cspViolations || []).filter(x => !/img-src ('none|data:\\?")/.test(x) && !/gmail\.googleapis\.com\//.test(x) && !/Loading the image 'cid:/.test(x));
  expect(unexpectedCsp.length === 0, "content security policy blocked something the app needs: " + JSON.stringify(unexpectedCsp.slice(0, 5)));
  expect(!unexpectedHosts.size, "no request left for the real network: " + [...unexpectedHosts].join(", "));
  if (errors.length) { console.error("FAILED:", errors); process.exit(1); }
  console.log("PASS");
})().catch(e => { console.error(e); process.exit(1); });
