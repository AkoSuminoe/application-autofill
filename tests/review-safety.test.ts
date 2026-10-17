import { afterEach, describe, expect, it } from 'vitest';
import { detectFields } from '../src/content/detect/generic';
import { scanPage } from '../src/content/detect/registry';
import { fillField } from '../src/content/fill';
import { matchField } from '../src/shared/matcher';
import { bankWith, entry, field } from './helpers';

afterEach(() => { document.body.innerHTML = ''; });

describe('review regressions', () => {
  it.each(['Maybe', 'Yes, but only with approval', 'No objection'])('keeps checkbox state for ambiguous answer: %s', async answer => {
    document.body.innerHTML = '<label><input type="checkbox" checked>Available to relocate?</label>';
    const [target] = detectFields(document, { isVisible: () => true });
    expect((await fillField(target, answer)).status).toBe('refused');
    expect((target.el as HTMLInputElement).checked).toBe(true);
  });

  it('flags an exact saved match that cannot be interpreted as a checkbox answer', () => {
    const q = 'Available to relocate?';
    const [match] = matchField(field(q, { kind: 'checkbox' }), bankWith([entry([q], 'Maybe')]));
    expect(match.optionMissing).toBe(true);
  });

  it.each(['Yes', 'No'])('still accepts an explicit checkbox answer: %s', async answer => {
    document.body.innerHTML = '<label><input type="checkbox">Available to relocate?</label>';
    const [target] = detectFields(document, { isVisible: () => true });
    expect((await fillField(target, answer)).status).toBe('ok');
    expect((target.el as HTMLInputElement).checked).toBe(answer === 'Yes');
  });

  it('uses descriptive text to flag a sensitive text question', () => {
    document.body.innerHTML = '<label for="details">Additional information</label><p id="help">Please describe your disability.</p><textarea id="details" aria-describedby="help"></textarea>';
    const { raw } = scanPage(document, location, { isVisible: () => true });
    expect(raw[0].field.sensitive).toBe('disability');
  });

  it('uses group descriptions to flag sensitive radio questions', () => {
    document.body.innerHTML = '<p id="help">Do you need visa sponsorship?</p><fieldset aria-describedby="help"><legend>Eligibility</legend><label><input type="radio" name="q">Yes</label><label><input type="radio" name="q">No</label></fieldset>';
    const { raw } = scanPage(document, location, { isVisible: () => true });
    expect(raw[0].field.sensitive).toBe('sponsorship');
  });

  it('reports failure when a page restores a different nonempty text value', async () => {
    document.body.innerHTML = '<label for="name">First name</label><input id="name" value="Previous">';
    const [target] = detectFields(document, { isVisible: () => true });
    target.el.addEventListener('change', () => { (target.el as HTMLInputElement).value = 'Previous'; });
    expect((await fillField(target, 'Demo')).status).toBe('failed');
  });

  it('accepts phone formatting only when the digits are preserved', async () => {
    document.body.innerHTML = '<label for="phone">Phone</label><input id="phone" type="tel">';
    const [target] = detectFields(document, { isVisible: () => true });
    target.el.addEventListener('change', () => { (target.el as HTMLInputElement).value = '07700900123'; });
    expect((await fillField(target, '07700 900123')).status).toBe('ok');
    expect((await fillField(target, '07700 900456')).status).toBe('failed');
  });
});
