// Side panel: lists detected questions with matched answers; copy, fill, edit & save.

import { clear, h } from '../shared/dom';
import { measure, trimToLastSentence, withinLimit } from '../shared/limits';
import { hasWording, matchField, type MatchCandidate } from '../shared/matcher';
import type { FieldsUpdated, FillResult, ToContent } from '../shared/messages';
import { SENSITIVE_LABELS, newAnswerId, type Bank, type DetectedField, type PageInfo } from '../shared/schema';
import { loadBank, onBankChanged, mutate, diffFields } from '../shared/storage';

import { scopeFor, scopeAllows, companyDependent } from '../shared/scope';
import { enableSite, type SiteTarget } from '../shared/site-access';

// ---- State ----

interface FrameData {
  documentId?: string;
  page: PageInfo;
  fields: DetectedField[];
}

let bank: Bank;
let tabId: number | null = null;
let windowId: number | null = null;
let scriptMissing = false;
const frames = new Map<number, FrameData>();
/** Keyed by `${frameId}:${fieldId}`. */
const chosen = new Map<string, number>();
const editing = new Map<string, { text: string; saveAsNew: boolean; saving?: boolean; values?: string[]; base?: import('../shared/schema').AnswerEntry }>();
const results = new Map<string, FillResult & { at: number }>();
const trimmed = new Map<string, string>();
const cardCache = new Map<string, HTMLElement>();
let busy = false;
let epoch = 0;
let siteTarget: SiteTarget | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const keyOf = (frameId: number, fieldId: string) => `${frameId}:${fieldId}`;

// ---- Tab / content-script plumbing ----

async function send<T>(msg: ToContent, frameId?: number): Promise<T | undefined> {
  if (tabId === null) return undefined;
  return chrome.tabs.sendMessage(tabId, msg, frameId === undefined ? undefined : { frameId }) as Promise<T | undefined>;
}

// sidepanel.html?tabId=N pins the panel to one tab (used for debugging and end-to-end tests).
const pinnedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

async function attachToActiveTab(): Promise<void> {
  const generation = ++epoch;
  const [tab] = pinnedTabId ? [await chrome.tabs.get(pinnedTabId)] : await chrome.tabs.query({ active: true, windowId: windowId ?? undefined });
  if (generation !== epoch) return;
  tabId = tab?.id ?? null;
  siteTarget = tabId !== null && tab?.url ? { tabId, url: tab.url } : null;
  frames.clear();
  chosen.clear();
  editing.clear();
  results.clear();
  trimmed.clear();
  cardCache.clear();
  await rescan();
}

async function rescan(): Promise<void> {
  if (tabId === null) return;
  try {
    await send({ type: 'scan' });
    scriptMissing = false;
  } catch {
    scriptMissing = true;
  }
  render();
}

async function enableOnThisSite(): Promise<void> {
  const target = siteTarget;
  const generation = epoch;
  try {
    await enableSite(target, () => generation === epoch && tabId === target?.tabId);
    await rescan();
  } catch (e) { setNotice((e as Error).message); }
}

chrome.runtime.onMessage.addListener((msg: FieldsUpdated | { type: 'activeTabGranted'; tabId: number }, sender) => {
  if (msg?.type === 'activeTabGranted' && msg.tabId === tabId) { attachToActiveTab(); return; }
  if (msg?.type !== 'fieldsUpdated' || sender.tab?.id !== tabId) return;
  const oldFrame = frames.get(sender.frameId ?? 0);
  if (oldFrame && (oldFrame.page.url !== msg.page.url || oldFrame.documentId !== sender.documentId)) {
    epoch++; chosen.clear(); editing.clear(); results.clear(); trimmed.clear(); cardCache.clear();
  }
  scriptMissing = false;
  frames.set(sender.frameId ?? 0, { page: msg.page, fields: msg.fields, documentId: sender.documentId });
  render();
});

chrome.tabs.onActivated.addListener((info) => {
  if (info.windowId === windowId && !pinnedTabId) attachToActiveTab();
});

