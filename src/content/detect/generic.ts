// Generic form-field detection: finds controls, groups radios/checkboxes and works out each question's text.

import { combineLimits, parseLimitText } from '../../shared/limits';
import type { DetectedField, FieldKind } from '../../shared/schema';

export const ID_ATTR = 'data-aa-id';

export interface DetectOptions {
  /** Injected so tests can run in jsdom, which has no layout. */
  isVisible: (el: Element) => boolean;
}

/** A detected field plus the live elements behind it. */
export interface RawField {
  field: DetectedField;
  /** Primary control: the input/select/textarea, or the first radio/checkbox of a group. */
  el: HTMLElement;
  /** All controls in a radio/checkbox group (just [el] otherwise). */
  controls: HTMLElement[];
}

const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search']);
const CONTROL_SELECTOR = 'input, textarea, select, [role="combobox"]';

export function isVisibleInPage(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.hidden) return false;
  const style = getComputedStyle(h);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return h.getClientRects().length > 0;
}

// ---- Text helpers ----

/** Text of a node without nested form controls or select option lists. */
export function textOf(node: Element | null | undefined): string {
  if (!node) return '';
  const clone = node.cloneNode(true) as Element;
  clone.querySelectorAll('input, textarea, select, button, script, style, template, svg').forEach((n) => n.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function cleanQuestion(raw: string): { text: string; requiredMark: boolean } {
  const requiredMark = /\*|\(required\)/i.test(raw);
  const text = raw
    .replace(/\*/g, ' ')
    .replace(/\((required|optional)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*$/, '')
    .trim();
  return { text, requiredMark };
}

function byIds(doc: Document, ids: string | null): Element[] {
  if (!ids) return [];
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id))
    .filter((e): e is HTMLElement => !!e);
}

function humanize(s: string): string {
  return s
    .replace(/\[\]$/, '')
    .replace(/.*\[([^\]]+)\]$/, '$1')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

// ---- Collection ----

function skipControl(el: HTMLElement, opts: DetectOptions): boolean {
  if (el.closest('[aria-hidden="true"]')) return true;
  if ((el as HTMLInputElement).disabled) return true;
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (SKIP_INPUT_TYPES.has(type)) return true;
    // Hidden mirror inputs used by custom dropdowns for native validation.
    if (el.tabIndex === -1 && el.getAttribute('aria-hidden') === 'true') return true;
    if (type === 'file') return false; // File inputs are usually visually hidden behind a button.
  }
  if ((el as HTMLInputElement).readOnly && el.getAttribute('role') !== 'combobox') return true;
  return !opts.isVisible(el);
}

function kindOf(el: HTMLElement): FieldKind {
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLSelectElement) return 'select';
  if (el.getAttribute('role') === 'combobox') return 'combobox';
  if (el instanceof HTMLInputElement) {
    switch (el.type.toLowerCase()) {
      case 'radio':
        return 'radio';
      case 'checkbox':
        return 'checkbox';
      case 'file':
        return 'file';
    }
  }
  return 'text';
}

function groupContainer(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('fieldset, [role="radiogroup"], [role="group"]');
}

// ---- Question text ----

function labelFromLabelling(el: HTMLElement): string {
  const doc = el.ownerDocument;
  const labelled = byIds(doc, el.getAttribute('aria-labelledby')).map(textOf).join(' ').trim();
  if (labelled) return labelled;
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) {
    const t = Array.from(labels).map(textOf).join(' ').trim();
    if (t) return t;
  }
  const wrapping = el.closest('label');
  if (wrapping) {
    const t = textOf(wrapping);
    if (t) return t;
  }
  return el.getAttribute('aria-label')?.trim() ?? '';
}

function groupLabel(group: HTMLElement): string {
  const legend = group.querySelector(':scope > legend');
  if (legend && textOf(legend)) return textOf(legend);
  const labelled = byIds(group.ownerDocument, group.getAttribute('aria-labelledby')).map(textOf).join(' ').trim();
  if (labelled) return labelled;
  return group.getAttribute('aria-label')?.trim() ?? '';
}

/** Walk up to the largest ancestor that still contains only this field, and use its text. */
function nearbyText(anchor: HTMLElement, own: HTMLElement[]): string {
  let node: HTMLElement | null = anchor.parentElement;
  let best = '';
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const controls = Array.from(node.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(
      (c) => !(c instanceof HTMLInputElement && c.type === 'hidden'),
    );
    if (controls.some((c) => !own.includes(c))) break;
    const clone = node.cloneNode(true) as HTMLElement;
    // Drop option labels so a radio group's question isn't polluted by "Yes No".
    clone.querySelectorAll('label, option').forEach((l) => {
      if (l.querySelector('input[type="radio"], input[type="checkbox"]') || l.tagName === 'OPTION') l.remove();
    });
    const t = textOf(clone);
    if (t && t.length <= 400) best = t;
  }
  return best;
}

function optionLabel(control: HTMLElement): string {
  return labelFromLabelling(control) || (control as HTMLInputElement).value || '';
}

