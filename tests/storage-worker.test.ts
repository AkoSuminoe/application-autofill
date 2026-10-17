import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createStore } from '../src/background/store';
import { diffFields, rebaseDraft, type Mutation } from '../src/shared/storage';
import { emptyBank } from '../src/shared/schema';
import { entry } from './helpers';

function setup(initial: Record<string, unknown> = { bank: emptyBank() }) {
  const data = structuredClone(initial);
  const listeners: ((changes: Record<string, { newValue: unknown }>, area: string) => void)[] = [];
  const storage = {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])]))),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(data, structuredClone(values));
      const changes = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: structuredClone(v) }]));
      listeners.forEach(fn => fn(changes, 'local'));
    }),
  };
  const run = createStore(storage as unknown as Pick<typeof chrome.storage.local, 'get' | 'set'>);
  return { data, storage, run, listeners };
}

describe('single writer', () => {
  it('preserves typing during save without undoing an unrelated committed change', () => {
    expect(rebaseDraft({ firstName: 'Ada', city: 'London' }, { firstName: 'Ada typed more', city: 'London' }, { firstName: 'Ada', city: 'Manchester' }))
      .toEqual({ firstName: 'Ada typed more', city: 'Manchester' });
  });
  it('preserves a newly added answer when an older profile draft is saved', async () => {
    const { run } = setup();
    const before = (await run({ kind: 'readBank' })).bank;
    const profile = { ...before.profile, firstName: 'Ada' };
    await Promise.all([
      run({ kind: 'addAnswer', entry: entry(['Project'], 'Compiler') }),
      run({ kind: 'profile', patches: diffFields(before.profile, profile) }),
    ]);
    const { bank } = await run({ kind: 'readBank' });
    expect(bank.profile.firstName).toBe('Ada');
    expect(bank.answers).toHaveLength(1);
  });
  it('merges unrelated edits but rejects a stale edit or delete and keeps the queue usable', async () => {
    const { run } = setup();
    const added = (await run({ kind: 'addAnswer', entry: entry(['Project'], 'Old') })).bank.answers[0];
    await run({ kind: 'editAnswer', id: added.id, patches: diffFields(added, { ...added, answer: 'New' }) });
    await expect(run({ kind: 'editAnswer', id: added.id, patches: diffFields(added, { ...added, answer: 'Stale' }) })).rejects.toThrow('Conflict');
    await expect(run({ kind: 'deleteAnswer', id: added.id, before: added })).rejects.toThrow('Conflict');
    await run({ kind: 'editAnswer', id: added.id, patches: diffFields(added, { ...added, tags: ['tag'] }) });
    expect((await run({ kind: 'readBank' })).bank.answers[0]).toMatchObject({ answer: 'New', tags: ['tag'] });
  });
  it('does not resurrect deleted answers', async () => {
    const { run } = setup();
    const answer = (await run({ kind: 'addAnswer', entry: entry(['Project'], 'Old') })).bank.answers[0];
    await run({ kind: 'deleteAnswer', id: answer.id, before: answer });
    await expect(run({ kind: 'editAnswer', id: answer.id, patches: diffFields(answer, { ...answer, answer: 'New' }) })).rejects.toThrow('deleted');
    expect((await run({ kind: 'readBank' })).bank.answers).toEqual([]);
  });
  it('backs up v1 before migration, and stops if backup fails', async () => {
    const original = { ...emptyBank(), schemaVersion: 1, answers: [entry(['Why us?'], 'Old answer')] };
    const first = setup({ bank: original });
    first.storage.set.mockRejectedValueOnce(new Error('Quota exceeded'));
    await expect(first.run({ kind: 'readBank' })).rejects.toThrow('Quota');
    expect(first.data.bank).toEqual(original);
    await first.run({ kind: 'readBank' });
    expect(first.data.bankBackupV1).toEqual(original);
    expect((first.data.bank as { schemaVersion: number }).schemaVersion).toBe(2);
    expect(first.storage.set.mock.calls[1][0]).toEqual({ bankBackupV1: original });
  });
  it('does not write invalid imports or replace a concurrently modified bank', async () => {
    const { run, storage } = setup();
    const before = (await run({ kind: 'readBank' })).bank;
    await expect(run({ kind: 'import', mode: 'merge', text: '{"profile":{"location":null}}' })).rejects.toThrow('profile.location');
    expect(storage.set).not.toHaveBeenCalled();
    await run({ kind: 'addAnswer', entry: entry(['Project'], 'New') });
    await expect(run({ kind: 'import', mode: 'replace', before, text: JSON.stringify(emptyBank()) })).rejects.toThrow('changed while importing');
    expect((await run({ kind: 'readBank' })).bank.answers).toHaveLength(1);
  });
  it('does not learn another company or an answer edited during filling', async () => {
    const { run } = setup();
    const a = entry(['Why us?'], 'Acme answer', { scope: { type: 'company', company: 'Acme' } });
    await run({ kind: 'addAnswer', entry: a });
    await run({ kind: 'learn', id: a.id, answer: a.answer, company: 'Beta', question: 'Why join Beta?' });
    await run({ kind: 'learn', id: a.id, answer: 'Old answer', company: 'Acme', question: 'Why join Acme?' });
    expect((await run({ kind: 'readBank' })).bank.answers[0].timesUsed).toBe(0);
    await run({ kind: 'learn', id: a.id, answer: a.answer, company: 'Acme', question: 'Why join Acme?' });
    expect((await run({ kind: 'readBank' })).bank.answers[0].questions).toContain('Why join Acme?');
  });
  it('validates settings and keys before either is written', async () => {
    const { run, data, storage } = setup();
    await expect(run({ kind: 'settings', patches: [{ path: ['matching', 'highConfidence'], before: .85, value: -1 }], secretPatches: [{ path: ['apiKeys', 'openai'], value: 'test-only' }] })).rejects.toThrow('highConfidence');
    expect(storage.set).not.toHaveBeenCalled();
    expect(data.secrets).toBeUndefined();
  });
});

