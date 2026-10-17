import { afterEach, describe, expect, it } from 'vitest';
import { matchField, resolveMultiple } from '../src/shared/matcher';
import { buildContext, assertSendable } from '../src/llm/providers';
import { normalizeBank, parseImport, buildExport, mergeBanks } from '../src/shared/storage';
import { scopeAllows, companyKey } from '../src/shared/scope';
import { detectFields } from '../src/content/detect/generic';
import { fillField } from '../src/content/fill';
import { bankWith, entry, field } from './helpers';

describe('correct profile intent', () => {
  const bank = bankWith([], { university: 'Example University', degree: 'BSc', graduation: { month: 6, year: 2026 }, location: { city: 'London', country: 'UK', postcode: 'E1' } });
  it.each([
    ['What year did you graduate from university?', '2026'],
    ['What is your expected graduation date for your degree?', 'June 2026'],
    ['City', 'London'], ['Country', 'UK'], ['Location', 'London, UK'],
  ])('%s requests the correct fact', (q, answer) => expect(matchField(field(q), bank)[0].answer).toBe(answer));
  it('does not invent street addresses or graduation days', () => {
    expect(matchField(field('Street address'), bank)).toEqual([]);
    expect(matchField(field('Address'), bank)).toEqual([]);
    expect(matchField(field('Graduation date', { inputType: 'date' }), bank)).toEqual([]);
    expect(matchField(field('Graduation date', { inputType: 'month' }), bank)[0].answer).toBe('2026-06');
  });
  it('reads autocomplete tokens and blocks conflicting concepts independently of score', () => {
    expect(matchField(field('Whatever', { autocomplete: 'section-profile shipping address-level2' }), bank)[0].answer).toBe('London');
    expect(matchField(field('University and degree'), bank)[0].reviewRequired).toBe(true);
  });
});

describe('company boundary', () => {
  it('blocks both paraphrases and exact wording at another company', () => {
    for (const q of ['Have you previously worked at Acme?', 'Why do you want to work here?', 'Who referred you?', 'Have you applied to us before?']) {
      const b = bankWith([entry([q], 'Company-specific', { scope: { type: 'company', company: 'Acme' } })]);
      expect(matchField(field(q), b, 3, { company: 'Beta' })[0].scopeWarning).toBe(true);
      expect(matchField(field(q), b, 3, { company: 'Acme' })[0].scopeWarning).toBe(false);
      expect(matchField(field(q), b)[0].scopeWarning).toBe(true);
    }
    const b = bankWith([entry(['Have you previously worked at Acme?'], 'Yes')]);
    expect(matchField(field('Have you previously worked at Beta?'), b, 3, { company: 'Beta' })[0].scopeWarning).toBe(true);
  });
  it('migrates unknown company answers, preserves unicode and does not merge across companies', () => {
    const b = normalizeBank({ schemaVersion: 1, answers: [entry(['Why us?'], 'Original', { companyOverrides: [{ company: 'Acme', answer: 'Override', updatedAt: 2 }] })] });
    expect(b.schemaVersion).toBe(2);
    expect(b.answers.map(a => a.scope?.type)).toEqual(['unassigned', 'company']);
    expect(scopeAllows(b.answers[0], { company: 'Acme' })).toBe(false);
    expect(companyKey('  Şirket  A ')).toBe('şirket a');
    expect(companyKey('Şirket')).not.toBe(companyKey('Sirket'));
    const beta = normalizeBank(bankWith([entry(['Why us?'], 'Beta', { scope: { type: 'company', company: 'Beta' } })]));
    expect(mergeBanks(b, beta).answers).toHaveLength(3);
    expect(parseImport(buildExport(b, null)).bank).toEqual(b);
  });
});