export function questionFor(el: HTMLElement, controls: HTMLElement[], isGroup: boolean): { text: string; requiredMark: boolean } {
  const candidates: string[] = [];
  if (isGroup) {
    const g = groupContainer(el);
    if (g) candidates.push(groupLabel(g));
  } else {
    candidates.push(labelFromLabelling(el));
  }
  candidates.push(nearbyText(isGroup ? (groupContainer(el) ?? el) : el, controls));
  candidates.push(el.getAttribute('placeholder') ?? '');
  candidates.push(humanize(el.getAttribute('name') ?? el.id ?? ''));
  for (const c of candidates) {
    const cleaned = cleanQuestion(c);
    if (cleaned.text) return cleaned;
  }
  return { text: '', requiredMark: false };
}

// ---- Values, options, descriptions ----

function selectOptions(sel: HTMLSelectElement): string[] {
  return Array.from(sel.options)
    .filter((o) => o.value !== '' && !/^(select|choose|please select|--|—)/i.test(o.text.trim()))
    .map((o) => o.text.trim());
}

/** Value currently shown by a react-select style combobox, if any. */
export function comboboxValues(el: HTMLElement): string[] {
  const control = el.closest('[class*="control"]') ?? el.parentElement?.parentElement;
  if (!control) return [];
  const vals = control.querySelectorAll('[class*="single-value"], [class*="singleValue"], [class*="multi-value__label"], [class*="multiValue"] > div:first-child');
  return Array.from(vals)
    .map((v) => textOf(v))
    .filter(Boolean);
}

export function comboboxDisplayValue(el: HTMLElement): string { return comboboxValues(el).join(', '); }

function currentValue(kind: FieldKind, el: HTMLElement, controls: HTMLElement[]): string {
  switch (kind) {
    case 'text':
    case 'textarea':
      return (el as HTMLInputElement).value ?? '';
    case 'select': {
      const sel = el as HTMLSelectElement;
      return sel.value ? (sel.selectedOptions[0]?.text.trim() ?? '') : '';
    }
    case 'radio':
    case 'checkboxGroup':
      return controls
        .filter((c) => (c as HTMLInputElement).checked)
        .map(optionLabel)
        .join(', ');
    case 'checkbox':
      return (el as HTMLInputElement).checked ? 'Yes' : '';
    case 'combobox':
      return comboboxDisplayValue(el);
    case 'file':
      return (el as HTMLInputElement).files?.length ? 'Uploaded' : '';
  }
}

function descriptionFor(el: HTMLElement): string {
  return byIds(el.ownerDocument, el.getAttribute('aria-describedby'))
    .filter((d) => !/error|placeholder/i.test(d.id))
    .map(textOf)
    .filter((t) => t && !/^select\.{0,3}$/i.test(t))
    .join(' ')
    .trim();
}

// ---- Main ----

let counter = 0;

function stamp(controls: HTMLElement[]): string {
  const existing = controls[0].getAttribute(ID_ATTR);
  const id = existing ?? `aa${Date.now().toString(36)}${(counter++).toString(36)}`;
  for (const c of controls) c.setAttribute(ID_ATTR, id);
  return id;
}

export function detectFields(root: ParentNode, opts: DetectOptions): RawField[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter((el) => !skipControl(el, opts));
  const seen = new Set<HTMLElement>();
  const out: RawField[] = [];

  for (const el of all) {
    if (seen.has(el)) continue;
    let kind = kindOf(el);
    let controls = [el];

    if (kind === 'radio') {
      const name = (el as HTMLInputElement).name;
      const scope = groupContainer(el) ?? (el as HTMLInputElement).form ?? root;
      controls = all.filter(
        (c) => c instanceof HTMLInputElement && c.type === 'radio' && (name ? c.name === name : groupContainer(c) === groupContainer(el)) && scope.contains(c),
      );
    } else if (kind === 'checkbox') {
      const g = groupContainer(el);
      const siblings = g ? all.filter((c) => c instanceof HTMLInputElement && c.type === 'checkbox' && groupContainer(c) === g) : [el];
      if (siblings.length > 1) {
        kind = 'checkboxGroup';
        controls = siblings;
      }
    }
    controls.forEach((c) => seen.add(c));

    const isGroup = kind === 'radio' || kind === 'checkboxGroup';
    const q = questionFor(el, controls, isGroup);
    const description = isGroup ? '' : descriptionFor(el);
    const container = el.closest('.field, .field-wrapper, .form-group, .application-question') ?? el.parentElement;

    const options =
      kind === 'select'
        ? selectOptions(el as HTMLSelectElement)
        : isGroup
          ? controls.map(optionLabel).map((t) => cleanQuestion(t).text)
          : kind === 'checkbox'
            ? []
            : [];

    const maxLength = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.maxLength : -1;
    const limitText = [description, textOf(container)].join(' ');
    const limit = kind === 'text' || kind === 'textarea' ? combineLimits(maxLength > 0 ? maxLength : null, parseLimitText(limitText)) : null;

    const required =
      q.requiredMark ||
      controls.some((c) => (c as HTMLInputElement).required || c.getAttribute('aria-required') === 'true') ||
      (isGroup && groupContainer(el)?.getAttribute('aria-required') === 'true');

    out.push({
      el,
      controls,
      field: {
        id: stamp(controls),
        question: q.text,
        description: description || undefined,
        kind,
        required: !!required,
        options,
        multiple: kind === 'checkboxGroup' || (el instanceof HTMLSelectElement && el.multiple),
        limit,
        currentValue: currentValue(kind, el, controls),
        sensitive: null,
        autocomplete: el.getAttribute('autocomplete') || undefined,
        inputType: el instanceof HTMLInputElement ? el.type : undefined,
      },
    });
  }
  return out;
}
