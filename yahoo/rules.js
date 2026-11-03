// The /c/ edge proxy rejects batch calls whose Origin is not mail.yahoo.com (error EP-4010).
// Rewrite Origin and Referer on this extension's own requests so they match the web client's.
// The Gmail extension's rules.js is an empty module: its API needs no such rule.
const RULES = [{
  id: 1, priority: 1,
  action: {
    type: "modifyHeaders",
    requestHeaders: [
      { header: "Origin", operation: "set", value: "https://mail.yahoo.com" },
      { header: "Referer", operation: "set", value: "https://mail.yahoo.com/" },
    ],
  },
  condition: {
    urlFilter: "||mail.yahoo.com/",
    initiatorDomains: [chrome.runtime.id],
    resourceTypes: ["xmlhttprequest"],
  },
}];

let installing = null;
function installRules() {
  if (!installing) installing = chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: RULES.map(r => r.id), addRules: RULES })
    .finally(() => { installing = null; });
  return installing;
}
chrome.runtime.onStartup.addListener(() => installRules());
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "ensureRules") { installRules().then(() => reply(true), () => reply(false)); return true; }
});
installRules();
