// Matches a detected question against the profile and the answer bank.

import { conceptsOf, dice, isNegated, jaccard, normalizeText, tokenize, trigrams } from './normalize';
import type { AnswerEntry, Bank, DetectedField, FieldKind, Profile, PageInfo } from './schema';
import { scopeAllows, companyDependent } from './scope';
import { effectiveSensitive } from './sensitive';

export interface Prepared {
  norm: string;
  tokens: Set<string>;
  concepts: string[];
  tri: Set<string>;
  negated: boolean;
}

export function prepare(text: string): Prepared {
  const tokens = tokenize(text);
  let concepts = conceptsOf(text);
  const norm = normalizeText(text);
  if (concepts.includes('graduation') && /graduat|completion date|finish.*stud/.test(norm)) concepts = ['graduation', ...concepts.filter(c => !['graduation', 'university', 'degree'].includes(c))];
  if (/^(your |current )?(street |full |home |mailing |postal )?address$|\bstreet address\b/.test(norm)) concepts = ['street_address'];
  else if (/\b(city|town)\b/.test(norm) && !/\bcountry\b/.test(norm)) concepts = ['city', ...concepts.filter(c => c !== 'location')];
  return {
    norm,
    tokens: new Set(tokens),
    concepts,
    tri: trigrams(tokens.join(' ')),
    negated: isNegated(text),
  };
}

// Concepts whose answer depends on details in the wording (which company, which technology),
// so sharing the concept alone isn't enough for a confident match.
const WEAK_CONCEPTS = new Set(['experience_years', 'languages', 'skills', 'motivation', 'cover_letter', 'work_location', 'previous_employee']);

/** 0..1 similarity between two questions. */
export function questionSimilarity(a: Prepared, b: Prepared): number {
  if (a.norm && a.norm === b.norm) return 1;
  const tok = dice(a.tokens, b.tokens);
  const tri = dice(a.tri, b.tri);
  const lexical = 0.65 * tok + 0.35 * tri;
  const ca = a.concepts.length > 0;
  const cb = b.concepts.length > 0;
  if (ca && cb) {
    const primary = a.concepts[0] === b.concepts[0] ? a.concepts[0] : null;
    // Same factual concept ("notice period" vs "when could you start") is a confident match by itself.
    if (primary && !WEAK_CONCEPTS.has(primary)) return 0.86 + 0.14 * Math.max(tok, tri);
    // Weak concept: the differing words (company, technology) decide it.
    if (primary) return 0.2 + 0.8 * lexical;
    const concept = jaccard(new Set(a.concepts), new Set(b.concepts));
    return 0.55 * concept + 0.3 * tok + 0.15 * tri;
  }
  if (ca !== cb) return 0.8 * lexical;
  return lexical;
}

export const POLARITY_CAP = 0.8;
export const OPTION_MISSING_CAP = 0.4;

export interface MatchCandidate {
  source: 'answer' | 'profile';
  entryId?: string;
  profileKey?: string;
  /** Text to fill / copy (for choice fields this is the resolved option when found). */
  answer: string;
  /** The stored answer before option resolution. */
  rawAnswer: string;
  score: number;
  /** Question similarity before any option/polarity caps. */
  questionScore: number;
  matchedWording: string;
  polarityWarning: boolean;
  optionMissing: boolean;
  values?: string[];
  rawValues?: string[];
  reviewRequired?: boolean;
  scopeWarning?: boolean;
  sensitive?: boolean;
}

const CHOICE_KINDS: FieldKind[] = ['select', 'radio', 'combobox', 'checkboxGroup'];

// ---- Option resolution ----

const YES = /^(yes|y|true|i do|i am|i have|i can|i will|correct|agree|i agree)\b/;
const NO = /^(no|n|false|i do not|i am not|i have not|i cannot|i will not|none)\b/;
// Options only count as yes/no when they literally say so; "I'm a citizen…" is a statement, not a Yes.
const OPTION_YES = /^(yes|y|true)\b/;
const OPTION_NO = /^(no|n|false)\b/;

function polarityOf(s: string, strict = false): 'yes' | 'no' | null {
  const n = normalizeText(s);
  if ((strict ? OPTION_NO : NO).test(n)) return 'no';
  if ((strict ? OPTION_YES : YES).test(n)) return 'yes';
  return null;
}

