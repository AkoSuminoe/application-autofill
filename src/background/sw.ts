// Service worker: opens the side panel from the toolbar icon or the keyboard shortcut.
import { createStore } from './store';

const transact = createStore(chrome.storage.local);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'bankMutation') return;
  const allowed = ['options.html', 'sidepanel.html'].some(path => sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(path));
  if (sender.id !== chrome.runtime.id || !allowed) { respond({ ok: false, error: 'Storage access denied' }); return false; }
  transact(message.operation).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: String(error.message ?? error) }));
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
