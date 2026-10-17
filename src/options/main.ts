// Options page: profile, answer bank, settings, backup.

import { clear, h } from '../shared/dom';
import { normalizeText } from '../shared/normalize';
import { classifySensitive } from '../shared/sensitive';
import {
  SENSITIVE_LABELS,
  newAnswerId,
  type AnswerEntry,
  type Bank,
  type LanguageLevel,
  type LlmProvider,
  type Profile,
  type Secrets,
  type SensitiveCategory,
  type SkillLevel,
} from '../shared/schema';
import { buildExport, loadBank, loadSecrets, parseImport, mutate, diffFields, rebaseDraft, onBankChanged } from '../shared/storage';
import { scopeFor } from '../shared/scope';

let bank: Bank;
let secrets: Secrets;
let baseline: Bank;
let secretBase: Secrets;
const answerDrafts = new Map<string, { base: AnswerEntry; draft: AnswerEntry }>();
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function flash(el: HTMLElement, text: string): void {
  el.textContent = text;
  setTimeout(() => (el.textContent = ''), 2500);
}

async function persist(statusEl: HTMLElement, text = 'Saved', section: 'profile' | 'settings' = 'profile'): Promise<void> {
  const snapshot = structuredClone(bank[section]);
  try {
    const result = await mutate({ kind: section, patches: diffFields(baseline[section], snapshot) });
    if (section === 'profile') {
      bank.profile = rebaseDraft(snapshot as Profile, bank.profile, result.bank.profile);
      baseline.profile = structuredClone(result.bank.profile);
      renderProfile();
    } else {
      bank.settings = rebaseDraft(snapshot as Bank['settings'], bank.settings, result.bank.settings);
      baseline.settings = structuredClone(result.bank.settings);
      renderSettings();
    }
    flash(document.querySelector(`#${section} .status`) as HTMLElement, text);
  } catch (e) { statusEl.textContent = (e as Error).message; }
}

// ---- Profile ----

type FieldDef = { path: string; label: string; type?: string; placeholder?: string; options?: [string, string][] };

