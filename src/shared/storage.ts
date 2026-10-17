// chrome.storage.local wrapper plus pure helpers for migration, import and export.

import { normalizeText } from './normalize';
import {
  SCHEMA_VERSION,
  newAnswerId,
  type AnswerEntry,
  type Bank,
  type Secrets,
} from './schema';

import { validateBank, normalizeSecrets, isObj } from './validation';
import { effectiveSensitive, NEVER_SEND_TO_LLM } from './sensitive';
import { scopeKey } from './scope';

export const normalizeBank = validateBank;

export interface ExportFile {
  app: 'application-autofill';
  exportedAt: string;
  bank: Bank;
  secrets?: Secrets;
}

export function buildExport(bank: Bank, secrets: Secrets | null): string {
  const file: ExportFile = { app: 'application-autofill', exportedAt: new Date().toISOString(), bank };
  if (secrets) file.secrets = secrets;
  return JSON.stringify(file, null, 2);
}

export function parseImport(text: string): { bank: Bank; secrets: Secrets | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  // Accept both the export wrapper and a bare bank object.
  const bankRaw = isObj(data) && isObj(data.bank) ? data.bank : data;
  if (!isObj(bankRaw) || (!('profile' in bankRaw) && !('answers' in bankRaw))) {
    throw new Error('No profile or answers found in that file.');
  }
  const v = bankRaw.schemaVersion;
  if (typeof v === 'number' && v > SCHEMA_VERSION) {
    throw new Error(`This backup is from a newer version (schema ${v}). Update the extension first.`);
  }
  const secrets = isObj(data) && data.secrets !== undefined ? normalizeSecrets(data.secrets, true) : null;
  return { bank: validateBank(bankRaw, true), secrets };
}

/**
 * Merge an imported bank into the current one. Non-empty imported profile values win;
 * answers with overlapping wording are combined, keeping the more recently updated answer text.
 */
export function mergeBanks(current: Bank, incoming: Bank): Bank {
  const profile = mergeProfile(current.profile, incoming.profile);
  const answers = current.answers.map((a) => ({ ...a, questions: [...a.questions] }));
  for (const inc of incoming.answers) {
    const keys = new Set(inc.questions.map(normalizeText));
    const existing = answers.find((a) => scopeKey(a) === scopeKey(inc) && a.questions.some((q) => keys.has(normalizeText(q))));
    if (!existing) {
      answers.push({ ...inc, id: answers.some((a) => a.id === inc.id) ? newAnswerId() : inc.id });
      continue;
    }
    for (const q of inc.questions) {
      if (!existing.questions.some((e) => normalizeText(e) === normalizeText(q))) existing.questions.push(q);
    }
    if (inc.updatedAt > existing.updatedAt) {
      existing.answer = inc.answer;
      existing.kind = inc.kind;
      existing.values = inc.values;
      existing.updatedAt = inc.updatedAt;
    }
    existing.tags = [...new Set([...existing.tags, ...inc.tags])];
    existing.sensitive = effectiveSensitive(existing.questions, inc.sensitive && NEVER_SEND_TO_LLM.has(inc.sensitive) ? inc.sensitive : existing.sensitive ?? inc.sensitive) ?? undefined;
  }
  return { ...current, profile, answers };
}

function mergeProfile<T>(cur: T, inc: T): T {
  if (Array.isArray(inc)) return (inc.length ? inc : cur) as T;
  if (isObj(cur) && isObj(inc)) {
    const out: Record<string, unknown> = { ...cur };
    for (const k of Object.keys(cur)) out[k] = mergeProfile(cur[k], inc[k]);
    return out as T;
  }
  return inc === '' || inc === null || inc === undefined ? cur : inc;
}

// All writes are performed by the service worker, including migrations and imports.
export interface Patch { path: string[]; before?: unknown; value?: unknown; remove?: boolean }
export type Mutation =
  | { kind: 'readBank' }
  | { kind: 'readSecrets' }
  | { kind: 'profile' | 'secrets'; patches: Patch[] }
  | { kind: 'settings'; patches: Patch[]; secretPatches?: Patch[] }
  | { kind: 'addAnswer'; entry: AnswerEntry }
  | { kind: 'editAnswer'; id: string; patches: Patch[] }
  | { kind: 'deleteAnswer'; id: string; before: AnswerEntry }
  | { kind: 'learn'; id: string; question: string; company: string; answer: string; values?: string[] }
  | { kind: 'import'; text: string; mode: 'merge' | 'replace'; before?: Bank };
export interface MutationResult { bank: Bank; secrets?: Secrets }

export function diffFields(before: unknown, next: unknown, path: string[] = []): Patch[] {
  if (JSON.stringify(before) === JSON.stringify(next)) return [];
  if (isObj(before) && isObj(next)) {
    return [...new Set([...Object.keys(before), ...Object.keys(next)])].flatMap(k => diffFields(before[k], next[k], [...path, k]));
  }
  return [{ path, before, value: next, ...(next === undefined ? { remove: true } : {}) }];
}

/** Keep edits made while a save was pending without reverting unrelated committed changes. */
export function rebaseDraft<T>(submitted: T, current: T, committed: T): T {
  if (JSON.stringify(submitted) === JSON.stringify(current)) return structuredClone(committed);
  if (isObj(submitted) && isObj(current) && isObj(committed)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(submitted), ...Object.keys(current), ...Object.keys(committed)])) {
      const value = rebaseDraft(submitted[key], current[key], committed[key]);
      if (value !== undefined) result[key] = value;
    }
    return result as T;
  }
  return structuredClone(current);
}

export async function mutate(operation: Mutation): Promise<MutationResult> {
  const result = await chrome.runtime.sendMessage({ type: 'bankMutation', operation });
  if (!result?.ok) throw new Error(result?.error || 'Could not save. Your draft has been kept.');
  return result.data;
}
export async function loadBank(): Promise<Bank> { return (await mutate({ kind: 'readBank' })).bank; }
export async function loadSecrets(): Promise<Secrets> { return (await mutate({ kind: 'readSecrets' })).secrets!; }

export function onBankChanged(cb: (bank: Bank) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bank) cb(normalizeBank(changes.bank.newValue));
  });
}