describe('multiple selections', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  it('retains a comma inside an option and rejects ambiguous legacy splits', () => {
    expect(resolveMultiple('London, United Kingdom', ['London, United Kingdom', 'Paris'])).toEqual(['London, United Kingdom']);
    expect(resolveMultiple('A, B, C', ['A', 'A, B', 'B, C', 'C'])).toBeNull();
    expect(resolveMultiple('', ['London, United Kingdom', 'Paris'], ['London, United Kingdom', 'Paris'])).toEqual(['London, United Kingdom', 'Paris']);
  });
  it.each(['checkboxes', 'select'])('fills both skills in %s through matching and filling', async kind => {
    document.body.innerHTML = kind === 'checkboxes'
      ? '<fieldset><legend>Skills</legend><label><input type="checkbox">Python</label><label><input type="checkbox">Java</label></fieldset>'
      : '<label for="s">Skills</label><select id="s" multiple><option>Python</option><option>Java</option></select>';
    const target = detectFields(document.body, { isVisible: () => true })[0];
    const pick = matchField(target.field, bankWith([entry(['Skills'], 'Python, Java')]))[0];
    expect(pick.values).toEqual(['Python', 'Java']);
    expect(await fillField(target, pick.answer, pick.values)).toEqual({ status: 'ok' });
    const selected = kind === 'checkboxes' ? document.querySelectorAll('input:checked') : document.querySelectorAll('option:checked');
    expect(selected).toHaveLength(2);
  });
  it('reports failure when the page rejects part of a selection', async () => {
    document.body.innerHTML = '<label for="s">Skills</label><select id="s" multiple><option>Python</option><option>Java</option></select>';
    const select = document.querySelector('select')!;
    select.addEventListener('change', () => { select.options[1].selected = false; });
    const target = detectFields(document.body, { isVisible: () => true })[0];
    expect((await fillField(target, 'Python, Java', ['Python', 'Java'])).status).toBe('failed');
  });
  function combo(ignoreJava = false, initial: string[] = []) {
    document.body.innerHTML = '<div class="select-shell"><div class="select__control"><input role="combobox" aria-label="Skills" aria-expanded="true" aria-controls="menu"></div><div role="listbox" id="menu"><div role="option">Python</div><div role="option">Java</div></div></div>';
    const add = (label: string) => {
      const chip = document.createElement('div'); chip.className = 'select__multi-value__label'; chip.textContent = label;
      document.querySelector('.select__control')!.append(chip);
    };
    initial.forEach(add);
    document.querySelectorAll<HTMLElement>('[role=option]').forEach(option => option.addEventListener('click', () => {
      if (!(ignoreJava && option.textContent === 'Java')) add(option.textContent!);
    }));
    const target = detectFields(document.body, { isVisible: () => true })[0];
    target.field.multiple = true;
    return target;
  }
  it('verifies the complete combobox selection and reports partial outcomes', async () => {
    expect((await fillField(combo(), 'Python, Java', ['Python', 'Java'])).status).toBe('ok');
    expect((await fillField(combo(true), 'Python, Java', ['Python', 'Java'])).status).toBe('failed');
  });
  it('refuses unsupported removal before adding other selections', async () => {
    const target = combo(false, ['Rust']);
    expect((await fillField(target, 'Python', ['Python'])).status).toBe('refused');
    expect(document.querySelectorAll('.select__multi-value__label')).toHaveLength(1);
  });
});

describe('strict import and defensive reads', () => {
  it.each([
    [{ profile: { location: null } }, 'profile.location'],
    [{ profile: { languages: [null] } }, 'profile.languages[0]'],
    [{ profile: { graduation: { month: 13 } } }, 'profile.graduation.month'],
    [{ answers: [], settings: { llm: { provider: 'unknown' } } }, 'settings.llm.provider'],
    [{ answers: [], settings: { matching: { highConfidence: -.1 } } }, 'settings.matching.highConfidence'],
    [{ answers: [], settings: { matching: { highConfidence: .6, minShow: .8 } } }, 'settings.matching.minShow'],
    [{ bank: { answers: [] }, secrets: { apiKeys: { openai: 1 } } }, 'secrets.apiKeys.openai'],
  ])('rejects invalid values with their path', (raw, path) => expect(() => parseImport(JSON.stringify(raw))).toThrow(path));
  it('reads broken legacy storage without crashing the matcher', () => {
    const b = normalizeBank({ profile: { location: null, languages: [null] } });
    expect(b.profile.location.city).toBe('');
    expect(b.profile.languages).toEqual([]);
    expect(() => matchField(field('City'), b)).not.toThrow();
  });
});

describe('privacy at the context boundary', () => {
  it('derives sensitivity from every wording and removes contact data and other companies', () => {
    const b = bankWith([
      entry(['Gender'], 'Woman'), entry(['An innocent first wording', 'Disability'], 'Yes'),
      entry(['Project'], 'Email me at someone@example.org'), entry(['Contact number'], '0123456789'),
      entry(['Why us?'], 'Beta answer', { scope: { type: 'company', company: 'Beta' } }),
      entry(['Project details'], 'Built a compiler'),
    ], { email: 'user@example.org', website: 'https://private.example', phone: '+44 7000 123456', location: { city: '', country: '', postcode: 'AB1 2CD' } });
    const ctx = buildContext(b, { company: 'Acme' });
    expect(ctx.previousAnswers).toEqual([{ question: 'Project details', answer: 'Built a compiler' }]);
    expect(JSON.stringify(ctx)).not.toContain('private.example');
    expect(() => assertSendable(field('Gender'))).toThrow();
    expect(() => assertSendable(field('Anything', { section: 'eeoc' }))).toThrow();
  });
});