describe('actual options UI with service worker storage', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); document.body.innerHTML = ''; });
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!;
  async function openOptions() {
    vi.resetModules();
    const env = setup();
    document.body.innerHTML = readFileSync('static/options.html', 'utf8');
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: async ({ operation }: { operation: Mutation }) => {
        try { return { ok: true, data: await env.run(operation) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
      } },
      storage: { onChanged: { addListener: (fn: typeof env.listeners[number]) => env.listeners.push(fn) } },
    });
    await import('../src/options/main');
    await vi.waitFor(() => expect(button('Save profile')).toBeTruthy());
    return env;
  }
  it('keeps panel answers when Save profile is clicked', async () => {
    const env = await openOptions();
    const input = document.querySelector<HTMLInputElement>('#profile input')!;
    input.value = 'Ada'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await env.run({ kind: 'addAnswer', entry: entry(['Panel answer'], 'Preserve me') });
    button('Save profile').click();
    await vi.waitFor(() => expect((env.data.bank as ReturnType<typeof emptyBank>).profile.firstName).toBe('Ada'));
    expect((env.data.bank as ReturnType<typeof emptyBank>).answers).toHaveLength(1);
  });
  it('keeps a draft and displays a conflict instead of overwriting another window', async () => {
    const env = await openOptions();
    const input = document.querySelector<HTMLInputElement>('#profile input')!;
    input.value = 'My draft'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await env.run({ kind: 'profile', patches: [{ path: ['firstName'], before: '', value: 'Other window' }] });
    button('Save profile').click();
    await vi.waitFor(() => expect(document.querySelector('#profile')!.textContent).toContain('Conflict'));
    expect(document.querySelector<HTMLInputElement>('#profile input')!.value).toBe('My draft');
    expect((env.data.bank as ReturnType<typeof emptyBank>).profile.firstName).toBe('Other window');
  });
});