chrome.tabs.onUpdated.addListener((id, change) => {
  if (id !== tabId) return;
  if (change.status === 'loading' || change.url) {
    epoch++; siteTarget = null; frames.clear(); chosen.clear(); editing.clear(); results.clear(); trimmed.clear(); cardCache.clear(); render();
  }
  if (change.status === 'complete') attachToActiveTab();
});

// ---- Matching / derived data ----

interface Row {
  tabId: number;
  page: PageInfo;
  documentId?: string;
  key: string;
  frameId: number;
  field: DetectedField;
  candidates: MatchCandidate[];
  pick: MatchCandidate | null;
  answer: string;
}

function rows(): Row[] {
  const out: Row[] = [];
  const minShow = bank.settings.matching.minShow;
  for (const [frameId, data] of [...frames.entries()].sort((a, b) => a[0] - b[0])) {
    for (const field of data.fields) {
      const key = keyOf(frameId, field.id);
      // Keep strong question matches whose answer fits no option, so the warning and the option picker can show.
      const high = bank.settings.matching.highConfidence;
      const candidates = matchField(field, bank, 3, data.page).filter((c) => c.score >= minShow || c.source === 'profile' || (c.optionMissing && c.questionScore >= high));
      const pick = candidates[chosen.get(key) ?? 0] ?? null;
      out.push({ key, frameId, tabId: tabId!, page: data.page, documentId: data.documentId, field, candidates, pick, answer: trimmed.get(key) ?? pick?.answer ?? '' });
    }
  }
  return out;
}

function isHigh(r: Row): boolean {
  return !!r.pick && r.pick.score >= bank.settings.matching.highConfidence;
}

/** Reasons a row is excluded from "Fill all high-confidence". Empty = eligible. */
function bulkBlockers(r: Row): string[] {
  const out: string[] = [];
  if (r.field.kind === 'file') out.push('file');
  if (!r.pick || !isHigh(r)) out.push('low');
  if (r.field.sensitive) out.push('sensitive');
  if (r.pick?.reviewRequired || r.pick?.scopeWarning) out.push('review');
  if (r.pick?.sensitive) out.push('sensitive');
  if (r.pick?.polarityWarning) out.push('polarity');
  if (r.pick?.optionMissing) out.push('option');
  if (r.field.currentValue) out.push('filled');
  if (!withinLimit(r.answer, r.field.limit)) out.push('long');
  return out;
}

// ---- Actions ----

async function learn(r: Row): Promise<void> {
  const c = r.pick;
  if (!c || c.source !== 'answer' || c.scopeWarning || c.polarityWarning || c.reviewRequired || trimmed.has(r.key)) return;
  await mutate({ kind: 'learn', id: c.entryId!, question: r.field.question, company: r.page.company, answer: c.rawAnswer, values: c.rawValues });
}

async function fill(r: Row, value: string, onlyIfEmpty = false): Promise<FillResult> {
  let res: FillResult;
  try {
    res = (await chrome.tabs.sendMessage(r.tabId, { type: 'fill', id: r.field.id, value, values: r.pick?.values, pageUrl: r.page.url, question: r.field.question, onlyIfEmpty }, r.documentId ? { documentId: r.documentId } : { frameId: r.frameId })) ?? { status: 'failed', detail: 'No response from the page.' };
  } catch (e) {
    res = { status: 'failed', detail: String((e as Error).message ?? e) };
  }
  results.set(r.key, { ...res, at: Date.now() });
  if (res.status === 'ok') { try { await learn(r); } catch (e) { setNotice(`Filled, but could not save usage: ${(e as Error).message}`); } }
  return res;
}

async function fillAll(): Promise<void> {
  if (busy) return;
  busy = true;
  const generation = epoch;
  const todo = rows().filter(r => bulkBlockers(r).length === 0);
  let ok = 0;
  render();
  try {
    for (const original of todo) {
      if (generation !== epoch) break;
      const r = rows().find(row => row.key === original.key);
      if (!r || r.page.url !== original.page.url || bulkBlockers(r).length) continue;
      const res = await fill(r, r.answer, true);
      if (res.status === 'ok') ok++;
      render();
    }
    setNotice(generation !== epoch ? 'Filling stopped because the page changed.' : `Filled ${ok} of ${todo.length} fields. Review everything before you submit.`);
  } finally { busy = false; render(); }
}

