// LLM drafting interface. Provider calls arrive in milestone 2; the privacy filter is enforced already.

import { effectiveSensitive, NEVER_SEND_TO_LLM } from '../shared/sensitive';
import { scopeAllows } from '../shared/scope';
import type { AnswerEntry, Bank, DetectedField, LlmProvider, Profile, PageInfo } from '../shared/schema';

export interface DraftRequest {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  field: DetectedField;
  jobDescription: string;
  context: LlmContext;
}

export interface LlmContext {
  profile: Pick<Profile, 'university' | 'degree' | 'graduation' | 'highSchool' | 'languages' | 'skills'>;
  previousAnswers: { question: string; answer: string }[];
}

function containsContact(text: string, profile: Profile): boolean {
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text) || /(?:\+?\d[\s().-]*){7,}/.test(text)) return true;
  const normal = text.toLowerCase();
  return [profile.email, profile.phone, profile.location.postcode, profile.linkedin, profile.github, profile.website]
    .some(v => v.trim().length > 1 && normal.includes(v.trim().toLowerCase()));
}

export function buildContext(bank: Bank, page?: Pick<PageInfo, 'company'>): LlmContext {
  const p = bank.profile;
  const previousAnswers = bank.answers.filter(a => {
    const sensitive = effectiveSensitive(a.questions, a.sensitive);
    const allText = [...a.questions, a.answer, ...(a.values ?? [])].join(' ');
    return !(sensitive && NEVER_SEND_TO_LLM.has(sensitive)) && scopeAllows(a, page) &&
      !a.questions.some(q => /email|e-mail|phone|telephone|contact|postcode|postal code|zip code|linkedin|github|website|portfolio/i.test(q)) && !containsContact(allText, p);
  }).map(a => ({ question: a.questions[0], answer: a.answer }));
  // Explicit allowlist: new profile properties cannot silently become model context.
  const profile = {
    university: p.university, degree: p.degree, graduation: { ...p.graduation }, highSchool: p.highSchool,
    languages: p.languages.map(l => ({ ...l })), skills: p.skills.map(s => ({ ...s })),
  };
  profile.university = containsContact(profile.university, p) ? '' : profile.university;
  profile.degree = containsContact(profile.degree, p) ? '' : profile.degree;
  profile.highSchool = containsContact(profile.highSchool, p) ? '' : profile.highSchool;
  profile.languages = profile.languages.filter(l => !containsContact(l.name, p));
  profile.skills = profile.skills.filter(s => !containsContact(s.name, p));
  return { profile, previousAnswers };
}

/** Throws for questions that must never be sent to a model. */
export function assertSendable(field: DetectedField): void {
  const sensitive = effectiveSensitive([field.question, field.description ?? ''], field.sensitive, field.section);
  if (sensitive && NEVER_SEND_TO_LLM.has(sensitive)) {
    throw new Error('This question is never sent to an AI model. Answer it yourself.');
  }
}

export async function draftAnswer(req: DraftRequest): Promise<string> {
  assertSendable(req.field);
  throw new Error('AI drafting is not enabled yet.');
}
