import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableSite } from '../src/shared/site-access';

describe('narrow site permission', () => {
  let api: { permissions: { request: ReturnType<typeof vi.fn> }; tabs: { get: ReturnType<typeof vi.fn> }; scripting: { getRegisteredContentScripts: ReturnType<typeof vi.fn>; registerContentScripts: ReturnType<typeof vi.fn>; executeScript: ReturnType<typeof vi.fn> } };
  const target = { tabId: 7, url: 'https://careers.example.org/application' };
  beforeEach(() => {
    api = {
      permissions: { request: vi.fn(async () => true) },
      tabs: { get: vi.fn(async () => ({ id: 7, active: true, url: target.url })) },
      scripting: {
        getRegisteredContentScripts: vi.fn(async () => []), registerContentScripts: vi.fn(async () => undefined),
        executeScript: vi.fn(async () => [{ frameId: 0, documentId: 'doc-1', result: target.url }]),
      },
    };
    vi.stubGlobal('chrome', api);
  });
  afterEach(() => vi.unstubAllGlobals());
  it('requests only the site, synchronously from the click, then injects into the verified document', async () => {
    const result = enableSite(target, () => true);
    expect(api.permissions.request).toHaveBeenCalledWith({ origins: ['https://careers.example.org/*'] });
    await result;
    expect(api.scripting.executeScript).toHaveBeenLastCalledWith({ target: { tabId: 7, documentIds: ['doc-1'] }, files: ['content.js'] });
  });
  it('explains the extension gesture when URL access is missing', async () => {
    await expect(enableSite(null, () => true)).rejects.toThrow('extension icon');
    expect(api.permissions.request).not.toHaveBeenCalled();
  });
  it('does not inject after denied permission', async () => {
    api.permissions.request.mockResolvedValue(false);
    await expect(enableSite(target, () => true)).rejects.toThrow('not granted');
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });
  it('does not inject after navigation or an active-tab switch during the permission prompt', async () => {
    api.tabs.get.mockResolvedValue({ active: true, url: 'https://other.example/' });
    await expect(enableSite(target, () => true)).rejects.toThrow('page changed');
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    api.tabs.get.mockResolvedValue({ active: false, url: target.url });
    await expect(enableSite(target, () => true)).rejects.toThrow('page changed');
  });
  it('detects navigation between verification and injection', async () => {
    api.scripting.executeScript.mockResolvedValue([{ frameId: 0, documentId: 'new-doc', result: 'https://careers.example.org/other' }]);
    await expect(enableSite(target, () => true)).rejects.toThrow('before injection');
    expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
  });
  it('rejects unsupported protocols without prompting', async () => {
    await expect(enableSite({ ...target, url: 'chrome://extensions/' }, () => true)).rejects.toThrow('https');
    expect(api.permissions.request).not.toHaveBeenCalled();
  });
});
