// Character / word limits: parsing hints from page text, measuring and trimming answers.

import type { CharLimit } from './schema';

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;
const UNIT = String.raw`(characters?|chars?|words?)`;

const PATTERNS: { re: RegExp; num: number; unit: number | null }[] = [
  // "max 500 characters", "up to 300 words", "no more than 1,000 characters"
  { re: new RegExp(String.raw`(?:max(?:imum)?\.?(?: of)?|up to|no more than|not exceed(?:ing)?|limit(?:ed)? (?:of|to)|within|less than|fewer than|under)\s*${NUM}\s*${UNIT}`, 'i'), num: 1, unit: 2 },
  // "500 characters max", "300 words or less", "250 word limit"
  { re: new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:max(?:imum)?|limit|or less|or fewer|maximum)`, 'i'), num: 1, unit: 2 },
  // "150-200 words"
  { re: new RegExp(String.raw`\d+\s*[-–]\s*${NUM}\s*${UNIT}`, 'i'), num: 1, unit: 2 },
  // Live counters: "0/500", "0 / 2000 characters"
  { re: new RegExp(String.raw`\b\d+\s*/\s*${NUM}\b(?:\s*${UNIT})?`, 'i'), num: 1, unit: 2 },
];

/** Find a limit stated in nearby text (descriptions, counters). */
export function parseLimitText(text: string): CharLimit | null {
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    const max = parseInt(m[p.num].replace(/,/g, ''), 10);
    if (!max) continue;
    const unitRaw = p.unit !== null ? m[p.unit] : undefined;
    return { max, unit: unitRaw && /^w/i.test(unitRaw) ? 'words' : 'chars' };
  }
  return null;
}

/** Combine the maxlength attribute with any limit stated in text. */
export function combineLimits(maxLength: number | null, fromText: CharLimit | null): CharLimit | null {
  const attr = maxLength && maxLength > 0 && maxLength < 1_000_000 ? { max: maxLength, unit: 'chars' as const } : null;
  if (!fromText) return attr;
  if (fromText.unit === 'words') return fromText;
  if (!attr) return fromText;
  return { max: Math.min(attr.max, fromText.max), unit: 'chars' };
}

export function measure(text: string, unit: CharLimit['unit']): number {
  if (unit === 'words') return text.trim() ? text.trim().split(/\s+/).length : 0;
  return text.length;
}

export function withinLimit(text: string, limit: CharLimit | null): boolean {
  return !limit || measure(text, limit.unit) <= limit.max;
}

/**
 * Cut back to the last full sentence that fits. Returns null if not even one sentence fits,
 * so the caller can ask for a manual edit instead of cutting mid-sentence.
 */
export function trimToLastSentence(text: string, limit: CharLimit): string | null {
  if (withinLimit(text, limit)) return text;
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) ?? [text];
  let out = '';
  for (const s of sentences) {
    const next = out + s;
    if (!withinLimit(next.trimEnd(), limit)) break;
    out = next;
  }
  out = out.trimEnd();
  return out ? out : null;
}
