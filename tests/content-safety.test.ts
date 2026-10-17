import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FillResult, ToContent } from '../src/shared/messages';

describe('fresh content-side checks', () => {
  let receive: (msg: ToContent, sender: object, respond: (result: FillResult) => void) => unknown;
  beforeEach(async () => {
    vi.resetModules();
    delete window.__applicationAutofillLoaded;
    document.body.innerHTML = '<label for="name">First name</label><input id="name">';
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => undefined), onMessage: { addListener: (fn: typeof receive) => { receive = fn; } } } });
    await import('../src/content/index');
  });
  afterEach(() => {
    delete window.__applicationAutofillLoaded;
    vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '';
  });
  function fill(extra: Partial<Extract<ToContent, { type: 'fill' }>> = {}) {
    const input = document.querySelector('input')!;
    return new Promise<FillResult>(resolve => receive({ type: 'fill', id: input.getAttribute('data-aa-id')!, value: 'Ada', onlyIfEmpty: true, question: 'First name', pageUrl: location.href, ...extra }, {}, resolve));
  }
  it('does not overwrite a value typed after the panel scan', async () => {
    document.querySelector('input')!.value = 'User typed';
    expect((await fill()).status).toBe('refused');
    expect(document.querySelector('input')!.value).toBe('User typed');
  });
  it('does not fill a question whose label changed after the panel scan', async () => {
    document.querySelector('label')!.textContent = 'Last name';
    expect((await fill()).status).toBe('refused');
    expect(document.querySelector('input')!.value).toBe('');
  });
  it('does not fill a field hidden after detection', async () => {
    document.querySelector('input')!.style.display = 'none';
    expect((await fill()).status).toBe('notFound');
  });
  it('rejects a request addressed to a previous URL', async () => {
    expect((await fill({ pageUrl: 'https://previous.example/' })).status).toBe('refused');
  });
});
