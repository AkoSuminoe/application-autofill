export interface SiteTarget { tabId: number; url: string }

/** Called directly by the Enable click: request() must run before awaiting anything. */
export async function enableSite(target: SiteTarget | null, stillCurrent: () => boolean): Promise<void> {
  if (!target) throw new Error('Click the extension icon or press Alt+Shift+F on this tab first, then try again.');
  let url: URL;
  try { url = new URL(target.url); } catch { throw new Error('This page has no accessible URL.'); }
  if (url.protocol !== 'https:') throw new Error('Only https:// pages can be enabled.');
  if (!stillCurrent()) throw new Error('The active tab changed. Try again.');
  const pattern = `https://${url.hostname}/*`;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error('Site access was not granted.');
  const verify = async () => {
    const tab = await chrome.tabs.get(target.tabId);
    if (!stillCurrent() || !tab.active || tab.url !== target.url) throw new Error('The page changed while requesting access. Try again on the current page.');
  };
  await verify();
  const id = `site-${url.hostname}`;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!existing.length) await chrome.scripting.registerContentScripts([
    { id, matches: [pattern], js: ['content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true },
  ]);
  await verify();
  // Check the URL in the injected isolated world too, closing the navigation race after tabs.get.
  const frames = await chrome.scripting.executeScript({ target: { tabId: target.tabId, allFrames: true }, func: () => location.href });
  if (frames.find(f => f.frameId === 0)?.result !== target.url) throw new Error('The page changed before injection. Try again.');
  for (const frame of frames) {
    if (!stillCurrent()) throw new Error('The active tab changed.');
    if (!frame.documentId || typeof frame.result !== 'string' || new URL(frame.result).origin !== url.origin) continue;
    await chrome.scripting.executeScript({ target: { tabId: target.tabId, documentIds: [frame.documentId] }, files: ['content.js'] });
  }
}
