import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobDescription, scanPage } from '../src/content/detect/registry';
import { parseRemixContext, readJobPost } from '../src/content/detect/greenhouse';
import type { DetectedField } from '../src/shared/schema';

function load(name: string) {
  const html = readFileSync(resolve('tests/fixtures', name), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const loc = { hostname: 'job-boards.greenhouse.io', href: 'https://job-boards.greenhouse.io/x/jobs/1' } as Location;
  return { doc, ...scanPage(doc, loc, { isVisible: () => true }) };
}

const byQ = (fields: DetectedField[], q: string) => {
  const f = fields.find((x) => x.question === q);
  if (!f) throw new Error(`No field "${q}". Got: ${fields.map((x) => x.question).join(' | ')}`);
  return f;
};

describe('Greenhouse: Figma (US EEOC)', () => {
  const { raw, page, doc, adapter } = load('greenhouse-figma.html');
  const fields = raw.map((r) => r.field);

  it('picks the Greenhouse adapter and reads page info', () => {
    expect(adapter.id).toBe('greenhouse');
    expect(page.company).toBe('Figma');
    expect(page.jobTitle).toBe('Account Executive, Enterprise');
  });

  it('finds standard fields with clean labels', () => {
    const first = byQ(fields, 'First Name');
    expect(first).toMatchObject({ kind: 'text', required: true, autocomplete: 'given-name' });
    expect(first.limit).toEqual({ max: 255, unit: 'chars' });
    expect(byQ(fields, 'Email').required).toBe(true);
    expect(byQ(fields, 'Phone').kind).toBe('text');
    expect(byQ(fields, 'Location (City)').kind).toBe('combobox');
  });

  it('skips hidden required-mirror inputs and buttons', () => {
    expect(fields.every((f) => f.question !== '')).toBe(true);
    expect(fields.filter((f) => f.question === 'Location (City)')).toHaveLength(1);
  });

  it('lists the CV upload as a file field under its group label', () => {
    expect(byQ(fields, 'Resume/CV').kind).toBe('file');
  });

  it('reads custom questions, descriptions and combobox options from the Remix context', () => {
    const why = byQ(fields, 'Why do you want to join Figma?');
    expect(why).toMatchObject({ kind: 'textarea', required: true });
    expect(why.description).toContain('3-4 sentences');
    const auth = byQ(fields, 'Are you authorized to work in the country for which you applied?');
    expect(auth).toMatchObject({ kind: 'combobox', required: true, options: ['Yes', 'No'], sensitive: 'right_to_work' });
    expect(byQ(fields, 'Pronouns').options).toContain('they/them/theirs');
    expect(byQ(fields, 'Pronouns').sensitive).toBe('demographic');
  });

  it('flags the EEOC section as demographic', () => {
    const gender = byQ(fields, 'Gender');
    expect(gender).toMatchObject({ section: 'eeoc', sensitive: 'demographic' });
    expect(gender.options).toEqual(['Male', 'Female', 'Decline To Self Identify']);
    const eeoc = fields.filter((f) => f.section === 'eeoc');
    expect(eeoc.length).toBeGreaterThanOrEqual(3);
    expect(eeoc.every((f) => f.sensitive === 'demographic' || f.sensitive === 'disability')).toBe(true);
  });

  it('stamps stable ids', () => {
    const ids = new Set(fields.map((f) => f.id));
    expect(ids.size).toBe(fields.length);
    const again = scanPage(doc, { hostname: 'job-boards.greenhouse.io', href: '' } as Location, { isVisible: () => true });
    expect(again.raw.map((r) => r.field.id)).toEqual(fields.map((f) => f.id));
  });

  it('extracts the job description', () => {
    expect(jobDescription(doc, adapter)).toContain('Enterprise Account Executive');
  });
});

describe('Greenhouse: after hydration (context script removed)', () => {
  it('can recover the job post from re-fetched HTML', () => {
    const html = readFileSync(resolve('tests/fixtures', 'greenhouse-figma.html'), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script').forEach((s) => s.remove());
    expect(readJobPost(doc)).toBeNull();
    const post = parseRemixContext(html);
    expect(post?.company_name).toBe('Figma');
    expect(post?.questions?.length).toBeGreaterThan(5);
  });
});

describe('Greenhouse: Monzo (UK demographics, right to work)', () => {
  const { raw } = load('greenhouse-monzo.html');
  const fields = raw.map((r) => r.field);

  it('keeps emoji-prefixed questions and their long options', () => {
    const rtw = fields.find((f) => f.question.includes('Right to Work'));
    expect(rtw).toBeDefined();
    expect(rtw!.sensitive).toBe('right_to_work');
    expect(rtw!.options).toContain("I'd need Monzo to sponsor my visa to work in this location");
  });

  it('does not mistake "pronounced" for a pronouns question', () => {
    const f = fields.find((x) => x.question.includes('how it'));
    expect(f!.sensitive).toBeNull();
    expect(fields.find((x) => x.question.includes('preferred pronouns'))!.sensitive).toBe('demographic');
  });

  it('marks the identity survey as demographic, with multi-select options', () => {
    const gender = byQ(fields, 'How would you describe your gender identity?');
    expect(gender).toMatchObject({ section: 'demographic', sensitive: 'demographic', multiple: true });
    expect(gender.options).toContain('Prefer not to say');
    const disability = byQ(fields, 'Do you identify as having a disability?');
    expect(disability.sensitive).toBe('disability');
  });
});
