// Writes values into page controls in a way React/Vue-controlled forms register.
// Hard rule: never submit, never navigate. Only form controls and dropdown options are ever clicked.

import { withinLimit } from '../shared/limits';
import { resolveOption, resolveMultiple } from '../shared/matcher';
import { normalizeText } from '../shared/normalize';
import type { FillResult } from '../shared/messages';
import type { DetectedField } from '../shared/schema';
import { comboboxDisplayValue, comboboxValues, textOf } from './detect/generic';

export interface FillTarget {
  el: HTMLElement;
  controls: HTMLElement[];
  field: DetectedField;
}

// ---- Safety ----

const FORBIDDEN = 'button, a[href], input[type="submit"], input[type="button"], input[type="image"], input[type="reset"]';

/** Click only radios, checkboxes and dropdown options; refuse anything that could submit or navigate. */
export function safeClick(el: HTMLElement): boolean {
  if (el.matches(':disabled, [aria-disabled="true"]')) return false;
  if (el.matches(FORBIDDEN) || el.closest('button, a[href]')) return false;
  const isToggle = el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox');
  const isOption = el.getAttribute('role') === 'option' || /(^|[\s_-])option($|[\s_-])|__option/.test(el.className);
  if (!isToggle && !isOption) return false;
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  el.click();
  return true;
}