async function saveEdit(r: Row): Promise<void> {
  const ed = editing.get(r.key);
  if (!ed || ed.saving) return;
  const text = ed.values?.length ? ed.values.join(', ') : ed.text.trim();
  if (!text) return;
  const now = Date.now();
  ed.saving = true;
  const controls = cardCache.get(r.key)?.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea');
  controls?.forEach(c => { c.disabled = true; });
  try {
    const target = !ed.saveAsNew && r.pick?.source === 'answer' ? ed.base : undefined;
    const scope = companyDependent(r.field.question) || target?.scope?.type === 'company'
      ? (r.page.company.trim() ? { type: 'company' as const, company: r.page.company.trim() } : { type: 'unassigned' as const })
      : scopeFor(r.field.question, r.page);
    if (target && scopeAllows(target, r.page)) {
      const updated = { ...target, answer: text, values: ed.values, questions: hasWording(target, r.field.question) ? target.questions : [...target.questions, r.field.question], scope };
      await mutate({ kind: 'editAnswer', id: target.id, patches: diffFields(target, updated) });
    } else {
      await mutate({ kind: 'addAnswer', entry: {
        id: newAnswerId(), questions: [r.field.question], answer: text, values: ed.values,
        scope, kind: r.field.options.length ? 'choice' : 'text', tags: [], sensitive: r.field.sensitive ?? undefined,
        createdAt: now, updatedAt: now, timesUsed: 0, lastUsedAt: null,
      } });
    }
  } catch (e) { ed.saving = false; controls?.forEach(c => { c.disabled = false; }); setNotice((e as Error).message); return; }
  editing.delete(r.key);
  chosen.delete(r.key);
  trimmed.delete(r.key);
  cardCache.delete(r.key);
  render();
}

// ---- Rendering ----

let notice = '';
function setNotice(t: string): void {
  notice = t;
  render();
}

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function confidenceClass(score: number): string {
  if (score >= bank.settings.matching.highConfidence) return 'conf-high';
  if (score >= 0.6) return 'conf-mid';
  return 'conf-low';
}

const KIND_LABEL: Record<DetectedField['kind'], string> = {
  text: 'Text',
  textarea: 'Long text',
  select: 'Dropdown',
  radio: 'Choice',
  checkbox: 'Tick box',
  checkboxGroup: 'Tick boxes',
  combobox: 'Dropdown',
  file: 'Upload',
};

