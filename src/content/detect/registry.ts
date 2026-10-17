// Picks the ATS adapter for the current page. Each new platform adds one adapter here.

import { effectiveSensitive } from '../../shared/sensitive';
import type { PageInfo } from '../../shared/schema';
import { detectFields, textOf, type DetectOptions, type RawField } from './generic';
import { greenhouse } from './greenhouse';

export interface AtsAdapter {
  id: string;
  name: string;
  matches(doc: Document, loc: Location): boolean;
  /** Optional one-off async setup (e.g. fetching data the page no longer exposes). Resolves true if a rescan is worthwhile. */
  preload?(doc: Document, loc: Location): Promise<boolean>;
  /** Restrict scanning to the application form when it can be found. */
  root?(doc: Document): ParentNode | null;
  /** Fix up questions, options and sections using platform knowledge. */
  enhance?(fields: RawField[], doc: Document): void;
  pageInfo?(doc: Document): Partial<PageInfo>;
  jobDescription?(doc: Document): string;
}

const genericAdapter: AtsAdapter = { id: 'generic', name: 'Generic form', matches: () => true };

const ADAPTERS: AtsAdapter[] = [greenhouse];

export function pickAdapter(doc: Document, loc: Location): AtsAdapter {
  return ADAPTERS.find((a) => a.matches(doc, loc)) ?? genericAdapter;
}

export function scanPage(doc: Document, loc: Location, opts: DetectOptions): { adapter: AtsAdapter; raw: RawField[]; page: PageInfo } {
  const adapter = pickAdapter(doc, loc);
  const root = adapter.root?.(doc) ?? doc.body ?? doc;
  const raw = detectFields(root, opts);
  adapter.enhance?.(raw, doc);
  for (const r of raw) r.field.sensitive = effectiveSensitive([r.field.question, r.field.description ?? ''], r.field.sensitive, r.field.section);
  const page: PageInfo = {
    url: loc.href,
    ats: adapter.name,
    company: '',
    jobTitle: doc.title,
    ...adapter.pageInfo?.(doc),
  };
  return { adapter, raw, page };
}

/** Job description text for LLM drafting; falls back to the biggest text block on the page. */
export function jobDescription(doc: Document, adapter: AtsAdapter): string {
  const fromAdapter = adapter.jobDescription?.(doc);
  if (fromAdapter) return fromAdapter;
  const candidates = Array.from(doc.querySelectorAll('[class*="description"], [id*="description"], main, article'));
  const best = candidates.map(textOf).sort((a, b) => b.length - a.length)[0] ?? '';
  return best.slice(0, 15000);
}