const MONTH_OPTS: [string, string][] = [['', '—'], ...['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i): [string, string] => [String(i + 1), m])];

const PROFILE_FIELDS: { group: string; fields: FieldDef[] }[] = [
  {
    group: 'Personal',
    fields: [
      { path: 'firstName', label: 'First name' },
      { path: 'lastName', label: 'Last name' },
      { path: 'preferredName', label: 'Preferred name' },
      { path: 'email', label: 'Email', type: 'email' },
      { path: 'phone', label: 'Phone', type: 'tel', placeholder: 'e.g. +44 7…' },
      { path: 'location.city', label: 'City', placeholder: 'e.g. London' },
      { path: 'location.country', label: 'Country', placeholder: 'e.g. United Kingdom' },
      { path: 'location.postcode', label: 'Postcode' },
    ],
  },
  {
    group: 'Links',
    fields: [
      { path: 'linkedin', label: 'LinkedIn', type: 'url' },
      { path: 'github', label: 'GitHub', type: 'url' },
      { path: 'website', label: 'Website / portfolio', type: 'url' },
    ],
  },
  {
    group: 'Education',
    fields: [
      { path: 'university', label: 'University' },
      { path: 'degree', label: 'Degree', placeholder: 'e.g. BSc Software Engineering' },
      { path: 'graduation.month', label: 'Graduation month', options: MONTH_OPTS },
      { path: 'graduation.year', label: 'Graduation year', type: 'number', placeholder: 'e.g. 2026' },
      { path: 'highSchool', label: 'Sixth form / high school' },
    ],
  },
  {
    group: 'Work eligibility & logistics',
    fields: [
      { path: 'visaStatus', label: 'Visa / immigration status', placeholder: 'e.g. British citizen, Graduate visa' },
      { path: 'needsSponsorship', label: 'Need sponsorship?', options: [['', '—'], ['no', 'No'], ['yes', 'Yes']] },
      { path: 'salaryExpectation', label: 'Salary expectation', placeholder: 'e.g. £30,000–£35,000' },
      { path: 'startDate', label: 'Start date / notice', placeholder: 'e.g. September 2026' },
    ],
  },
];

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

function setPath(obj: unknown, path: string, value: unknown): void {
  const parts = path.split('.');
  const last = parts.pop()!;
  const target = parts.reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, obj as Record<string, unknown>);
  target[last] = value;
}

function renderProfile(): void {
  const root = $('profile');
  clear(root);
  const status = h('span', { class: 'status' });
  const p = bank.profile;

  for (const g of PROFILE_FIELDS) {
    root.append(h('h3', null, g.group));
    const grid = h('div', { class: 'grid' });
    for (const f of g.fields) {
      const value = getPath(p, f.path);
      const onchange = (e: Event) => {
        const raw = (e.target as HTMLInputElement).value;
        const v = f.path.startsWith('graduation.') ? (raw ? Number(raw) : null) : raw;
        setPath(bank.profile, f.path, v);
      };
      const control = f.options
        ? h('select', { onchange }, f.options.map(([v, l]) => h('option', { value: v, selected: String(value ?? '') === v }, l)))
        : h('input', { type: f.type ?? 'text', value: value === null || value === undefined ? '' : String(value), placeholder: f.placeholder ?? '', oninput: onchange });
      grid.append(h('label', null, h('span', null, f.label), control));
    }
    root.append(grid);
  }

  root.append(h('h3', null, 'Languages'), listEditor(p.languages, ['native', 'fluent', 'professional', 'basic'], 'English'));
  root.append(h('h3', null, 'Skills'), listEditor(p.skills, ['beginner', 'intermediate', 'advanced', 'expert'], 'TypeScript'));
  root.append(h('div', { class: 'actions sticky' }, h('button', { class: 'primary', onclick: () => persist(status, 'Profile saved') }, 'Save profile'), status));
}

function listEditor<L extends LanguageLevel | SkillLevel>(items: { name: string; level: L }[], levels: L[], placeholder: string): HTMLElement {
  const wrap = h('div', { class: 'list' });
  const draw = () => {
    clear(wrap);
    items.forEach((item, i) => {
      wrap.append(
        h(
          'div',
          { class: 'row' },
          h('input', { value: item.name, placeholder, oninput: (e: Event) => (item.name = (e.target as HTMLInputElement).value) }),
          h('select', { onchange: (e: Event) => (item.level = (e.target as HTMLSelectElement).value as L) }, levels.map((l) => h('option', { value: l, selected: l === item.level }, l))),
          h('button', { class: 'icon', title: 'Remove', onclick: () => { items.splice(i, 1); draw(); } }, '×'),
        ),
      );
    });
    wrap.append(h('button', { onclick: () => { items.push({ name: '', level: levels[1] }); draw(); } }, '+ Add'));
  };
  draw();
  return wrap;
}

// ---- Answers ----

let filter = '';

function renderAnswers(): void {
  const root = $('answers-list');
  clear(root);
  const f = normalizeText(filter);
  const deletedDrafts = [...answerDrafts.values()].filter(d => !equal(d.base, d.draft) && !bank.answers.some(a => a.id === d.base.id)).map(d => d.base);
  const list = [...bank.answers, ...deletedDrafts]
    .filter((a) => !f || normalizeText([...a.questions, a.answer, ...a.tags].join(' ')).includes(f))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  $('answers-count').textContent = `${bank.answers.length} saved`;
  if (list.length === 0) {
    root.append(h('p', { class: 'muted' }, bank.answers.length ? 'No answers match that search.' : 'No saved answers yet. Add one here, or use “Edit & save” in the side panel while applying.'));
    return;
  }
  for (const a of list) root.append(answerCard(a));
}

function answerCard(a: AnswerEntry): HTMLElement {
  const status = h('span', { class: 'status' });
  let saved = answerDrafts.get(a.id);
  if (!saved || equal(saved.base, saved.draft)) { saved = { base: structuredClone(a), draft: structuredClone(a) }; answerDrafts.set(a.id, saved); }
  const { draft, base } = saved;
  const companyInput = h('input', { value: draft.scope?.type === 'company' ? draft.scope.company : '', disabled: draft.scope?.type !== 'company', oninput: (e: Event) => { draft.scope = { type: 'company', company: (e.target as HTMLInputElement).value.trim() }; } });
  const sensitiveOpts: [string, string][] = [['', 'Not sensitive'], ...Object.entries(SENSITIVE_LABELS)];
  return h(
    'article',
    { class: `card${a.sensitive ? ' sensitive' : ''}` },
    h(
      'label',
      null,
      h('span', null, 'Question wordings (one per line)'),
      h('textarea', { rows: Math.min(6, a.questions.length + 1), value: draft.questions.join('\n'), oninput: (e: Event) => (draft.questions = (e.target as HTMLTextAreaElement).value.split('\n').map((s) => s.trim()).filter(Boolean)) }),
    ),
    h(
      'label',
      null,
      h('span', null, 'Answer'),
      h('textarea', { rows: 4, value: draft.answer, oninput: (e: Event) => (draft.answer = (e.target as HTMLTextAreaElement).value) }),
    ),
    h('label', null, h('span', null, 'Multiple selections (one complete option per line; leave blank for a single answer)'),
      h('textarea', { rows: 2, value: (draft.values ?? []).join('\n'), oninput: (e: Event) => {
        const values = (e.target as HTMLTextAreaElement).value.split('\n').map(v => v.trim()).filter(Boolean);
        draft.values = values.length ? values : undefined;
      } })),
    h('label', null, h('span', null, 'Answer scope'), h('select', {
      onchange: (e: Event) => {
        const type = (e.target as HTMLSelectElement).value;
        draft.scope = type === 'company' ? { type, company: companyInput.value.trim() } : { type: type as 'global' | 'unassigned' };
        companyInput.disabled = type !== 'company';
      },
    }, ['global', 'company', 'unassigned'].map(v => h('option', { value: v, selected: (draft.scope?.type ?? 'global') === v }, v)))),
    h('label', null, h('span', null, 'Company (required for company answers)'), companyInput),
    h(
      'div',
      { class: 'grid' },
      h(
        'label',
        null,
        h('span', null, 'Type'),
        h('select', { onchange: (e: Event) => (draft.kind = (e.target as HTMLSelectElement).value as AnswerEntry['kind']) }, (['text', 'choice', 'boolean'] as const).map((k) => h('option', { value: k, selected: k === draft.kind }, k))),
      ),
      h(
        'label',
        null,
        h('span', null, 'Sensitive'),
        h('select', { onchange: (e: Event) => (draft.sensitive = ((e.target as HTMLSelectElement).value || undefined) as SensitiveCategory | undefined) }, sensitiveOpts.map(([v, l]) => h('option', { value: v, selected: (draft.sensitive ?? '') === v }, l))),
      ),
      h(
        'label',
        null,
        h('span', null, 'Tags (comma separated)'),
        h('input', { value: draft.tags.join(', '), oninput: (e: Event) => (draft.tags = (e.target as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean)) }),
      ),
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', {
        class: 'primary',
        onclick: async () => {
          if (!draft.questions.length) return flash(status, 'Add at least one wording');
          const snapshot = structuredClone(draft);
          const typed = structuredClone(draft);
          if (snapshot.values) snapshot.answer = snapshot.values.join(', ');
          try {
            const result = await mutate({ kind: 'editAnswer', id: a.id, patches: diffFields(base, snapshot).filter(p => !['updatedAt', 'timesUsed', 'lastUsedAt'].includes(p.path[0])) });
            bank.answers = result.bank.answers;
            if (equal(draft, typed)) answerDrafts.delete(a.id);
            else saved!.base = structuredClone(result.bank.answers.find(x => x.id === a.id)!);
            renderAnswers();
          } catch (e) { status.textContent = (e as Error).message; }
        },
      }, 'Save'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm('Delete this answer?')) return;
          try {
            const result = await mutate({ kind: 'deleteAnswer', id: a.id, before: base });
            bank.answers = result.bank.answers; answerDrafts.delete(a.id); renderAnswers();
          } catch (e) { status.textContent = (e as Error).message; }
        },
      }, 'Delete'),
      h('span', { class: 'muted' }, `Used ${a.timesUsed}×`),
      status,
    ),
  );
}

