// Service worker: opens the side panel from the toolbar icon or the keyboard shortcut.
import { createStore } from './store';

const transact = createStore(chrome.storage.local);
// Content scripts only need the one answer explicitly sent for a fill, not the bank or keys.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
storageReady.catch(() => console.error('Could not restrict local storage access. Bank access is disabled.'));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'bankMutation') return;
  const allowed = ['options.html', 'sidepanel.html'].some(path => sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(path));
  if (sender.id !== chrome.runtime.id || !allowed) { respond({ ok: false, error: 'Storage access denied' }); return false; }
  void (async () => {
    try {
      await storageReady;
      const data = await transact(message.operation);
      respond({ ok: true, data });
    } catch (error) {
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(tab => {
  if (tab.id !== undefined) chrome.runtime.sendMessage({ type: 'activeTabGranted', tabId: tab.id }).catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-panel' && tab?.id !== undefined) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
    chrome.runtime.sendMessage({ type: 'activeTabGranted', tabId: tab.id }).catch(() => {});
  }
});
