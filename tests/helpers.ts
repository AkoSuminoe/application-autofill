import type { AnswerEntry, Bank, DetectedField } from '../src/shared/schema';
import { emptyBank } from '../src/shared/schema';

export function field(question: string, extra: Partial<DetectedField> = {}): DetectedField {
  return {
    id: 'f1',
    question,
    kind: 'text',
    required: false,
    options: [],
    multiple: false,
    limit: null,
    currentValue: '',
    sensitive: null,
    ...extra,
  };
}

export function entry(questions: string[], answer: string, extra: Partial<AnswerEntry> = {}): AnswerEntry {
  return {
    id: 'e_' + questions[0].slice(0, 10),
    questions,
    answer,
    kind: 'text',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    timesUsed: 0,
    lastUsedAt: null,
    ...extra,
  };
}

export function bankWith(answers: AnswerEntry[], profile: Partial<Bank['profile']> = {}): Bank {
  const b = emptyBank();
  b.answers = answers;
  b.profile = { ...b.profile, ...profile };
  return b;
}
