// Content script entry. Scans the page, pushes detected fields to the side panel and fills on request.

import type { FieldsUpdated, FillResult, ToContent } from '../shared/messages';
import { isVisibleInPage, type RawField } from './detect/generic';
import { jobDescription, scanPage, type AtsAdapter } from './detect/registry';
import { fillField } from './fill';

declare global {
  interface Window {
    __applicationAutofillLoaded?: boolean;
  }
}

let adapter: AtsAdapter | null = null;
let adapterUrl = '';
let fields = new Map<string, RawField>();
let lastSignature = '';

function scan(): FieldsUpdated {
  const res = scanPage(document, location, { isVisible: isVisibleInPage });
  if (res.adapter !== adapter || adapterUrl !== location.href) {
    adapterUrl = location.href;
    res.adapter.preload?.(document, location).then((changed) => changed && push());
  }
  adapter = res.adapter;
  fields = new Map(res.raw.map((r) => [r.field.id, r]));
  return { type: 'fieldsUpdated', page: res.page, fields: res.raw.map((r) => r.field) };
}

function push(force = false): void {
  const msg = scan();
  const sig = JSON.stringify([msg.page, msg.fields]);
  if (!force && sig === lastSignature) return;
  // Frames with nothing to report stay quiet unless they previously reported something.
  if (!force && msg.fields.length === 0 && lastSignature === '') return;
  lastSignature = sig;
  chrome.runtime.sendMessage(msg).catch(() => {
    /* Panel closed; nothing is listening. */
  });
}

let timer: number | undefined;
function schedulePush(): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => push(), 400);
}

async function handleFill(msg: Extract<ToContent, { type: 'fill' }>): Promise<FillResult> {
  if (msg.pageUrl && msg.pageUrl !== location.href) return { status: 'refused', detail: 'The page changed. Rescan.' };
  scan();
  const target = fields.get(msg.id);
  if (!target) return { status: 'notFound', detail: 'Field not found. Try Rescan.' };
  if (msg.question !== undefined && msg.question !== target.field.question) return { status: 'refused', detail: 'The question changed. Rescan.' };
  if (msg.onlyIfEmpty && (target.field.currentValue || target.field.sensitive)) return { status: 'refused', detail: 'The field is now filled or needs review.' };
  const result = await fillField(target, msg.value, msg.values);
  schedulePush();
  return result;
}

function init(): void {
  chrome.runtime.onMessage.addListener((msg: ToContent, _sender, sendResponse) => {
    switch (msg.type) {
      case 'scan':
        push(true);
        sendResponse(true);
        return false;
      case 'fill':
        if (!fields.has(msg.id) && !document.querySelector(`[data-aa-id="${CSS.escape(msg.id)}"]`)) return false; // Another frame owns it.
        handleFill(msg).then(sendResponse, e => sendResponse({ status: 'failed', detail: String(e.message ?? e) }));
        return true;
      case 'focus': {
        const t = fields.get(msg.id);
        if (!t) return false;
        t.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        t.el.focus({ preventScroll: true });
        sendResponse(true);
        return false;
      }
      case 'jobDescription':
        if (window !== window.top && fields.size === 0) return false;
        sendResponse(jobDescription(document, adapter ?? scanPage(document, location, { isVisible: isVisibleInPage }).adapter));
        return false;
    }
  });

  new MutationObserver(schedulePush).observe(document.documentElement, { childList: true, subtree: true });
  // Typing doesn't mutate the DOM, so watch input events to keep "already filled" up to date.
  document.addEventListener('input', schedulePush, true);
  document.addEventListener('change', schedulePush, true);
  push();
}

if (!window.__applicationAutofillLoaded) {
  window.__applicationAutofillLoaded = true;
  init();
}