function renderCard(r: Row): HTMLElement {
  const { field, pick } = r;
  const ed = editing.get(r.key);
  const res = results.get(r.key);
  const tooLong = !!pick && !withinLimit(r.answer, field.limit);

  const badges = h(
    'div',
    { class: 'badges' },
    h('span', { class: 'badge' }, KIND_LABEL[field.kind]),
    field.required && h('span', { class: 'badge badge-req' }, 'Required'),
    field.sensitive && h('span', { class: 'badge badge-warn', title: 'Always check this one yourself' }, `⚠ ${SENSITIVE_LABELS[field.sensitive]}`),
    pick && h('span', { class: `badge ${confidenceClass(pick.score)}`, title: `Matched: ${pick.matchedWording}` }, pct(pick.score)),
    field.limit && (field.kind === 'textarea' || measure(r.answer, field.limit.unit) > field.limit.max * 0.5) &&
      h('span', { class: `badge ${tooLong ? 'badge-err' : ''}` }, `${measure(ed?.text ?? r.answer, field.limit.unit)}/${field.limit.max}${field.limit.unit === 'words' ? ' words' : ''}`),
    field.currentValue && h('span', { class: 'badge badge-done', title: field.currentValue }, 'Filled'),
  );

  const head = h(
    'button',
    { class: 'q', title: 'Show on page', onclick: () => send({ type: 'focus', id: field.id }, r.frameId).catch(() => {}) },
    field.question || '(no label)',
  );

  const body: (Node | false | null)[] = [];
  if (field.description) body.push(h('p', { class: 'desc' }, field.description.length > 220 ? field.description.slice(0, 220) + '…' : field.description));

  if (field.kind === 'file') {
    body.push(h('p', { class: 'muted' }, 'Upload this one yourself.'));
    return h('article', { class: 'card' }, head, badges, ...body);
  }

  if (ed) {
    const choice = field.options.length > 0 && !field.multiple;
    const input = field.multiple && field.options.length
      ? h('div', { class: 'edit' }, field.options.map(o => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ed.values?.includes(o) ?? false, onchange: (e: Event) => { const selected = new Set(ed.values ?? []); if ((e.target as HTMLInputElement).checked) selected.add(o); else selected.delete(o); ed.values = [...selected]; ed.text = ed.values.join(', '); } }), o)))
      : choice
      ? h(
          'select',
          { class: 'edit', onchange: (e: Event) => (ed.text = (e.target as HTMLSelectElement).value) },
          h('option', { value: '' }, 'Choose…'),
          field.options.map((o) => h('option', { value: o, selected: o === ed.text }, o)),
        )
      : h('textarea', {
          class: 'edit',
          rows: field.kind === 'textarea' ? 6 : 2,
          value: field.multiple ? (ed.values ?? []).join('\n') : ed.text,
          placeholder: field.multiple ? 'One complete option per line' : '',
          oninput: (e: Event) => {
            ed.text = (e.target as HTMLTextAreaElement).value;
            if (field.multiple) ed.values = ed.text.split('\n').map(v => v.trim()).filter(Boolean);
            const counter = card.querySelector('.live-count');
            if (counter && field.limit) counter.textContent = `${measure(ed.text, field.limit.unit)}/${field.limit.max}`;
          },
        });
    const canUpdate = pick?.source === 'answer';
    const card = h(
      'article',
      { class: 'card editing' },
      head,
      badges,
      ...body,
      input,
      field.limit && h('div', { class: 'muted live-count' }, `${measure(ed.text, field.limit.unit)}/${field.limit.max}`),
      canUpdate &&
        h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', checked: ed.saveAsNew, onchange: (e: Event) => (ed.saveAsNew = (e.target as HTMLInputElement).checked) }),
          ' Save as a separate answer (don’t change the matched one)',
        ),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'primary', onclick: () => saveEdit(r) }, 'Save'),
        h('button', { onclick: () => { editing.delete(r.key); cardCache.delete(r.key); render(); } }, 'Cancel'),
      ),
    );
    return card;
  }

  if (pick) {
    if (r.candidates.length > 1) {
      body.push(
        h(
          'select',
          {
            class: 'alts',
            onchange: (e: Event) => {
              chosen.set(r.key, Number((e.target as HTMLSelectElement).value));
              trimmed.delete(r.key);
              render();
            },
          },
          r.candidates.map((c, i) =>
            h('option', { value: String(i), selected: c === pick }, `${pct(c.score)} · ${c.source === 'profile' ? c.matchedWording : c.matchedWording.slice(0, 60)}`),
          ),
        ),
      );
    }
    body.push(h('div', { class: 'answer' }, r.answer));
    if (pick.scopeWarning) body.push(h('p', { class: 'warn' }, 'Company not verified: excluded from Fill all. Review carefully, or edit and save a copy for this company.'));
    if (pick.reviewRequired) body.push(h('p', { class: 'warn' }, 'Ambiguous match. Review this answer manually.'));
    if (pick.polarityWarning) body.push(h('p', { class: 'warn' }, 'This question is worded the opposite way to the saved one. Check the Yes/No.'));
    if (pick.optionMissing) body.push(h('p', { class: 'warn' }, `The saved answer doesn’t match any option. Options: ${field.options.slice(0, 8).join(' · ')}`));
    if (tooLong && field.limit) {
      const t = trimToLastSentence(r.answer, field.limit);
      body.push(
        h(
          'p',
          { class: 'warn' },
          `Too long for this field (${measure(r.answer, field.limit.unit)}/${field.limit.max}). `,
          t
            ? h('button', { class: 'link', onclick: () => { trimmed.set(r.key, t); render(); } }, 'Trim to last full sentence')
            : 'Edit it down before filling.',
        ),
      );
    }
  } else {
    body.push(h('p', { class: 'muted' }, 'No saved answer yet.'));
  }

  if (res) {
    const ok = res.status === 'ok';
    body.push(h('p', { class: ok ? 'ok' : 'warn' }, ok ? `Filled${res.detail ? ` (${res.detail})` : ''}` : `Couldn’t fill: ${res.detail ?? res.status}`));
  }

  const startEdit = () => {
    editing.set(r.key, { text: r.answer, values: field.multiple ? [...(pick?.values ?? [])] : undefined, base: pick?.entryId ? structuredClone(bank.answers.find(a => a.id === pick.entryId)) : undefined, saveAsNew: !!pick && pick.source === 'answer' && (!isHigh(r) || !!pick.scopeWarning) });
    cardCache.delete(r.key);
    render();
  };

  const actions = h(
    'div',
    { class: 'actions' },
    pick &&
      h('button', {
        onclick: async (e: Event) => {
          await navigator.clipboard.writeText(r.answer);
          const b = e.target as HTMLButtonElement;
          b.textContent = 'Copied';
          setTimeout(() => (b.textContent = 'Copy'), 1200);
        },
      }, 'Copy'),
    pick &&
      h('button', {
        class: 'primary',
        disabled: tooLong || busy || !!pick.optionMissing,
        title: tooLong ? 'Answer is over the limit' : '',
        onclick: async () => { await fill(r, r.answer); render(); },
      }, 'Fill'),
    h('button', { onclick: startEdit }, pick ? 'Edit & save' : 'Write answer'),
  );

  return h('article', { class: `card${field.sensitive ? ' sensitive' : ''}` }, head, badges, ...body, actions);
}

