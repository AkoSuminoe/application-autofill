import { conceptsOf, normalizeText } from './normalize';
import type { AnswerEntry, AnswerScope, PageInfo } from './schema';

export function companyKey(company: string): string {
  return company.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function companyDependent(question: string): boolean {
  const concepts = conceptsOf(question);
  return concepts.some(c => ['motivation', 'cover_letter', 'previous_employee'].includes(c)) ||
    /\b(referr\w*|references?|previous(ly)? appl\w*)\b|\b(applied|application)\b.*\b(before|previous|us|our|company)\b|why us|work here|join us/i.test(normalizeText(question));
}

export function effectiveScope(entry: Pick<AnswerEntry, 'scope' | 'questions'>): AnswerScope {
  if (entry.scope?.type === 'company' && companyKey(entry.scope.company)) return entry.scope;
  if (entry.scope?.type === 'unassigned' || entry.questions.some(companyDependent)) return { type: 'unassigned' };
  return { type: 'global' };
}

export function scopeFor(question: string, page?: Pick<PageInfo, 'company'>): AnswerScope {
  if (!companyDependent(question)) return { type: 'global' };
  return page?.company.trim() ? { type: 'company', company: page.company.trim() } : { type: 'unassigned' };
}

export function scopeAllows(entry: Pick<AnswerEntry, 'scope' | 'questions'>, page?: Pick<PageInfo, 'company'>): boolean {
  const s = effectiveScope(entry);
  return s.type === 'global' || (s.type === 'company' && !!page?.company && companyKey(s.company) === companyKey(page.company));
}

export function scopeKey(entry: Pick<AnswerEntry, 'scope' | 'questions'>): string {
  const s = effectiveScope(entry);
  return s.type === 'company' ? `company:${companyKey(s.company)}` : s.type;
}