async function addAnswer(): Promise<void> {
  const q = prompt('Question (as written on the form):');
  if (!q?.trim()) return;
  const now = Date.now();
  const entry: AnswerEntry = {
    id: newAnswerId(),
    questions: [q.trim()],
    scope: scopeFor(q),
    answer: '',
    kind: 'text',
    tags: [],
    sensitive: classifySensitive(q) ?? undefined,
    createdAt: now,
    updatedAt: now,
    timesUsed: 0,
    lastUsedAt: null,
  };
  try { bank.answers = (await mutate({ kind: 'addAnswer', entry })).bank.answers; }
  catch (e) { $('answers-count').textContent = (e as Error).message; return; }
  filter = '';
  ($('answers-search') as HTMLInputElement).value = '';
  renderAnswers();
}

// ---- Settings ----

function renderSettings(): void {
  const root = $('settings');
  clear(root);
  const s = bank.settings;
  const status = h('span', { class: 'status' });
  const keyInput = h('input', {
    type: 'password',
    autocomplete: 'off',
    value: secrets.apiKeys[s.llm.provider] ?? '',
    placeholder: 'Stored only in this browser',
    oninput: (e: Event) => (secrets.apiKeys[s.llm.provider] = (e.target as HTMLInputElement).value.trim()),
  });
  root.append(
    h('h3', null, 'Matching'),
    h(
      'div',
      { class: 'grid' },
      h('label', null, h('span', null, 'High-confidence threshold (%)'), h('input', { type: 'number', min: 50, max: 100, value: String(Math.round(s.matching.highConfidence * 100)), oninput: (e: Event) => (s.matching.highConfidence = Number((e.target as HTMLInputElement).value) / 100) })),
      h('label', null, h('span', null, 'Hide matches below (%)'), h('input', { type: 'number', min: 0, max: 100, value: String(Math.round(s.matching.minShow * 100)), oninput: (e: Event) => (s.matching.minShow = Number((e.target as HTMLInputElement).value) / 100) })),
    ),
    h('h3', null, 'AI drafting'),
    h('p', { class: 'muted' }, 'Drafting answers with Claude, OpenAI or Gemini is coming in the next milestone. Your key is stored only in this browser and is never included in exports unless you tick the box.'),
    h(
      'div',
      { class: 'grid' },
      h(
        'label',
        null,
        h('span', null, 'Provider'),
        h('select', {
          onchange: (e: Event) => {
            s.llm.provider = (e.target as HTMLSelectElement).value as LlmProvider;
            renderSettings();
          },
        }, ([['anthropic', 'Claude (Anthropic)'], ['openai', 'OpenAI'], ['gemini', 'Gemini']] as const).map(([v, l]) => h('option', { value: v, selected: v === s.llm.provider }, l))),
      ),
      h('label', null, h('span', null, 'Model'), h('input', { value: s.llm.model, placeholder: 'Default for provider', oninput: (e: Event) => (s.llm.model = (e.target as HTMLInputElement).value.trim()) })),
      h('label', null, h('span', null, 'API key'), keyInput),
    ),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: false, disabled: true }), ' Enable AI drafting (available in the next version)'),
    h(
      'div',
      { class: 'actions' },
      h('button', {
        class: 'primary',
        onclick: async () => {
          const snapshot = structuredClone(secrets);
          const settingsSnapshot = structuredClone(bank.settings);
          try {
            const result = await mutate({ kind: 'settings', patches: diffFields(baseline.settings, settingsSnapshot), secretPatches: diffFields(secretBase, snapshot) });
            secrets = rebaseDraft(snapshot, secrets, result.secrets!);
            secretBase = structuredClone(result.secrets!);
            bank.settings = rebaseDraft(settingsSnapshot, bank.settings, result.bank.settings);
            baseline.settings = structuredClone(result.bank.settings);
            renderSettings();
            flash(document.querySelector('#settings .status') as HTMLElement, 'Settings saved');
          } catch (e) { status.textContent = (e as Error).message; }
        },
      }, 'Save settings'),
      status,
    ),
  );
}

