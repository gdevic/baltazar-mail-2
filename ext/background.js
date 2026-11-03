// Toolbar button opens the client in its own tab, reusing an existing one if present.
// rules.js holds what the provider's API needs from the service worker besides this.
import "./rules.js";

const PAGE = chrome.runtime.getURL("mail.html");

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: PAGE });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: PAGE });
  }
});

// The new-mail dot on the toolbar button belongs to an open mail tab; with none left, the
// button returns to the plain icon.
chrome.tabs.onRemoved.addListener(async () => {
  if (!(await chrome.tabs.query({ url: PAGE })).length) chrome.action.setIcon({ path: { 16: "icons/16.png", 32: "icons/32.png" } }).catch(() => {});
});
