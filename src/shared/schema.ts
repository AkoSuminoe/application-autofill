// Data model for everything the extension stores, plus the shape of detected fields.

export const SCHEMA_VERSION = 2 as const;

export type LanguageLevel = 'native' | 'fluent' | 'professional' | 'basic';
export type SkillLevel = 'beginner' | 'intermediate' | 'advanced' | 'expert';

export interface Profile {
  firstName: string;
  lastName: string;
  preferredName: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  website: string;
  location: { city: string; country: string; postcode: string };
  university: string;
  degree: string;
  graduation: { month: number | null; year: number | null };
  highSchool: string;
  visaStatus: string;
  needsSponsorship: 'yes' | 'no' | '';
  salaryExpectation: string;
  startDate: string;
  languages: { name: string; level: LanguageLevel }[];
  skills: { name: string; level: SkillLevel }[];
}

export type SensitiveCategory =
  | 'right_to_work'
  | 'sponsorship'
  | 'criminal'
  | 'disability'
  | 'demographic'
  | 'experience_years';

export const SENSITIVE_LABELS: Record<SensitiveCategory, string> = {
  right_to_work: 'Right to work',
  sponsorship: 'Sponsorship',
  criminal: 'Criminal record',
  disability: 'Disability',
  demographic: 'Demographic',
  experience_years: 'Years of experience',
};

export type AnswerKind = 'text' | 'choice' | 'boolean';
export type AnswerScope = { type: 'global' } | { type: 'company'; company: string } | { type: 'unassigned' };

export interface AnswerEntry {
  id: string;
  /** Every wording seen for this question. Matching scores against all of them. */
  questions: string[];
  /** For choice questions, the preferred option text. */
  answer: string;
  values?: string[];
  scope?: AnswerScope;
  kind: AnswerKind;
  tags: string[];
  sensitive?: SensitiveCategory;
  createdAt: number;
  updatedAt: number;
  timesUsed: number;
  lastUsedAt: number | null;
  /** Legacy v1 import field; expanded into company-scoped entries during migration. */
  companyOverrides?: { company: string; answer: string; updatedAt: number }[];
}

export type LlmProvider = 'anthropic' | 'openai' | 'gemini';

export interface Settings {
  matching: { highConfidence: number; minShow: number; useEmbeddings: boolean };
  llm: { enabled: boolean; provider: LlmProvider; model: string };
}

export interface Bank {
  schemaVersion: typeof SCHEMA_VERSION;
  profile: Profile;
  answers: AnswerEntry[];
  settings: Settings;
}

/** Stored under a separate key so exports leave them out by default. */
export interface Secrets {
  apiKeys: Partial<Record<LlmProvider, string>>;
}

// ---- Detected fields (content script -> panel) ----

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'checkboxGroup'
  | 'combobox'
  | 'file';

export interface CharLimit {
  max: number;
  unit: 'chars' | 'words';
}

export interface DetectedField {
  /** Value of the data-aa-id attribute stamped on the control (or group anchor). */
  id: string;
  question: string;
  /** Help text under the question, if any. Shown in the panel; not used for matching. */
  description?: string;
  kind: FieldKind;
  required: boolean;
  options: string[];
  multiple: boolean;
  limit: CharLimit | null;
  currentValue: string;
  sensitive: SensitiveCategory | null;
  section?: string;
  /** Autocomplete hint from the page (e.g. "given-name"), used for profile matching. */
  autocomplete?: string;
  inputType?: string;
}

export interface PageInfo {
  url: string;
  ats: string;
  company: string;
  jobTitle: string;
}

// ---- Defaults ----

export function emptyProfile(): Profile {
  return {
    firstName: '',
    lastName: '',
    preferredName: '',
    email: '',
    phone: '',
    linkedin: '',
    github: '',
    website: '',
    location: { city: '', country: '', postcode: '' },
    university: '',
    degree: '',
    graduation: { month: null, year: null },
    highSchool: '',
    visaStatus: '',
    needsSponsorship: '',
    salaryExpectation: '',
    startDate: '',
    languages: [],
    skills: [],
  };
}

export function defaultSettings(): Settings {
  return {
    matching: { highConfidence: 0.85, minShow: 0.5, useEmbeddings: false },
    llm: { enabled: false, provider: 'anthropic', model: '' },
  };
}

export function emptyBank(): Bank {
  return { schemaVersion: SCHEMA_VERSION, profile: emptyProfile(), answers: [], settings: defaultSettings() };
}

export function newAnswerId(): string {
  return 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