/** Pick the option that best represents `answer`. Returns null when nothing is close enough. */
export function resolveOption(answer: string, options: string[]): { option: string; score: number } | null {
  if (!answer.trim() || options.length === 0) return null;
  const na = normalizeText(answer);
  let best: { option: string; score: number } | null = null;
  let tied = false;
  const consider = (option: string, score: number) => {
    if (!best || score > best.score) { best = { option, score }; tied = false; }
    else if (score === best.score && option !== best.option) tied = true;
  };
  const pa = polarityOf(answer);
  const ta = new Set(tokenize(answer));
  for (const option of options) {
    const no = normalizeText(option);
    if (!no) continue;
    if (no === na) {
      consider(option, 1);
      continue;
    }
    const po = polarityOf(option, true);
    if (pa && po) {
      consider(option, pa === po ? 0.9 : 0);
      continue;
    }
    if (no.length >= 3 && (na.includes(no) || no.includes(na))) consider(option, 0.85);
    consider(option, dice(ta, new Set(tokenize(option))) * 0.9);
  }
  const b = best as { option: string; score: number } | null;
  return b && b.score >= 0.6 && !tied ? b : null;
}

/** Exact labels first; a legacy string is split only when exactly one option sequence fits. */
export function resolveMultiple(answer: string, options: string[], values?: string[]): string[] | null {
  const key = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  const exact = (s: string) => options.filter(o => key(o) === key(s));
  if (values) {
    const picks = values.map(exact);
    return picks.every(p => p.length === 1) ? [...new Set(picks.map(p => p[0]))] : null;
  }
  const whole = exact(answer);
  if (whole.length) return whole.length === 1 ? whole : null;
  const solutions: string[][] = [];
  const visit = (rest: string, picked: string[]) => {
    if (solutions.length > 1 || picked.length > options.length) return;
    if (!rest.trim()) { solutions.push(picked); return; }
    for (const option of options) {
      const text = key(rest), label = key(option);
      if (!label || picked.includes(option) || !text.startsWith(label)) continue;
      const tail = text.slice(label.length).trim();
      if (!tail) visit('', [...picked, option]);
      else if (/^[,;\n]/.test(tail)) visit(tail.slice(1).trim(), [...picked, option]);
    }
  };
  visit(answer, []);
  return solutions.length === 1 ? solutions[0] : null;
}

// ---- Profile rules ----

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function graduationValue(p: Profile, field: DetectedField): string | null {
  const { month, year } = p.graduation;
  if (field.inputType === 'date') return null; // No day is stored; never invent one.
  if (field.inputType === 'month') return month && year ? `${year}-${String(month).padStart(2, '0')}` : null;
  const q = normalizeText(field.question);
  const opts = field.options.map((o) => normalizeText(o));
  const wantsYear = /\byear\b/.test(q) && !/\bmonth\b/.test(q);
  const wantsMonth = /\bmonth\b/.test(q) && !/\byear\b/.test(q);
  const optsAreYears = opts.length > 0 && opts.filter((o) => /^\d{4}$/.test(o)).length >= opts.length / 2;
  const optsAreMonths = opts.length > 0 && opts.some((o) => o.startsWith('jan')) && opts.some((o) => o.startsWith('dec'));
  if ((wantsYear || optsAreYears) && year) return String(year);
  if ((wantsMonth || optsAreMonths) && month) return MONTHS[month - 1];
  if (month && year) return `${MONTHS[month - 1]} ${year}`;
  if (year) return String(year);
  return null;
}

type ProfileRule = (p: Profile, field: DetectedField, negated: boolean) => string | null;

const nonEmpty = (s: string) => (s.trim() ? s.trim() : null);

