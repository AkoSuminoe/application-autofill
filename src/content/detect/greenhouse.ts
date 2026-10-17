// Greenhouse (job-boards.greenhouse.io, including embeds). Classic boards.greenhouse.io URLs now redirect here.
// The page embeds its question definitions in window.__remixContext, which gives us
// dropdown options without having to open every react-select menu.

import type { PageInfo } from '../../shared/schema';
import { textOf, type RawField } from './generic';
import type { AtsAdapter } from './registry';

interface GhField {
  name: string;
  type: string;
  values?: { label: string }[];
}
interface GhQuestion {
  label?: string;
  required?: boolean;
  fields?: GhField[];
}
interface GhDemographicQuestion {
  id: number;
  name: string;
  answer_type?: { key?: string };
  answer_options?: { name: string }[];
}
interface GhJobPost {
  title?: string;
  company_name?: string;
  content?: string;
  questions?: GhQuestion[];
  eeoc_sections?: { questions?: GhQuestion[] }[];
  demographic_questions?: { questions?: GhDemographicQuestion[] };
}

interface FieldMeta {
  options: string[];
  multiple: boolean;
}

// Remix removes the context script while hydrating, so on a live page it's usually gone by the time
// we scan. preload() re-fetches the page HTML once and caches the parsed job post here.
let fetchedPost: GhJobPost | null = null;
let preloadUrl = '';
let fetchedUrl = '';

/** Pull the job post object out of the Remix context script (or the re-fetched copy). */
export function readJobPost(doc: Document): GhJobPost | null {
  const script = Array.from(doc.querySelectorAll('script')).find((s) => s.textContent?.includes('window.__remixContext'));
  return script?.textContent ? parseRemixContext(script.textContent) : fetchedUrl === doc.URL ? fetchedPost : null;
}

export function parseRemixContext(text: string): GhJobPost | null {
  const at = text.indexOf('window.__remixContext');
  if (at < 0) return null;
  const start = text.indexOf('{', at);
  const close = text.indexOf('</script>', start);
  const end = text.lastIndexOf('}', close < 0 ? undefined : close);
  if (start < 0 || end < start) return null;
  let ctx: unknown;
  try {
    ctx = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  // Find the first object with a `questions` array, wherever the route key puts it.
  const stack: unknown[] = [ctx];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    const o = cur as Record<string, unknown>;
    if (Array.isArray(o.questions) && ('title' in o || 'company_name' in o)) return o as GhJobPost;
    for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}

function fieldMeta(post: GhJobPost): Map<string, FieldMeta> {
  const map = new Map<string, FieldMeta>();
  const addQuestions = (qs: GhQuestion[] | undefined) => {
    for (const q of qs ?? []) {
      for (const f of q.fields ?? []) {
        if (!f.values?.length) continue;
        map.set(f.name, { options: f.values.map((v) => v.label), multiple: /multi_select/.test(f.type) });
      }
    }
  };
  addQuestions(post.questions);
  for (const s of post.eeoc_sections ?? []) addQuestions(s.questions);
  for (const q of post.demographic_questions?.questions ?? []) {
    map.set(String(q.id), {
      options: (q.answer_options ?? []).map((o) => o.name),
      multiple: q.answer_type?.key === 'MULTI_SELECT',
    });
  }
  return map;
}

function stripHtml(html: string, doc: Document): string {
  const div = doc.createElement('div');
  div.innerHTML = html;
  return textOf(div);
}

export const greenhouse: AtsAdapter = {
  id: 'greenhouse',
  name: 'Greenhouse',

  matches(doc, loc) {
    return /(^|\.)greenhouse\.io$/.test(loc.hostname) || !!doc.querySelector('#application-form .application--questions');
  },

  root(doc) {
    return doc.querySelector('#application-form');
  },

  async preload(doc, loc) {
    const url = loc.href;
    if (preloadUrl === url) return false;
    preloadUrl = url;
    fetchedPost = null;
    fetchedUrl = url;
    // If the script is still here, keep a copy: hydration may remove it moments later.
    const now = readJobPost(doc);
    if (now) {
      fetchedPost = now;
      return false;
    }
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      const post = parseRemixContext(await res.text());
      if (preloadUrl !== url) return false;
      fetchedPost = post;
    } catch {
      if (preloadUrl === url) fetchedPost = null;
    }
    return !!fetchedPost;
  },

  enhance(fields: RawField[], doc) {
    const post = readJobPost(doc);
    const meta = post ? fieldMeta(post) : new Map<string, FieldMeta>();
    for (const r of fields) {
      const f = r.field;
      const m = meta.get(r.el.id);
      if (m) {
        if (f.options.length === 0) f.options = m.options;
        f.multiple = m.multiple;
      }
      if (f.kind === 'combobox' && r.el.closest('.select')?.querySelector('[class*="value-container--is-multi"]')) f.multiple = true;

      // Help text sits in "<id>-description", which comboboxes don't reference via aria-describedby.
      if (!f.description) {
        const d = textOf(doc.getElementById(`${r.el.id}-description`));
        if (d) f.description = d;
      }

      if (r.el.closest('.eeoc__container')) f.section = 'eeoc';
      else if (r.el.closest('#demographic-section, .demographic--container')) f.section = 'demographic';

      // File inputs are labelled "Attach"; the real question is the upload group's label.
      if (f.kind === 'file') {
        const group = r.el.closest('[role="group"]');
        const label = group ? textOf(doc.getElementById(group.getAttribute('aria-labelledby') ?? '')) : '';
        if (label) f.question = label.replace(/\*/g, '').trim();
      }
    }
  },

  pageInfo(doc): Partial<PageInfo> {
    const post = readJobPost(doc);
    return {
      company: post?.company_name ?? '',
      jobTitle: post?.title ?? textOf(doc.querySelector('.job__title h1, h1')) ?? doc.title,
    };
  },

  jobDescription(doc) {
    const dom = textOf(doc.querySelector('.job__description'));
    if (dom) return dom;
    const post = readJobPost(doc);
    return post?.content ? stripHtml(post.content, doc) : '';
  },
};
