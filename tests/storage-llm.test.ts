import { describe, expect, it } from 'vitest';
import { assertSendable, buildContext } from '../src/llm/providers';
import { systemPrompt } from '../src/llm/prompt';
import { buildExport, mergeBanks, normalizeBank, parseImport } from '../src/shared/storage';
import { parseLimitText, trimToLastSentence } from '../src/shared/limits';
import { classifySensitive } from '../src/shared/sensitive';
import { bankWith, entry, field } from './helpers';

describe('storage helpers', () => {
  it('fills defaults and drops malformed entries', () => {
    const b = normalizeBank({ profile: { firstName: 'Ada', location: { city: 'London' } }, answers: [{ questions: [], answer: 'x' }, { questions: ['Q'], answer: 'A' }] });
    expect(b.profile.firstName).toBe('Ada');
    expect(b.profile.location).toEqual({ city: 'London', country: '', postcode: '' });
    expect(b.answers).toHaveLength(1);
    expect(b.settings.matching.highConfidence).toBe(0.85);
  });

  it('exports without secrets unless asked, and round-trips', () => {
    const b = bankWith([entry(['Q1'], 'A1')], { firstName: 'Ada' });
    const plain = buildExport(b, null);
    expect(plain).not.toContain('apiKeys');
    const withKeys = buildExport(b, { apiKeys: { anthropic: 'sk-test' } });
    const back = parseImport(withKeys);
    expect(back.bank.profile.firstName).toBe('Ada');
    expect(back.secrets?.apiKeys.anthropic).toBe('sk-test');
  });

  it('rejects junk and newer schemas', () => {
    expect(() => parseImport('not json')).toThrow(/valid JSON/);
    expect(() => parseImport('{"foo":1}')).toThrow(/No profile/);
    expect(() => parseImport('{"schemaVersion":99,"answers":[]}')).toThrow(/newer version/);
  });

  it('merges overlapping answers and keeps the newer text', () => {
    const cur = bankWith([entry(['Will you require sponsorship?'], 'No', { updatedAt: 1 })], { firstName: 'Ada', lastName: 'L' });
    const inc = bankWith([entry(['will you require sponsorship', 'Do you need a visa?'], 'No, settled status', { id: 'x', updatedAt: 2 }), entry(['New Q'], 'New A', { id: 'y' })], { firstName: '', lastName: 'Lovelace' });
    const m = mergeBanks(cur, inc);
    expect(m.profile).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(m.answers).toHaveLength(2);
    expect(m.answers[0].questions).toEqual(['Will you require sponsorship?', 'Do you need a visa?']);
    expect(m.answers[0].answer).toBe('No, settled status');
  });
});

describe('limits', () => {
  it.each([
    ['Please keep it to a maximum of 500 characters', { max: 500, unit: 'chars' }],
    ['300 words max', { max: 300, unit: 'words' }],
    ['0/2,000', { max: 2000, unit: 'chars' }],
    ['150-200 words', { max: 200, unit: 'words' }],
    ['Please share 3-4 sentences on why you want to join', null],
  ])('%s', (text, expected) => {
    expect(parseLimitText(text)).toEqual(expected);
  });

  it('trims to the last full sentence, or gives up', () => {
    expect(trimToLastSentence('One. Two. Three.', { max: 10, unit: 'chars' })).toBe('One. Two.');
    expect(trimToLastSentence('A very long single sentence', { max: 5, unit: 'chars' })).toBeNull();
  });
});

describe('sensitive', () => {
  it.each([
    ['Do you have any unspent criminal convictions?', 'criminal'],
    ['Did you receive free school meals?', 'demographic'],
    ['What type of school did you attend between 11 and 16?', 'demographic'],
    ['Do you require any reasonable adjustments?', 'disability'],
    ['How many years of commercial experience do you have?', 'experience_years'],
    ['Will you now or in the future require sponsorship?', 'sponsorship'],
    ['Why do you want to work here?', null],
  ])('%s -> %s', (q, cat) => {
    expect(classifySensitive(q)).toBe(cat);
  });
});

describe('LLM guardrails', () => {
  it('never includes demographic or disability answers in the context', () => {
    const b = bankWith(
      [
        entry(['Gender'], 'Woman', { sensitive: 'demographic' }),
        entry(['Disability'], 'No', { sensitive: 'disability' }),
        entry(['Why us?'], 'Because.', { scope: { type: 'company', company: 'Acme' } }),
      ],
      { email: 'a@b.c', phone: '07', location: { city: 'London', country: 'UK', postcode: 'E1' } },
    );
    const ctx = buildContext(b, { company: 'Acme' });
    expect(ctx.previousAnswers.map((a) => a.question)).toEqual(['Why us?']);
    const json = JSON.stringify(ctx);
    expect(json).not.toContain('a@b.c');
    expect(json).not.toContain('E1');
  });

  it('refuses to send demographic questions', () => {
    expect(() => assertSendable(field('Gender', { sensitive: 'demographic' }))).toThrow();
    expect(() => assertSendable(field('Why us?'))).not.toThrow();
  });

  it('system prompt carries the style rules', () => {
    const p = systemPrompt(500);
    expect(p).toMatch(/British English/);
    expect(p).toMatch(/I am passionate about/);
    expect(p).toMatch(/em dashes/);
    expect(p).toMatch(/NEEDS_INFO/);
    expect(p).toMatch(/500 characters/);
  });
});