export const PROFILE_RULES: Record<string, { key: string; value: ProfileRule }> = {
  preferred_name: { key: 'preferredName', value: (p) => nonEmpty(p.preferredName) ?? nonEmpty(p.firstName) },
  first_name: { key: 'firstName', value: (p) => nonEmpty(p.firstName) },
  last_name: { key: 'lastName', value: (p) => nonEmpty(p.lastName) },
  full_name: { key: 'fullName', value: (p) => nonEmpty(`${p.firstName} ${p.lastName}`) },
  email: { key: 'email', value: (p) => nonEmpty(p.email) },
  phone: { key: 'phone', value: (p) => nonEmpty(p.phone) },
  linkedin: { key: 'linkedin', value: (p) => nonEmpty(p.linkedin) },
  github: { key: 'github', value: (p) => nonEmpty(p.github) },
  website: { key: 'website', value: (p) => nonEmpty(p.website) ?? nonEmpty(p.github) },
  postcode: { key: 'location.postcode', value: (p) => nonEmpty(p.location.postcode) },
  country: { key: 'location.country', value: (p) => nonEmpty(p.location.country) },
  city: {
    key: 'location.city',
    // Location autocompletes list many same-named cities ("London, Ontario"); the country disambiguates.
    value: (p, f) =>
      f.kind === 'combobox' && p.location.city.trim() && p.location.country.trim()
        ? `${p.location.city.trim()}, ${p.location.country.trim()}`
        : nonEmpty(p.location.city),
  },
  location: {
    key: 'location.city',
    value: (p) => nonEmpty([p.location.city, p.location.country].filter(Boolean).join(', ')),
  },
  high_school: { key: 'highSchool', value: (p) => nonEmpty(p.highSchool) },
  university: { key: 'university', value: (p) => nonEmpty(p.university) },
  degree: { key: 'degree', value: (p) => nonEmpty(p.degree) },
  graduation: { key: 'graduation', value: (p, f) => graduationValue(p, f) },
  salary: { key: 'salaryExpectation', value: (p) => nonEmpty(p.salaryExpectation) },
  start_date: { key: 'startDate', value: (p) => nonEmpty(p.startDate) },
  visa_status: { key: 'visaStatus', value: (p) => nonEmpty(p.visaStatus) },
  sponsorship: {
    key: 'needsSponsorship',
    value: (p, _f, negated) => {
      if (!p.needsSponsorship) return null;
      // "Can you work WITHOUT sponsorship?" flips the answer. Flagged as a polarity warning by the caller.
      const needs = p.needsSponsorship === 'yes';
      return (negated ? !needs : needs) ? 'Yes' : 'No';
    },
  },
  languages: {
    key: 'languages',
    value: (p) => nonEmpty(p.languages.map((l) => `${l.name} (${l.level})`).join(', ')),
  },
  skills: { key: 'skills', value: (p) => nonEmpty(p.skills.map((s) => s.name).join(', ')) },
};

// HTML autocomplete tokens are the most reliable hint when present.
const AUTOCOMPLETE_TO_CONCEPT: Record<string, string> = {
  'given-name': 'first_name',
  'family-name': 'last_name',
  name: 'full_name',
  nickname: 'preferred_name',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'postal-code': 'postcode',
  'country-name': 'country',
  country: 'country',
  'address-level2': 'city',
  url: 'website',
};

function profileCandidate(field: DetectedField, q: Prepared, profile: Profile): MatchCandidate | null {
  const tokens = field.autocomplete?.toLowerCase().split(/\s+/) ?? [];
  if (tokens.some(t => ['street-address', 'address-line1', 'address-line2', 'address-line3'].includes(t)) || /^(your |current )?(street |full |home |mailing |postal )?address$|\bstreet address\b/.test(q.norm)) return null;
  const ac = tokens.map(t => AUTOCOMPLETE_TO_CONCEPT[t]).find(Boolean);
  let relevant = q.concepts.filter(c => PROFILE_RULES[c]);
  if (q.concepts.includes('graduation') && /graduat|completion date|finish.*stud/.test(q.norm)) relevant = ['graduation'];
  else if (/\b(city|town)\b/.test(q.norm) && !/\bcountry\b/.test(q.norm)) relevant = ['city'];
  else if (relevant.includes('preferred_name')) relevant = relevant.filter(c => c !== 'first_name' && c !== 'full_name');
  const concept = ac ?? relevant[0];
  if (!concept) return null;
  const ambiguous = relevant.length > 1 || (!!ac && relevant.length > 0 && !relevant.includes(ac) && !(ac === 'city' && relevant.includes('location')));
  const rule = PROFILE_RULES[concept];
  if (!rule) return null;
  const value = rule.value(profile, field, q.negated);
  if (!value) return null;
  // Short, focused questions ("LinkedIn Profile") are near-certain; long ones less so.
  let score = ac ? 0.98 : q.tokens.size <= 4 ? 0.95 : 0.88;
  const polarityWarning = concept === 'sponsorship' && q.negated;
  if (polarityWarning) score = Math.min(score, POLARITY_CAP);
  return {
    source: 'profile',
    profileKey: rule.key,
    answer: value,
    rawAnswer: value,
    score,
    questionScore: score,
    matchedWording: `Profile: ${rule.key}`,
    polarityWarning,
    optionMissing: false,
    reviewRequired: ambiguous || companyDependent(field.question),
    values: field.multiple && concept === 'skills' ? profile.skills.map(s => s.name) : undefined,
  };
}