// ---- Backup ----

function setupBackup(): void {
  const status = $('backup-status');
  $('export').addEventListener('click', async () => {
    try {
    const latestBank = await loadBank();
    const latestSecrets = await loadSecrets();
    const include = ($('export-keys') as HTMLInputElement).checked;
    const blob = new Blob([buildExport(latestBank, include ? latestSecrets : null)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `application-autofill-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { status.textContent = (e as Error).message; }
  });
  $('import').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const importText = await file.text();
      const { bank: incoming } = parseImport(importText);
      const before = await loadBank();
      const mode = (document.querySelector('input[name="import-mode"]:checked') as HTMLInputElement).value;
      if (mode === 'replace' && !confirm('Replace your whole profile and answer bank with this file?')) return;
      const result = await mutate({ kind: 'import', text: importText, mode: mode as 'merge' | 'replace', before });
      bank = result.bank; secrets = result.secrets!;
      baseline = structuredClone(bank); secretBase = structuredClone(secrets); answerDrafts.clear();
      renderAll();
      flash(status, `Imported ${incoming.answers.length} answers (${mode}).`);
    } catch (err) {
      flash(status, (err as Error).message);
    }
  });
}

// ---- Boot ----

function renderAll(): void {
  renderProfile();
  renderAnswers();
  renderSettings();
}

(async () => {
  [bank, secrets] = await Promise.all([loadBank(), loadSecrets()]);
  baseline = structuredClone(bank); secretBase = structuredClone(secrets);
  onBankChanged(incoming => {
    if (equal(bank.profile, baseline.profile)) { bank.profile = structuredClone(incoming.profile); baseline.profile = structuredClone(incoming.profile); renderProfile(); }
    if (equal(bank.settings, baseline.settings) && equal(secrets, secretBase)) { bank.settings = structuredClone(incoming.settings); baseline.settings = structuredClone(incoming.settings); renderSettings(); }
    bank.answers = incoming.answers;
    renderAnswers();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.secrets && equal(secrets, secretBase)) {
      loadSecrets().then(s => { secrets = s; secretBase = structuredClone(s); renderSettings(); }).catch(e => { $('backup-status').textContent = e.message; });
    }
  });
  $('answers-search').addEventListener('input', (e) => {
    filter = (e.target as HTMLInputElement).value;
    renderAnswers();
  });
  $('add-answer').addEventListener('click', addAnswer);
  setupBackup();
  renderAll();
})().catch(e => { $('backup-status').textContent = e.message; });
