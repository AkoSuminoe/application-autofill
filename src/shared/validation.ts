import { emptyBank, newAnswerId, SCHEMA_VERSION, SENSITIVE_LABELS, type AnswerEntry, type Bank, type Secrets } from './schema';
import { effectiveSensitive } from './sensitive';
import { effectiveScope } from './scope';

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const providers = ['anthropic', 'openai', 'gemini'];

export function normalizeSecrets(raw: unknown, strict = false): Secrets {
  const out: Secrets = { apiKeys: {} };
  if (raw === undefined) return out;
  if (isObj(raw) && raw.apiKeys === undefined) return out;
  if (!isObj(raw) || !isObj(raw.apiKeys)) {
    if (strict) throw new Error('secrets.apiKeys: expected an object');
    return out;
  }
  for (const [k, v] of Object.entries(raw.apiKeys)) {
    if (!providers.includes(k) || typeof v !== 'string') {
      if (strict) throw new Error(`secrets.apiKeys.${k}: expected a supported provider and string key`);
      continue;
    }
    out.apiKeys[k as keyof Secrets['apiKeys']] = v;
  }
  return out;
}

export function validateBank(raw: unknown, strict = false): Bank {
  const out = emptyBank();
  const bad = (path: string, expected: string) => { if (strict) throw new Error(`${path}: expected ${expected}`); };
  const obj = (v: unknown, p: string): Record<string, unknown> => {
    if (v === undefined) return {};
    if (isObj(v)) return v;
    bad(p, 'an object'); return {};
  };
  const string = (v: unknown, p: string, fallback = ''): string => {
    if (v === undefined) return fallback;
    if (typeof v === 'string') return v;
    bad(p, 'a string'); return fallback;
  };
  const num = (v: unknown, p: string, fallback: number, min: number, max: number, integer = false): number => {
    if (v === undefined) return fallback;
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v))) return v;
    bad(p, `${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}`); return fallback;
  };
  const enumeration = <T extends string>(v: unknown, p: string, options: readonly T[], fallback: T): T => {
    if (v === undefined) return fallback;
    if (typeof v === 'string' && options.includes(v as T)) return v as T;
    bad(p, options.join(' / ')); return fallback;
  };
  const bool = (v: unknown, p: string, fallback: boolean): boolean => {
    if (v === undefined) return fallback;
    if (typeof v === 'boolean') return v;
    bad(p, 'a boolean'); return fallback;
  };
  const array = (v: unknown, p: string): unknown[] => {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v;
    bad(p, 'an array'); return [];
  };
  const strings = (v: unknown, p: string) => array(v, p).flatMap((x, i) => {
    if (typeof x !== 'string') { bad(`${p}[${i}]`, 'a string'); return []; }
    return [x];
  });
  const b = obj(raw, 'bank');
  num(b.schemaVersion, 'schemaVersion', SCHEMA_VERSION, 1, SCHEMA_VERSION, true);
  const p = obj(b.profile, 'profile');
  for (const k of Object.keys(out.profile) as (keyof Bank['profile'])[]) {
    if (typeof out.profile[k] === 'string') (out.profile as unknown as Record<string, unknown>)[k] = string(p[k], `profile.${k}`);
  }
  out.profile.needsSponsorship = enumeration(p.needsSponsorship, 'profile.needsSponsorship', ['', 'yes', 'no'], '');
  const loc = obj(p.location, 'profile.location');
  for (const k of ['city', 'country', 'postcode'] as const) out.profile.location[k] = string(loc[k], `profile.location.${k}`);
  const grad = obj(p.graduation, 'profile.graduation');
  const nullableInteger = (value: unknown, path: string, min: number, max: number) => {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
    bad(path, `an integer between ${min} and ${max}, or null`); return null;
  };
  out.profile.graduation.month = nullableInteger(grad.month, 'profile.graduation.month', 1, 12);
  out.profile.graduation.year = nullableInteger(grad.year, 'profile.graduation.year', 1900, 2200);
  for (const k of ['languages', 'skills'] as const) {
    const levels = k === 'languages' ? ['native', 'fluent', 'professional', 'basic'] as const : ['beginner', 'intermediate', 'advanced', 'expert'] as const;
    const list = array(p[k], `profile.${k}`).flatMap((x, i) => {
      const path = `profile.${k}[${i}]`;
      if (!isObj(x)) { bad(path, 'an object'); return []; }
      return [{ name: string(x.name, `${path}.name`), level: enumeration(x.level, `${path}.level`, levels, levels[1]) }];
    });
    (out.profile as unknown as Record<string, unknown>)[k] = list;
  }
  const settings = obj(b.settings, 'settings');
  const matching = obj(settings.matching, 'settings.matching');
  out.settings.matching.highConfidence = num(matching.highConfidence, 'settings.matching.highConfidence', .85, 0, 1);
  out.settings.matching.minShow = num(matching.minShow, 'settings.matching.minShow', Math.min(.5, out.settings.matching.highConfidence), 0, 1);
  if (out.settings.matching.minShow > out.settings.matching.highConfidence) {
    bad('settings.matching.minShow', 'a value no greater than highConfidence');
    out.settings.matching.minShow = out.settings.matching.highConfidence;
  }
  out.settings.matching.useEmbeddings = bool(matching.useEmbeddings, 'settings.matching.useEmbeddings', false);
  const llm = obj(settings.llm, 'settings.llm');
  out.settings.llm.enabled = bool(llm.enabled, 'settings.llm.enabled', false);
  out.settings.llm.provider = enumeration(llm.provider, 'settings.llm.provider', ['anthropic', 'openai', 'gemini'], 'anthropic');
  out.settings.llm.model = string(llm.model, 'settings.llm.model');
  const ids = new Set<string>();
  out.answers = array(b.answers, 'answers').flatMap((x, i) => {
    const path = `answers[${i}]`;
    if (!isObj(x)) { bad(path, 'an object'); return []; }
    const questions = strings(x.questions, `${path}.questions`).map(q => q.trim()).filter(Boolean);
    if (!questions.length || typeof x.answer !== 'string') { bad(path, 'nonempty questions and a string answer'); return []; }
    let id = string(x.id, `${path}.id`, newAnswerId());
    if (!id || ids.has(id)) { bad(`${path}.id`, 'a unique nonempty ID'); id = newAnswerId(); }
    ids.add(id);
    const entry: AnswerEntry = {
      id, questions, answer: x.answer,
      kind: enumeration(x.kind, `${path}.kind`, ['text', 'choice', 'boolean'], 'text'),
      tags: strings(x.tags, `${path}.tags`),
      createdAt: num(x.createdAt, `${path}.createdAt`, Date.now(), 0, Number.MAX_SAFE_INTEGER, true),
      updatedAt: num(x.updatedAt, `${path}.updatedAt`, Date.now(), 0, Number.MAX_SAFE_INTEGER, true),
      timesUsed: num(x.timesUsed, `${path}.timesUsed`, 0, 0, Number.MAX_SAFE_INTEGER, true),
      lastUsedAt: x.lastUsedAt == null ? null : num(x.lastUsedAt, `${path}.lastUsedAt`, 0, 0, Number.MAX_SAFE_INTEGER, true),
    };
    if (x.values !== undefined) entry.values = [...new Set(strings(x.values, `${path}.values`).filter(Boolean))];
    if (x.sensitive !== undefined) entry.sensitive = enumeration(x.sensitive, `${path}.sensitive`, Object.keys(SENSITIVE_LABELS) as NonNullable<AnswerEntry['sensitive']>[], 'demographic');
    entry.sensitive = effectiveSensitive(questions, entry.sensitive) ?? undefined;
    if (x.scope !== undefined) {
      const s = obj(x.scope, `${path}.scope`);
      const type = enumeration(s.type, `${path}.scope.type`, ['global', 'company', 'unassigned'], 'unassigned');
      if (type === 'company') {
        const company = string(s.company, `${path}.scope.company`).trim();
        if (!company) bad(`${path}.scope.company`, 'a nonempty company name');
        entry.scope = company ? { type, company } : { type: 'unassigned' };
      } else entry.scope = { type };
    }
    entry.scope = effectiveScope(entry);
    const overrides = array(x.companyOverrides, `${path}.companyOverrides`).flatMap((v, j) => {
      const op = `${path}.companyOverrides[${j}]`;
      if (!isObj(v)) { bad(op, 'an object'); return []; }
      const company = string(v.company, `${op}.company`).trim();
      const answer = string(v.answer, `${op}.answer`);
      const updatedAt = num(v.updatedAt, `${op}.updatedAt`, entry.updatedAt, 0, Number.MAX_SAFE_INTEGER, true);
      if (!company) { bad(`${op}.company`, 'a nonempty company name'); return []; }
      return [{ ...entry, id: newAnswerId(), answer, values: undefined, updatedAt, scope: { type: 'company' as const, company } }];
    });
    return [entry, ...overrides];
  });
  return out;
}