function answerCandidate(field: DetectedField, q: Prepared, entry: AnswerEntry): MatchCandidate | null {
  let best = 0;
  let wording = '';
  let polarity = false;
  let intentConflict = false;
  for (const w of entry.questions) {
    const p = prepare(w);
    let s = questionSimilarity(q, p);
    const flip = q.negated !== p.negated && s > 0.5 && (q.concepts.length > 0 || p.concepts.length > 0);
    if (flip) s = Math.min(s, POLARITY_CAP);
    if (s > best) {
      best = s;
      wording = w;
      polarity = flip;
      const factual = new Set([...Object.keys(PROFILE_RULES), 'street_address']);
      intentConflict = factual.has(q.concepts[0]) && factual.has(p.concepts[0]) && q.concepts[0] !== p.concepts[0];
    }
  }
  if (best <= 0) return null;
  return {
    source: 'answer',
    entryId: entry.id,
    answer: entry.answer,
    rawAnswer: entry.answer,
    score: best,
    questionScore: best,
    matchedWording: wording,
    polarityWarning: polarity,
    optionMissing: false,
    values: entry.values,
    rawValues: entry.values,
    sensitive: !!effectiveSensitive(entry.questions, entry.sensitive),
    reviewRequired: intentConflict,
  };
}

/** Adjusts a candidate for fields with a fixed set of options. */
function applyOptions(field: DetectedField, c: MatchCandidate): MatchCandidate {
  if (field.multiple) {
    const values = field.options.length ? resolveMultiple(c.rawAnswer, field.options, c.values) : c.values;
    return values?.length ? { ...c, values, answer: values.join(', ') } : { ...c, optionMissing: true, score: Math.min(c.score, OPTION_MISSING_CAP) };
  }
  if (!CHOICE_KINDS.includes(field.kind) || field.options.length === 0) return c;
  const resolved = resolveOption(c.rawAnswer, field.options);
  if (resolved) return { ...c, answer: resolved.option, reviewRequired: c.reviewRequired || resolved.score < .9 };
  return { ...c, optionMissing: true, score: Math.min(c.score, OPTION_MISSING_CAP) };
}

/** Top matches for a field, best first. */
export function matchField(field: DetectedField, bank: Bank, limit = 3, page?: Pick<PageInfo, 'company'>): MatchCandidate[] {
  if (field.kind === 'file' || !field.question.trim()) return [];
  const q = prepare(field.question);
  const out: MatchCandidate[] = [];
  const pc = profileCandidate(field, q, bank.profile);
  if (pc) out.push(applyOptions(field, pc));
  for (const entry of bank.answers) {
    const c = answerCandidate(field, q, entry);
    if (c && c.score >= 0.3) {
      const allowed = scopeAllows(entry, page) && (!companyDependent(field.question) || entry.scope?.type === 'company');
      out.push(applyOptions(field, { ...c, scopeWarning: !allowed }));
    }
  }
  out.sort((a, b) => Number(!!a.scopeWarning) - Number(!!b.scopeWarning) || b.score - a.score);
  if (out.length > 1 && !out[0].scopeWarning && !out[1].scopeWarning && Math.abs(out[0].score - out[1].score) < .05 && out[0].answer !== out[1].answer) out[0].reviewRequired = true;
  return out.slice(0, limit);
}

/** True if `wording` is already (exactly, after normalisation) one of the entry's questions. */
export function hasWording(entry: AnswerEntry, wording: string): boolean {
  const n = normalizeText(wording);
  return entry.questions.some((q) => normalizeText(q) === n);
}
