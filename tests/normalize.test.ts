import { describe, expect, it } from 'vitest';
import { conceptsOf, isNegated, normalizeText, tokenize } from '../src/shared/normalize';

describe('normalizeText', () => {
  it('unifies US and UK spelling', () => {
    expect(normalizeText('Are you authorized to work?')).toBe(normalizeText('Are you authorised to work?'));
    expect(normalizeText('Organization')).toBe('organisation');
  });
  it('expands contractions and strips emoji/punctuation', () => {
    expect(normalizeText("🛂 I'd need Monzo's sponsorship!")).toBe('i would need monzo sponsorship');
    expect(normalizeText("Don't")).toBe('do not');
  });
});

describe('tokenize', () => {
  it('drops filler and folds synonyms', () => {
    expect(tokenize('Will you require visa sponsorship?')).toEqual(['need', 'visa', 'sponsor']);
    expect(tokenize('Do you now or in the future need sponsorship?')).toEqual(['need', 'sponsor']);
  });
});

describe('concepts', () => {
  it.each([
    ['Will you require visa sponsorship?', 'sponsorship'],
    ['Are you authorized to work in the country for which you applied?', 'work_auth'],
    ['Please confirm your Right to Work status', 'work_auth'],
    ['LinkedIn Profile', 'linkedin'],
    ['Preferred First Name', 'preferred_name'],
    ['First Name', 'first_name'],
    ['Location (City)', 'location'],
    ['What is your notice period?', 'start_date'],
    ['Expected salary', 'salary'],
    ['How many years of experience do you have with Python?', 'experience_years'],
    ['Do you have any unspent criminal convictions?', 'criminal'],
    ['How would you describe your gender identity?', 'gender'],
  ])('%s -> %s', (q, c) => {
    expect(conceptsOf(q)[0]).toBe(c);
  });
});

describe('isNegated', () => {
  it('spots "without"', () => {
    expect(isNegated('Can you work in the UK without sponsorship?')).toBe(true);
    expect(isNegated('Will you require sponsorship?')).toBe(false);
  });
});