function render(): void {
  if (!bank) return;
  const app = $('app');
  const all = rows();
  const page = [...frames.values()].find((f) => f.fields.length)?.page ?? [...frames.values()][0]?.page;

  const header = $('header');
  clear(header);
  if (page) {
    header.append(
      h('div', { class: 'title' }, page.jobTitle || 'Application form'),
      h('div', { class: 'muted' }, [page.company, page.ats].filter(Boolean).join(' · ')),
    );
  }
  const eligible = all.filter((r) => bulkBlockers(r).length === 0).length;
  const flagged = all.filter((r) => r.field.sensitive).length;
  const matched = all.filter((r) => r.pick).length;
  header.append(
    h(
      'div',
      { class: 'stats' },
      `${all.length} fields · ${matched} matched · ${all.filter(isHigh).length} high · ${flagged} flagged`,
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', disabled: busy || eligible === 0, onclick: fillAll }, busy ? 'Filling…' : `Fill all high-confidence (${eligible})`),
      h('button', { onclick: () => { cardCache.clear(); rescan(); } }, 'Rescan'),
      h('button', { onclick: () => chrome.runtime.openOptionsPage() }, 'Answer bank'),
    ),
    notice ? h('p', { class: 'notice' }, notice) : '',
  );

  clear(app);
  if (scriptMissing) {
    app.append(
      h(
        'div',
        { class: 'empty' },
        h('p', null, 'Autofill isn’t running on this page.'),
        h('p', { class: 'muted' }, 'Greenhouse pages work automatically. For other sites, allow access to this site only.'),
        h('button', { class: 'primary', onclick: enableOnThisSite }, 'Enable on this site'),
      ),
    );
    return;
  }
  if (all.length === 0) {
    app.append(h('div', { class: 'empty' }, h('p', null, 'No form fields found yet.'), h('p', { class: 'muted' }, 'Open the application form, then press Rescan.')));
    return;
  }
  const seen = new Set<string>();
  for (const r of all) {
    seen.add(r.key);
    // Cards being edited are kept as-is so typing isn't interrupted by page updates.
    const cached = editing.has(r.key) ? cardCache.get(r.key) : undefined;
    const card = cached ?? renderCard(r);
    cardCache.set(r.key, card);
    app.append(card);
  }
  for (const k of [...cardCache.keys()]) if (!seen.has(k)) cardCache.delete(k);
}

// ---- Boot ----

(async () => {
  bank = await loadBank();
  onBankChanged((b) => {
    bank = b;
    render();
  });
  windowId = (await chrome.windows.getCurrent()).id ?? null;
  await attachToActiveTab();
})().catch(e => { $('app').textContent = e.message; });