// ---- Primitives ----

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  // Call the prototype setter so React's value tracker notices the change.
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fire(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function key(el: Element, k: string): void {
  const init: KeyboardEventInit = { key: k, code: k, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

async function waitFor<T>(fn: () => T | null | undefined, timeout = 1500, interval = 50): Promise<T | null> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}

function highlight(el: HTMLElement): void {
  const target = (el.closest('[class*="control"]') as HTMLElement | null) ?? el;
  const prev = target.style.outline;
  target.style.outline = '2px solid #2f6f4f';
  setTimeout(() => (target.style.outline = prev), 1200);
}

const isYes = (v: string) => /^(yes|y|true|1|checked|on|i agree|agree)\b/i.test(v.trim());

function labelText(control: HTMLElement): string {
  const labels = (control as HTMLInputElement).labels;
  if (labels?.length) return textOf(labels[0]);
  const wrap = control.closest('label');
  if (wrap) return textOf(wrap);
  return control.getAttribute('aria-label') ?? (control as HTMLInputElement).value ?? '';
}

// ---- Per-kind fillers ----

function fillText(el: HTMLInputElement | HTMLTextAreaElement, value: string): FillResult {
  el.focus();
  setNativeValue(el, value);
  fire(el, 'input');
  fire(el, 'change');
  el.blur();
  if (el.value === value) return { status: 'ok' };
  // Some fields reformat input (e.g. phone numbers lose their spaces).
  return el.value ? { status: 'ok', detail: `page reformatted it to "${el.value}"` } : { status: 'failed', detail: 'The page cleared the value.' };
}

function fillSelect(el: HTMLSelectElement, value: string, values?: string[]): FillResult {
  const opts = Array.from(el.options).filter(o => !o.disabled && !o.closest('optgroup[disabled]') && o.value !== '');
  if (el.multiple) {
    const wanted = resolveMultiple(value, opts.map(o => o.text.trim()), values);
    if (!wanted) return { status: 'optionMissing', detail: 'Choose each option explicitly.' };
    for (const option of el.options) option.selected = wanted.includes(option.text.trim());
    fire(el, 'input'); fire(el, 'change'); el.blur();
    return sameSelection(wanted, Array.from(el.selectedOptions).map(o => o.text.trim())) ? { status: 'ok' } : { status: 'failed', detail: 'Only part of the selection was applied.' };
  }
  const pick = resolveOption(value, opts.map((o) => o.text.trim()));
  const option = pick && opts.find((o) => o.text.trim() === pick.option);
  if (!option) return { status: 'optionMissing', detail: `No option matches "${value}".` };
  el.focus();
  setNativeValue(el, option.value);
  option.selected = true;
  fire(el, 'input');
  fire(el, 'change');
  el.blur();
  return el.value === option.value ? { status: 'ok' } : { status: 'failed', detail: 'The selection did not stick.' };
}

function fillRadio(controls: HTMLElement[], value: string): FillResult {
  const labels = controls.map(labelText);
  const pick = resolveOption(value, labels);
  if (!pick) return { status: 'optionMissing', detail: `No option matches "${value}".` };
  const target = controls[labels.indexOf(pick.option)] as HTMLInputElement;
  if (!target.checked && !safeClick(target)) return { status: 'refused' };
  return target.checked ? { status: 'ok' } : { status: 'failed' };
}

function fillCheckbox(el: HTMLInputElement, value: string): FillResult {
  const want = isYes(value);
  if (el.checked !== want && !safeClick(el)) return { status: 'refused' };
  return el.checked === want ? { status: 'ok' } : { status: 'failed' };
}

function fillCheckboxGroup(controls: HTMLElement[], values: string[]): FillResult {
  const labels = controls.map(labelText);
  const wanted = new Set<number>();
  for (const v of values) {
    const pick = resolveOption(v, labels);
    if (!pick) return { status: 'optionMissing', detail: `No option matches "${v}".` };
    wanted.add(labels.indexOf(pick.option));
  }
  controls.forEach((c, i) => {
    const box = c as HTMLInputElement;
    if (box.checked !== wanted.has(i)) safeClick(box);
  });
  return controls.every((c, i) => (c as HTMLInputElement).checked === wanted.has(i)) ? { status: 'ok' } : { status: 'failed', detail: 'Only part of the selection was applied.' };
}

function sameSelection(wanted: string[], actual: string[]): boolean {
  const key = (s: string) => s.normalize('NFKC').trim().toLowerCase();
  const a = new Set(actual.map(key)), b = new Set(wanted.map(key));
  return a.size === b.size && [...a].every(v => b.has(v));
}

/**
 * Options of this combobox's open menu only. Scoped to its listbox (or its own widget) so that
 * unrelated always-present lists, like a phone widget's hidden country list, are never picked.
 */
function visibleOptions(doc: Document, input: HTMLElement): HTMLElement[] {
  if (input.getAttribute('aria-expanded') === 'false') return [];
  const listId = input.getAttribute('aria-controls') ?? input.getAttribute('aria-owns');
  const scope = (listId && doc.getElementById(listId)) || input.closest('[class*="container"], [class*="shell"]');
  if (!scope) return [];
  return Array.from(scope.querySelectorAll<HTMLElement>('[role="option"], [class*="__option"], [id*="-option-"]')).filter(
    (o) => !o.matches('[aria-disabled="true"]') && !o.closest('[hidden], [aria-hidden="true"]') && textOf(o),
  );
}

function typeInto(input: HTMLInputElement, text: string): void {
  setNativeValue(input, text);
  fire(input, 'input');
  // Some wrappers (Greenhouse) open the menu on keyup rather than on input.
  key(input, text.slice(-1) || 'Backspace');
}

/** Open the menu the way a mouse click would. Greenhouse opens on mouseup, react-select on mousedown. */
function openMenu(input: HTMLInputElement): void {
  const control = (input.closest('[class*="control"]') as HTMLElement | null) ?? input;
  if (control.closest('button, a[href]')) return;
  control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
}

async function chooseComboOption(input: HTMLInputElement, value: string): Promise<FillResult> {
  const doc = input.ownerDocument;
  const optionsNow = () => {
    const o = visibleOptions(doc, input);
    return o.length ? o : null;
  };
  input.focus();
  // Search with the full answer, then its first part ("London" for "London, United Kingdom",
  // which suits async location search), then open the unfiltered list.
  const queries = [...new Set([value, value.split(',')[0].trim(), ''])];
  let sawOptions = false;
  for (const q of queries) {
    typeInto(input, q);
    if (!q) openMenu(input);
    // Allow time for async option lists (location search).
    const options = await waitFor(optionsNow, q ? 2500 : 1500);
    if (!options) continue;
    sawOptions = true;
    const texts = options.map(textOf);
    const pick = resolveOption(value, texts);
    if (!pick) continue;
    if (!safeClick(options[texts.indexOf(pick.option)])) return { status: 'refused' };
    return { status: 'ok', detail: pick.option };
  }
  if (!sawOptions) {
    typeInto(input, '');
    return { status: 'failed', detail: 'The dropdown did not open.' };
  }
  typeInto(input, '');
  key(input, 'Escape');
  return { status: 'optionMissing', detail: `No dropdown option matches "${value}".` };
}

async function fillCombobox(el: HTMLElement, value: string, values: string[] | undefined, multiple: boolean): Promise<FillResult> {
  if (!(el instanceof HTMLInputElement)) return { status: 'failed', detail: 'Unsupported dropdown type.' };
  if (multiple && !values?.length) return { status: 'refused', detail: 'Choose each option explicitly.' };
  const list = multiple ? values! : [value];
  const existing = comboboxValues(el);
  let selectedLabel = value;
  if (multiple && existing.some(v => !list.includes(v))) return { status: 'refused', detail: 'Remove unwanted selections on the page first.' };
  for (const v of list) {
    if (multiple && existing.includes(v)) continue;
    const r = await chooseComboOption(el, v);
    if (r.status !== 'ok') return r;
    selectedLabel = r.detail ?? v;
    await new Promise((r2) => setTimeout(r2, 60));
  }
  el.blur();
  if (multiple) return sameSelection(list, comboboxValues(el)) ? { status: 'ok' } : { status: 'failed', detail: 'Only part of the selection was applied.' };
  const shown = normalizeText(comboboxDisplayValue(el));
  const expected = normalizeText(selectedLabel);
  if (shown && shown === expected) {
    return { status: 'ok' };
  }
  // Some widgets display a short form of the clicked option ("+44" for "United Kingdom +44").
  // Accept it only when the shown text is a whole-word part of the option we just clicked.
  if (shown && ` ${expected} `.includes(` ${shown} `)) {
    return { status: 'ok', detail: `Selected "${selectedLabel}"` };
  }
  return { status: 'failed', detail: 'The requested selection did not stick.' };
}

// ---- Entry point ----

export async function fillField(t: FillTarget, value: string, values?: string[]): Promise<FillResult> {
  const { el, controls, field } = t;
  if (!el.isConnected) return { status: 'notFound', detail: 'The field is no longer on the page. Rescan.' };
  if (el.matches(':disabled, [aria-disabled="true"]') || ((el as HTMLInputElement).readOnly && field.kind !== 'combobox')) return { status: 'refused', detail: 'The field is not editable.' };
  if ((field.kind === 'text' || field.kind === 'textarea') && !withinLimit(value, field.limit)) {
    return { status: 'tooLong', detail: `Limit is ${field.limit!.max} ${field.limit!.unit}.` };
  }
  let result: FillResult;
  switch (field.kind) {
    case 'text':
    case 'textarea':
      result = fillText(el as HTMLInputElement, value);
      break;
    case 'select':
      result = fillSelect(el as HTMLSelectElement, value, values);
      break;
    case 'radio':
      result = fillRadio(controls, value);
      break;
    case 'checkbox':
      result = fillCheckbox(el as HTMLInputElement, value);
      break;
    case 'checkboxGroup':
      { const selected = resolveMultiple(value, controls.map(labelText), values);
        result = selected ? fillCheckboxGroup(controls, selected) : { status: 'optionMissing', detail: 'Choose each option explicitly.' }; }
      break;
    case 'combobox':
      result = await fillCombobox(el, value, values, field.multiple);
      break;
    case 'file':
      return { status: 'refused', detail: 'Upload files yourself.' };
  }
  if (result.status === 'ok') highlight(el);
  return result;
}
