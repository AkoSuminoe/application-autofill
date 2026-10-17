import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectFields } from '../src/content/detect/generic';
import { fillField, safeClick, type FillTarget } from '../src/content/fill';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const state: Record<string, unknown> = {};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const k of Object.keys(state)) delete state[k];
});

/**
 * Tiny react-select lookalike: typing opens a menu of role=option items; clicking one sets the value.
 * `openOnUp` mimics Greenhouse's wrapper, which only opens the menu on mouseup/keyup.
 */
function Combo({ options, label, stateKey, openOnUp = false, display = (v: string) => v }: { options: string[]; label: string; stateKey: string; openOnUp?: boolean; display?: (v: string) => string }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  state[stateKey] = value;
  const shown = options.filter((o) => o.toLowerCase().includes(text.toLowerCase()));
  return (
    <div className="select-shell" onKeyUp={() => openOnUp && setOpen(true)} onMouseUp={() => openOnUp && setOpen(true)}>
      {/* A hidden, always-present list elsewhere in the widget tree must never be used. */}
      <ul hidden>
        <li role="option" className="iti__country">No</li>
      </ul>
      <div className="select__control">
        {value && <div className="select__single-value">{display(value)}</div>}
        <label id={`${stateKey}-label`}>{label}</label>
        <input
          role="combobox"
          aria-labelledby={`${stateKey}-label`}
          aria-expanded={open}
          aria-controls={open ? `${stateKey}-listbox` : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!openOnUp) setOpen(true);
          }}
        />
      </div>
      {open && (
        <div role="listbox" id={`${stateKey}-listbox`}>
          {shown.map((o) => (
            <div
              key={o}
              role="option"
              className="select__option"
              onClick={() => {
                setValue(o);
                setText('');
                setOpen(false);
              }}
            >
              {o}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Form() {
  const [name, setName] = useState('');
  const [why, setWhy] = useState('');
  const [grad, setGrad] = useState('');
  const [rtw, setRtw] = useState('');
  const [agree, setAgree] = useState(false);
  Object.assign(state, { name, why, grad, rtw, agree });
  return (
    <form onSubmit={(e) => { e.preventDefault(); state.submitted = true; }}>
      <label htmlFor="name">First name *</label>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="why">Why us?</label>
      <textarea id="why" maxLength={20} value={why} onChange={(e) => setWhy(e.target.value)} />
      <label htmlFor="grad">Graduation year</label>
      <select id="grad" value={grad} onChange={(e) => setGrad(e.target.value)}>
        <option value="">Select...</option>
        <option value="25">2025</option>
        <option value="26">2026</option>
      </select>
      <fieldset>
        <legend>Do you have the right to work in the UK?</legend>
        <label><input type="radio" name="rtw" value="y" checked={rtw === 'y'} onChange={() => setRtw('y')} /> Yes</label>
        <label><input type="radio" name="rtw" value="n" checked={rtw === 'n'} onChange={() => setRtw('n')} /> No</label>
      </fieldset>
      <label><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree to the privacy notice</label>
      <Combo options={['Yes', 'No']} label="Do you require sponsorship?" stateKey="combo" />
      <Combo options={['Yes', 'No']} label="Have you worked here before?" stateKey="ghCombo" openOnUp />
      <button type="submit">Submit application</button>
    </form>
  );
}

function targets(): Map<string, FillTarget> {
  const raw = detectFields(container, { isVisible: () => true });
  return new Map(raw.map((r) => [r.field.question, { el: r.el, controls: r.controls, field: r.field }]));
}

describe('fillField with React-controlled inputs', () => {
  it('updates React state for text, textarea, select, radio, checkbox and combobox', async () => {
    act(() => root.render(<Form />));
    const t = targets();
    expect([...t.keys()]).toEqual([
      'First name',
      'Why us?',
      'Graduation year',
      'Do you have the right to work in the UK?',
      'I agree to the privacy notice',
      'Do you require sponsorship?',
      'Have you worked here before?',
    ]);

    await act(async () => {
      expect((await fillField(t.get('First name')!, 'Ada')).status).toBe('ok');
      expect((await fillField(t.get('Why us?')!, 'Short answer.')).status).toBe('ok');
      expect((await fillField(t.get('Graduation year')!, '2026')).status).toBe('ok');
      expect((await fillField(t.get('Do you have the right to work in the UK?')!, 'Yes')).status).toBe('ok');
      expect((await fillField(t.get('I agree to the privacy notice')!, 'Yes')).status).toBe('ok');
      expect((await fillField(t.get('Do you require sponsorship?')!, 'No')).status).toBe('ok');
      expect((await fillField(t.get('Have you worked here before?')!, 'No')).status).toBe('ok');
    });

    expect(state).toMatchObject({ name: 'Ada', why: 'Short answer.', grad: '26', rtw: 'y', agree: true, combo: 'No', ghCombo: 'No' });
    expect(state.submitted).toBeUndefined();
  });

  it('refuses answers over the limit', async () => {
    act(() => root.render(<Form />));
    const r = await fillField(targets().get('Why us?')!, 'This is far longer than twenty characters.');
    expect(r.status).toBe('tooLong');
    expect(state.why).toBe('');
  });

  it('reports a missing option instead of guessing', async () => {
    act(() => root.render(<Form />));
    const r = await fillField(targets().get('Graduation year')!, '2031');
    expect(r.status).toBe('optionMissing');
  });
});

describe('comboboxes that show a short form of the selection', () => {
  it('accepts a whole-word part of the clicked option, like "+44"', async () => {
    act(() => root.render(<Combo options={['United Kingdom +44', 'United States +1']} label="Country" stateKey="country" display={(v) => v.split(' ').pop()!} />));
    const t = targets().get('Country')!;
    let status = '';
    await act(async () => { status = (await fillField(t, 'United Kingdom')).status; });
    expect(status).toBe('ok');
    expect(state.country).toBe('United Kingdom +44');
  });

  it('still rejects a display that does not belong to the clicked option', async () => {
    act(() => root.render(<Combo options={['United Kingdom +44']} label="Country" stateKey="country" display={() => 'United States'} />));
    const t = targets().get('Country')!;
    let status = '';
    await act(async () => { status = (await fillField(t, 'United Kingdom')).status; });
    expect(status).toBe('failed');
  });
});

describe('safeClick', () => {
  it('never clicks buttons, submit inputs or links', () => {
    const form = document.createElement('form');
    form.innerHTML = '<button type="submit">Go</button><input type="submit"><a href="#next">Next</a><div role="option"><button>x</button></div>';
    container.appendChild(form);
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', onSubmit);
    for (const el of Array.from(form.querySelectorAll<HTMLElement>('button, input, a'))) expect(safeClick(el)).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
