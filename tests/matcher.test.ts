import { describe, expect, it } from 'vitest';
import { matchField, prepare, questionSimilarity, resolveOption } from '../src/shared/matcher';
import { bankWith, entry, field } from './helpers';

const sim = (a: string, b: string) => questionSimilarity(prepare(a), prepare(b));

describe('questionSimilarity', () => {
  it.each([
    ['Will you require visa sponsorship?', 'Do you now or in the future need sponsorship?'],
    ['Will you now or in the future require sponsorship for employment visa status?', 'Do you require visa sponsorship to work in the UK?'],
    ['Are you legally authorised to work in the UK?', 'Do you have the right to work in the United Kingdom?'],
    ['What is your notice period?', 'When could you start?'],
    ['What are your salary expectations?', 'Expected salary (GBP)'],
    ['How did you hear about this role?', 'Where did you hear about us?'],
    ['Tell us about a project you are proud of', 'Describe a project you are proud of.'],
  ])('high: %s ~ %s', (a, b) => {
    expect(sim(a, b)).toBeGreaterThanOrEqual(0.85);
  });

  it.each([
    ['Will you require visa sponsorship?', 'Why do you want to join Figma?'],
    ['What are your salary expectations?', 'What is your expected start date?'],
    ['Tell us about a project you are proud of', 'Do you have any criminal convictions?'],
    ['LinkedIn Profile', 'GitHub profile'],
    ['🇺🇸 Are you a US Person?', 'Are you legally authorised to work in the UK?'],
  ])('low: %s vs %s', (a, b) => {
    expect(sim(a, b)).toBeLessThan(0.5);
  });

  it.each([
    ['Why do you want to join Figma?', 'Why do you want to work at Monzo?'],
    ['How many years of experience do you have with Python?', 'How many years of experience do you have with Java?'],
  ])('company/tech-specific questions stay below high confidence: %s vs %s', (a, b) => {
    expect(sim(a, b)).toBeLessThan(0.85);
  });

  it('exact wording after normalisation is 1', () => {
    expect(sim('Are you authorized to work?', 'are you authorised to work')).toBe(1);
  });
});

describe('matchField', () => {
  const sponsorship = entry(['Will you require visa sponsorship?'], 'No', { kind: 'boolean' });

  it('maps paraphrased sponsorship question to the saved answer', () => {
    const [top] = matchField(field('Do you now or in the future need sponsorship?'), bankWith([sponsorship]));
    expect(top.entryId).toBe(sponsorship.id);
    expect(top.score).toBeGreaterThanOrEqual(0.85);
    expect(top.polarityWarning).toBe(false);
  });

  it('caps and flags opposite-polarity wording', () => {
    const [top] = matchField(field('Can you work in the UK without sponsorship?'), bankWith([sponsorship]));
    expect(top.polarityWarning).toBe(true);
    expect(top.score).toBeLessThan(0.85);
  });

  it('resolves the answer to a select option', () => {
    const f = field('Do you require sponsorship?', { kind: 'combobox', options: ['Yes', 'No'] });
    const [top] = matchField(f, bankWith([entry(['Will you require visa sponsorship?'], 'No, I have settled status')]));
    expect(top.answer).toBe('No');
  });

  it('caps confidence when no option fits', () => {
    const f = field('Will you require visa sponsorship?', { kind: 'select', options: ['Option A', 'Option B'] });
    const [top] = matchField(f, bankWith([sponsorship]));
    expect(top.optionMissing).toBe(true);
    expect(top.score).toBeLessThanOrEqual(0.4);
  });

  it('uses profile fields', () => {
    const b = bankWith([], {
      firstName: 'Ada',
      lastName: 'Lovelace',
      linkedin: 'https://linkedin.com/in/ada',
      preferredName: 'Addie',
    });
    expect(matchField(field('First Name'), b)[0].answer).toBe('Ada');
    expect(matchField(field('Preferred First Name'), b)[0].answer).toBe('Addie');
    expect(matchField(field('LinkedIn Profile'), b)[0].answer).toBe('https://linkedin.com/in/ada');
    expect(matchField(field('Whatever', { autocomplete: 'family-name' }), b)[0].answer).toBe('Lovelace');
  });

  it('formats graduation by field shape', () => {
    const b = bankWith([], { graduation: { month: 6, year: 2026 } });
    expect(matchField(field('Expected graduation date'), b)[0].answer).toBe('June 2026');
    const yearSelect = field('Graduation year', { kind: 'select', options: ['2025', '2026', '2027'] });
    expect(matchField(yearSelect, b)[0].answer).toBe('2026');
  });

  it('inverts profile sponsorship for "without" wording and flags it', () => {
    const b = bankWith([], { needsSponsorship: 'no' });
    const [top] = matchField(field('Can you work in the UK without sponsorship?'), b);
    expect(top.answer).toBe('Yes');
    expect(top.polarityWarning).toBe(true);
  });
});

describe('city autocomplete', () => {
  const b = bankWith([], { location: { city: 'London', country: 'United Kingdom', postcode: '' } });
  it('adds the country for combobox city fields so same-named cities are told apart', () => {
    const [top] = matchField(field('Location (City)', { kind: 'combobox' }), b);
    expect(top.answer).toBe('London, United Kingdom');
    const opts = ['London, England, United Kingdom', 'East London, Eastern Cape, South Africa', 'London, Ontario, Canada'];
    expect(resolveOption(top.answer, opts)?.option).toBe(opts[0]);
  });
  it('keeps plain text city fields to the city alone', () => {
    expect(matchField(field('City'), b)[0].answer).toBe('London');
  });
});

describe('resolveOption', () => {
  it('matches yes/no phrasing', () => {
    expect(resolveOption('Yes', ['Yes, I am', 'No, I am not'])?.option).toBe('Yes, I am');
    expect(resolveOption('no', ['Yes', 'No'])?.option).toBe('No');
  });
  it('matches long option text', () => {
    const opts = ["I'm a citizen or have permanent residency", "I'd need Monzo to sponsor my visa to work in this location"];
    expect(resolveOption("I'm a citizen or have permanent residency", opts)?.option).toBe(opts[0]);
  });
  it('does not read statement options as Yes', () => {
    const opts = ["I'm a citizen or have permanent residency", "I'd need Monzo to sponsor my visa to work in this location"];
    expect(resolveOption('Yes', opts)).toBeNull();
  });
  it('returns null when nothing fits', () => {
    expect(resolveOption('Blue', ['Yes', 'No'])).toBeNull();
  });
});
