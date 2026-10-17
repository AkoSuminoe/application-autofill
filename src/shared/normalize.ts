// Text normalisation shared by matching, option resolution and sensitive-question detection.

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b/g, 'cannot'],
  [/\bwon't\b/g, 'will not'],
  [/\b(\w+)n't\b/g, '$1 not'],
  [/\b(\w+)'re\b/g, '$1 are'],
  [/\b(\w+)'ve\b/g, '$1 have'],
  [/\b(\w+)'ll\b/g, '$1 will'],
  [/\b(\w+)'d\b/g, '$1 would'],
  [/\bi'm\b/g, 'i am'],
  [/\b(\w+)'s\b/g, '$1'],
];

// US -> UK. Applied after lowercasing so both spellings normalise to the same form.
const SPELLING: [RegExp, string][] = [
  [/\b(\w{2,})iz(e|ed|es|ing|ation|ations)\b/g, '$1is$2'],
  [/\b(\w{2,})yz(e|ed|es|ing)\b/g, '$1ys$2'],
  [/\b(lab|behavi|col|fav|hon|neighb|rum)or(s|ed|ing|ite|able)?\b/g, '$1our$2'],
  [/\b(cent|met|theat|fib)er(s)?\b/g, '$1re$2'],
  [/\bprogram\b/g, 'programme'],
  [/\benroll(ment)?\b/g, 'enrol$1'],
  [/\bjudgment\b/g, 'judgement'],
  [/\blicense\b/g, 'licence'],
  [/\bdefense\b/g, 'defence'],
  [/\boffense\b/g, 'offence'],
  [/\bzip ?code\b/g, 'postcode'],
  [/\bpost code\b/g, 'postcode'],
  [/\bcell ?phone\b/g, 'mobile'],
  [/\be-?mail\b/g, 'email'],
  [/\bresume\b/g, 'cv'],
];

/** Lowercase, expand contractions, unify spelling, strip punctuation/emoji, collapse spaces. */
export function normalizeText(input: string): string {
  let s = input.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[‘’ʼ`]/g, "'");
  for (const [re, rep] of CONTRACTIONS) s = s.replace(re, rep);
  s = s.replace(/[^a-z0-9'\s]/g, ' ').replace(/'/g, '');
  for (const [re, rep] of SPELLING) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set(
  `a an the and or but if then so of to in on at for from by with about into over as is are was were be been being
   am do does did done have has had having will would shall should can could may might must
   i me my mine you your yours we us our they them their he she it its this that these those there here
   what which who whom whose when where how why whether
   please kindly provide enter tell share let know describe give list state indicate confirm specify
   any some all each every other another such own same just also only very more most
   now currently current future ever still yet already time
   eg e g ie etc optional required question answer below above following`
    .split(/\s+/)
    .filter(Boolean),
);

// Applied after stemming; folds near-synonyms onto one token.
const TOKEN_SYNONYMS: Record<string, string> = {
  requir: 'need',
  requirement: 'need',
  need: 'need',
  sponsorship: 'sponsor',
  mobile: 'phone',
  telephone: 'phone',
  tel: 'phone',
  surname: 'lastname',
  forename: 'firstname',
  firstname: 'firstname',
  lastname: 'lastname',
  authoris: 'authoris',
  authorisation: 'authoris',
  eligible: 'authoris',
  eligibility: 'authoris',
  entitl: 'authoris',
  permit: 'authoris',
  permitt: 'authoris',
  legally: 'authoris',
  compensation: 'salary',
  remuneration: 'salary',
  pay: 'salary',
  wage: 'salary',
  organisation: 'company',
  firm: 'company',
  employer: 'company',
  uni: 'universit',
  university: 'universit',
  universiti: 'universit',
};

/** Light suffix stripping; enough to fold plurals and common verb forms. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const norm = normalizeText(text);
  const out: string[] = [];
  for (const raw of norm.split(' ')) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const st = stem(raw);
    out.push(TOKEN_SYNONYMS[st] ?? TOKEN_SYNONYMS[raw] ?? st);
  }
  return out;
}

// ---- Concepts ----
// Ordered by priority: when a question hits several, the earlier one is its primary concept.
// Patterns run against normalizeText() output (UK spelling, no punctuation).

export interface ConceptRule {
  id: string;
  re: RegExp;
}

export const CONCEPT_RULES: ConceptRule[] = [
  // Sensitive / knockout
  { id: 'sponsorship', re: /\bsponsor/ },
  { id: 'work_auth', re: /right to work|\b(eligible|eligibility|authoris\w*|entitled|permitted|allowed|legally able|able legally|legal right|permission) to (live and )?work|work (permit|authoris\w*|visa)|\bauthoris\w* .*\bwork\b/ },
  // US export-control status: unrelated to UK right to work, so kept separate.
  { id: 'us_person', re: /\bus person\b|\bu s person\b|export control/ },
  { id: 'visa_status', re: /\bvisa\b|immigration status|\bbrp\b|settled status|citizenship|nationality/ },
  { id: 'criminal', re: /criminal|\bconvict|\boffences?\b|\bdbs\b|disclosure and barring|\bcautions?\b|\bspent\b|\bunspent\b/ },
  { id: 'disability', re: /disab|neurodiver|neurodivergent|reasonable adjust|\badjustments?\b|health condition|impairment|long term condition/ },
  { id: 'gender', re: /\bgender|\bsex\b|transgender|\btrans\b/ },
  { id: 'ethnicity', re: /ethnic|\brace\b|racial|hispanic|latino|latinx/ },
  { id: 'orientation', re: /sexual orientation|sexuality|\blgb/ },
  { id: 'religion', re: /relig|\bbelief|\bfaith\b/ },
  { id: 'age', re: /\bage\b|date of birth|birth ?date|\bdob\b|how old/ },
  { id: 'marital', re: /marital|married|civil partner/ },
  { id: 'veteran', re: /veteran|armed forces|military service|protected veteran/ },
  { id: 'social_mobility', re: /type of school|school (did you|you) attend|free school meals|first (generation|in (your )?family)|parents? .*(universit|degree|occupation|job)|main (household )?earner|caring responsib|\bcarer\b|socio ?economic/ },
  { id: 'pronouns', re: /\bpronouns?\b/ },
  { id: 'experience_years', re: /years? of (relevant |professional |commercial |industry |work |hands on )?experience|how many years|how long have you (been|worked)|years experience/ },

  // Profile fields
  { id: 'preferred_name', re: /preferred (first )?name|known as|nickname|name you (go by|prefer)|chosen name/ },
  { id: 'first_name', re: /\bfirst name|given name|forename/ },
  { id: 'last_name', re: /\blast name|surname|family name/ },
  { id: 'full_name', re: /^(your )?(full |legal |complete )?name( in full)?$/ },
  { id: 'email', re: /\bemail\b/ },
  { id: 'phone', re: /\bphone|mobile|telephone|contact number/ },
  { id: 'linkedin', re: /linkedin|linked in/ },
  { id: 'github', re: /github|git hub|gitlab/ },
  { id: 'website', re: /website|portfolio|personal (site|url|page)|\bblog\b|other (url|link)/ },
  { id: 'postcode', re: /\bpostcode\b/ },
  { id: 'country', re: /^(your )?(current )?country( of residence)?$|country you (live|reside)|country of residence/ },
  { id: 'location', re: /\bcity\b|\blocation\b|where (are you|do you) (currently )?(based|live|located|reside)|current(ly)? (based|located|reside)|\btown\b|\baddress\b/ },
  { id: 'high_school', re: /high school|secondary school|sixth form|\ba levels?\b|college before universit/ },
  { id: 'university', re: /universit|\binstitution\b|alma mater|school (name|attended)|college/ },
  { id: 'degree', re: /\bdegree\b|qualification|\bmajor\b|field of study|course of study|\bdiscipline\b|subject (studied|of study)/ },
  { id: 'graduation', re: /graduat|completion date|expected (to )?(finish|complete)|year of study|finish (your )?(studies|degree)/ },
  { id: 'salary', re: /salary|compensation|pay (expectation|range)|remuneration|desired pay|expected pay|\bwage/ },
  { id: 'start_date', re: /start date|notice period|earliest (date|start|you could start)|available to start|availability to start|when (can|could) you start|joining date|date (you are )?available/ },
  { id: 'languages', re: /languages?( do you)? (speak|skills)|fluent in|which languages|language proficiency/ },
  { id: 'skills', re: /\bskills\b|technologies|tech stack|programming languages/ },

  // Common free-text / logistics
  { id: 'relocation', re: /relocat/ },
  { id: 'work_location', re: /\bhybrid\b|in the office|office (days|based)|\bon ?site\b|in person|commut|from where do you intend to work|where (do you intend|would you like) to work/ },
  { id: 'source', re: /how did you (hear|find|learn)|hear about|where did you (find|see|hear)|referr|referred by|\bsource\b/ },
  { id: 'previous_employee', re: /(worked|been employed) (for|at|by) .{0,40}before|previously (worked|been employed)|former employee/ },
  { id: 'cover_letter', re: /cover letter/ },
  { id: 'motivation', re: /why (do )?you want|why are you interested|why .{0,30}\b(join|work (for|at|with))\b|what (attracts|interests|excites) you|motivat/ },
  { id: 'consent', re: /privacy (notice|policy)|data protection|\bgdpr\b|\bconsent\b|terms and conditions/ },
];

export function conceptsOf(text: string): string[] {
  const norm = normalizeText(text);
  return CONCEPT_RULES.filter((r) => r.re.test(norm)).map((r) => r.id);
}

const NEGATION = /\b(without|not|no longer|never|unable|cannot)\b/;

export function isNegated(text: string): boolean {
  return NEGATION.test(normalizeText(text));
}

export function trigrams(text: string): Set<string> {
  const s = ` ${text} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}

export function dice<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
