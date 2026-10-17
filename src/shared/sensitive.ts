// Flags knockout and sensitive questions so they're always reviewed by hand.

import { conceptsOf } from './normalize';
import type { SensitiveCategory } from './schema';

const DEMOGRAPHIC_CONCEPTS = new Set([
  'gender',
  'ethnicity',
  'orientation',
  'religion',
  'age',
  'marital',
  'veteran',
  'social_mobility',
  'pronouns',
]);

// Order matters: the first category that applies wins.
const CONCEPT_TO_CATEGORY: [string, SensitiveCategory][] = [
  ['disability', 'disability'],
  ['criminal', 'criminal'],
  ['sponsorship', 'sponsorship'],
  ['work_auth', 'right_to_work'],
  ['visa_status', 'right_to_work'],
  ['us_person', 'right_to_work'],
  ['experience_years', 'experience_years'],
];

/** Sections whose questions are demographic regardless of wording (EEOC, diversity surveys). */
export const DEMOGRAPHIC_SECTIONS = new Set(['eeoc', 'demographic']);

export function classifySensitive(question: string, section?: string): SensitiveCategory | null {
  const concepts = new Set(conceptsOf(question));
  if (section && DEMOGRAPHIC_SECTIONS.has(section)) {
    // A disability question inside a diversity survey is still a disability question.
    return concepts.has('disability') ? 'disability' : 'demographic';
  }
  for (const c of concepts) if (DEMOGRAPHIC_CONCEPTS.has(c)) return 'demographic';
  for (const [concept, cat] of CONCEPT_TO_CATEGORY) if (concepts.has(concept)) return cat;
  return null;
}

/** Categories whose answers must never leave the machine (enforced by src/llm). */
export const NEVER_SEND_TO_LLM: ReadonlySet<SensitiveCategory> = new Set(['demographic', 'disability']);

export function effectiveSensitive(questions: string[], stored?: SensitiveCategory | null, section?: string): SensitiveCategory | null {
  const all = [stored, ...questions.map(q => classifySensitive(q, section))];
  return all.find(c => c && NEVER_SEND_TO_LLM.has(c)) ?? all.find(c => !!c) ?? null;
}
