import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { emptyBank, type Bank } from '../src/shared/schema';
import { entry, field } from './helpers';

describe('actual panel bulk safety', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); document.body.innerHTML = ''; });
  async function openPanel(bank: Bank, fields = [field('University and degree')]) {
    vi.resetModules();
    document.body.innerHTML = readFileSync('static/sidepanel.html', 'utf8');
    const listeners: ((msg: unknown, sender: unknown) => void)[] = [];
    const activated: ((info: { windowId: number; tabId: number }) => void)[] = [];
    const updated: ((id: number, change: { status: string }) => void)[] = [];
    let active = 1;
    const message = { type: 'fieldsUpdated', page: { url: 'https://example.org/form', ats: 'Test', company: 'Acme', jobTitle: 'Role' }, fields };
    const sendMessage = vi.fn(async (_id: number, msg: { type: string }) => {
      if (msg.type === 'scan') listeners.forEach(fn => fn(message, { tab: { id: 1 }, frameId: 0, documentId: 'doc' }));
      return { status: 'ok' };
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => ({ ok: true, data: { bank } })), onMessage: { addListener: (fn: typeof listeners[number]) => listeners.push(fn) } },
      storage: { onChanged: { addListener: vi.fn() } },
      windows: { getCurrent: async () => ({ id: 4 }) },
      tabs: {
        query: async () => [{ id: active, url: 'https://example.org/form' }], sendMessage,
        onActivated: { addListener: (fn: typeof activated[number]) => activated.push(fn) },
        onUpdated: { addListener: (fn: typeof updated[number]) => updated.push(fn) },
      },
    });
    await import('../src/sidepanel/main');
    await vi.waitFor(() => expect(document.querySelector('.card')).toBeTruthy());
    return { sendMessage, switchTab: () => { active = 2; activated.forEach(fn => fn({ windowId: 4, tabId: 2 })); }, navigate: () => updated.forEach(fn => fn(1, { status: 'loading' })), listeners, message };
  }
  const bulk = () => [...document.querySelectorAll('button')].find(b => b.textContent?.startsWith('Fill all high-confidence'))!;
  it('blocks ambiguous fields even if the threshold is lowered to zero', async () => {
    const bank = emptyBank();
    bank.profile.university = 'Example University'; bank.profile.degree = 'BSc'; bank.settings.matching.highConfidence = 0; bank.settings.matching.minShow = 0;
    await openPanel(bank);
    expect(bulk().disabled).toBe(true);
    expect(document.body.textContent).toContain('Ambiguous match');
  });
  it('blocks exact company mismatches even at threshold zero', async () => {
    const bank = emptyBank(); bank.settings.matching.highConfidence = 0;
    bank.answers = [entry(['Why us?'], 'Beta', { scope: { type: 'company', company: 'Beta' } })];
    await openPanel(bank, [field('Why us?')]);
    expect(bulk().disabled).toBe(true);
  });
  it('blocks an ambiguous checkbox answer and explains how to fix it', async () => {
    const bank = emptyBank(); bank.settings.matching.highConfidence = 0;
    bank.answers = [entry(['Available to relocate?'], 'Maybe')];
    await openPanel(bank, [field('Available to relocate?', { kind: 'checkbox' })]);
    expect(bulk().disabled).toBe(true);
    expect(document.body.textContent).toContain('Use an explicit Yes or No');
    expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Fill')!.disabled).toBe(true);
  });
  it.each(['switchTab', 'navigate'] as const)('stops remaining fills on %s', async action => {
    const bank = emptyBank(); bank.profile.firstName = 'Ada'; bank.profile.lastName = 'Lovelace';
    const env = await openPanel(bank, [field('First name', { id: 'f1' }), field('Last name', { id: 'f2' })]);
    let release: () => void = () => {};
    const pending = new Promise<void>(r => { release = r; });
    env.sendMessage.mockImplementation(async (_id, msg) => { if (msg.type === 'fill') await pending; return { status: 'ok' }; });
    bulk().click();
    await vi.waitFor(() => expect(env.sendMessage.mock.calls.filter(c => c[1].type === 'fill')).toHaveLength(1));
    env[action](); release();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Filling stopped'));
    expect(env.sendMessage.mock.calls.filter(c => c[1].type === 'fill')).toHaveLength(1);
  });
});
