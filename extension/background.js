/* Reels Sniffer — service worker.
 * Opens the leaderboard page when the toolbar icon is clicked, or when the
 * content-script panel asks for it. Focuses an existing tab instead of piling
 * up duplicates.
 */
const MANAGER_URL = chrome.runtime.getURL("manager.html");

async function openManager(hash) {
  const tabs = await chrome.tabs.query({ url: MANAGER_URL });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true, url: MANAGER_URL + (hash || "") });
    if (tabs[0].windowId != null) {
      chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: MANAGER_URL + (hash || "") });
  }
}

chrome.action.onClicked.addListener(() => openManager());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "open_manager") openManager(msg.hash || "");
});
