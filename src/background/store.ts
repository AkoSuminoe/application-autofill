import { mergeBanks, parseImport, type Mutation, type MutationResult, type Patch } from '../shared/storage';
import { SCHEMA_VERSION } from '../shared/schema';
import { isObj, normalizeSecrets, validateBank } from '../shared/validation';
import { scopeAllows, effectiveScope } from '../shared/scope';
import { effectiveSensitive } from '../shared/sensitive';
import { normalizeText } from '../shared/normalize';

type Storage = Pick<typeof chrome.storage.local, 'get' | 'set'>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function applyPatches(target: object, patches: Patch[], allowed: string[]): void {
  if (!Array.isArray(patches)) throw new Error('Invalid changes');
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || !patch.path.length || !allowed.includes(patch.path[0]) ||
        patch.path.some(k => typeof k !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('Invalid change path');
    let node = target as Record<string, unknown>;
    for (const key of patch.path.slice(0, -1)) {
      if (!Object.hasOwn(node, key) || !isObj(node[key])) throw new Error('Invalid change path');
      node = node[key] as Record<string, unknown>;
    }
    const key = patch.path.at(-1)!;
    if (!same(node[key], patch.before)) throw new Error(`Conflict: ${patch.path.join('.')} changed in another window. Your draft has been kept; reload to compare.`);
    if (patch.remove) delete node[key]; else node[key] = patch.value;
  }
}

/** The only writer. Each operation reads current data after the previous write completes. */
export function createStore(storage: Storage) {
  let queue: Promise<unknown> = Promise.resolve();
  async function run(op: Mutation): Promise<MutationResult> {
    const got = await storage.get(['bank', 'secrets', 'bankBackupV1']);
    const raw = got.bank;
    if (isObj(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion > SCHEMA_VERSION) throw new Error('Update the extension to read this newer bank.');
    let bank = validateBank(raw);
    let secrets = normalizeSecrets(got.secrets);
    if (raw !== undefined && (!isObj(raw) || raw.schemaVersion !== SCHEMA_VERSION)) {
      if (got.bankBackupV1 === undefined) await storage.set({ bankBackupV1: raw });
      await storage.set({ bank });
    }
    if (op.kind === 'readBank') return { bank };
    if (op.kind === 'readSecrets') return { bank, secrets };
    const answerKeys = ['questions', 'answer', 'values', 'scope', 'kind', 'tags', 'sensitive'];
    switch (op.kind) {
      case 'profile': applyPatches(bank.profile, op.patches, Object.keys(bank.profile)); break;
      case 'settings':
        applyPatches(bank.settings, op.patches, ['matching', 'llm']);
        if (op.secretPatches) applyPatches(secrets, op.secretPatches, ['apiKeys']);
        break;
      case 'secrets': applyPatches(secrets, op.patches, ['apiKeys']); break;
      case 'addAnswer':
        if (bank.answers.some(a => a.id === op.entry.id)) throw new Error('Answer already exists.');
        bank.answers.push(op.entry); break;
      case 'editAnswer': {
        const entry = bank.answers.find(a => a.id === op.id);
        if (!entry) throw new Error('This answer was deleted in another window. Your draft has been kept.');
        applyPatches(entry, op.patches, answerKeys);
        entry.updatedAt = Date.now(); break;
      }
      case 'deleteAnswer': {
        const entry = bank.answers.find(a => a.id === op.id);
        if (!entry || answerKeys.some(k => !same(entry[k as keyof typeof entry], op.before[k as keyof typeof entry]))) throw new Error('Conflict: the answer changed or was deleted. Reload before deleting.');
        bank.answers = bank.answers.filter(a => a.id !== op.id); break;
      }
      case 'learn': {
        const entry = bank.answers.find(a => a.id === op.id);
        if (!entry || entry.answer !== op.answer || !same(entry.values, op.values) || !scopeAllows(entry, { company: op.company })) return { bank };
        const questions = [...entry.questions, op.question];
        if (effectiveScope({ ...entry, questions }).type === 'unassigned') return { bank };
        entry.timesUsed++;
        entry.lastUsedAt = Date.now();
        if (!entry.questions.some(q => normalizeText(q) === normalizeText(op.question))) entry.questions.push(op.question);
        entry.sensitive = effectiveSensitive(entry.questions, entry.sensitive) ?? undefined;
        break;
      }
      case 'import': {
        const incoming = parseImport(op.text);
        if (op.mode !== 'merge' && op.mode !== 'replace') throw new Error('Invalid import mode');
        if (op.mode === 'replace' && !same(bank, op.before)) throw new Error('The bank changed while importing. Review the latest bank before replacing it.');
        bank = op.mode === 'replace' ? incoming.bank : mergeBanks(bank, incoming.bank);
        if (incoming.secrets) secrets = { apiKeys: { ...secrets.apiKeys, ...incoming.secrets.apiKeys } };
        break;
      }
      default: throw new Error('Unknown storage operation');
    }
    bank = validateBank(bank, true);
    secrets = normalizeSecrets(secrets, true);
    // One storage operation for import and settings transactions; no stale whole-bank writes from UI.
    await storage.set({ bank, secrets });
    return { bank, ...(op.kind === 'secrets' || op.kind === 'settings' || op.kind === 'import' ? { secrets } : {}) };
  }
  return (op: Mutation): Promise<MutationResult> => {
    const result = queue.then(() => run(op));
    queue = result.catch(() => undefined);
    return result;
  };
}
