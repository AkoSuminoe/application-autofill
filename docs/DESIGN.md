# Design notes

Detailed behaviour of Application Autofill. For an overview, see the [README](../README.md).

## Side panel

- Each detected question is a card showing:
  - the matched answer and its confidence score
  - badges for required fields, character limits and sensitive questions
- **Fill** writes one answer into the page. **Copy** puts it on the clipboard. **Edit & save** stores it in the answer bank.
- **Fill all high-confidence** only fills fields that meet all of these:
  - at or above the threshold (85% by default)
  - not flagged ⚠
  - not already filled
  - within the field's character limit
  - no ambiguous intent, competing answer or company-scope warning
- A new wording is learned only after a successful, unambiguous fill within the answer's scope. Opposite-polarity, trimmed and other-company suggestions are never learned.
- Clicking a question scrolls the page to that field.

Scores are matching heuristics, not probabilities.
- Graduation year/month, university, degree, city and country are treated as separate fields.
- No street address or graduation day is invented from incomplete profile data.
- Bulk filling stops if the page navigates or the tab changes.
- The page rechecks each field before writing, so values you've just typed are kept.

## Company answers and multiple selections

- Every answer has a scope: `global`, `company` or `unassigned`, editable in the answer bank. Company names are compared exactly after Unicode, case and whitespace normalisation. Similar-looking names are never treated as the same company.
- Some answers are only used automatically when they're scoped to the current company:
  - motivation and cover letters
  - previous employment and previous applications
  - references

  This holds even when the question wording is identical at another company. If the page's company is unknown, these need to be reviewed and filled by hand.
- Existing company-dependent answers with no known company stay saved as `unassigned`. Assign a company in the answer bank to enable automatic reuse. Suggestions from another company carry a clear warning and are excluded from Fill all.
- For multiple-choice fields, each option is selected separately in the panel. The answer bank stores one complete option per line. Commas inside an option label are kept. Old comma-separated answers that can be read more than one way need editing.
- Selections are verified in full for:
  - checkboxes
  - native multiple selects
  - supported comboboxes

  If an existing combobox selection can't be removed safely, clear it on the page first. A partial result is reported as a failure.

## Sensitive questions

These topics are flagged ⚠ and never included in Fill all:
- right to work, sponsorship, visa status, US-person status
- criminal record
- disability
- demographics, including UK social-mobility questions
- years of experience

Anything in an EEOC or diversity-survey section counts as demographic, whatever its wording.

The AI context builder decides what can be sent to a model:
- **Sensitivity check:** it uses every saved wording of a question, plus its stored sensitivity label. Detected demographic and disability answers are excluded even when the label is missing.
- **Also excluded:**
  - contact questions
  - email and phone patterns
  - known profile contact values
  - answers outside the current company scope
- **Profile fields:** only an explicit education/skills allowlist is used.

These are rule-based safeguards, not a general detector for every possible personal detail. AI calls are currently disabled.

## Site access

- **Greenhouse** (`job-boards.greenhouse.io` and embeds; old `boards.greenhouse.io` links redirect there) works automatically.
- **Any other https site** uses generic detection once you allow that site:
  1. Click the toolbar icon or press **Alt+Shift+F**.
  2. Click **Enable on this site**.

  This uses temporary `activeTab` access to identify the site, then requests a host permission for that one site.

There is no broad `tabs` permission, so switching tabs with the panel already open may require invoking the extension again. The panel reports these cases without filling the wrong page:
- denied permission
- unsupported URLs
- navigation during the permission prompt

## Saving, backups and schema v2

- **Single writer:** all writes go through one service-worker queue.
- **Field-level saves:** profile and settings saves change only the edited fields, so an older options window can't erase answers added from the panel.
- **Conflicts:** conflicting edits or deletions produce an error and keep your draft. Unrelated edits can merge.

**Migration from v1:**
- Existing v1 data is backed up under the local `bankBackupV1` key first. If that backup can't be saved, migration stops.
- Company overrides become separate company-scoped answers.
- Existing answer text is kept alongside structured multiple-selection values.
- The backup is local recovery data and isn't included in normal JSON exports.

**JSON import:**
- Validates nested objects, arrays, enum values, timestamps, graduation dates, API keys and matching thresholds.
- Missing fields get defaults. Invalid values are rejected, with their field path, before anything is written.
- A replacement import refuses to overwrite a bank that changed while the import was being prepared.
- Merging never combines identical questions from different company scopes.

## Testing

The unit and regression suite covers:
- worker write races
- the real options and panel modules, run with Chrome API mocks
- scope-aware matching
- malformed imports
- multiple-selection verification
- privacy filtering
- content-side freshness checks

`npm run test:mv3` loads `dist/` in an isolated headless Chromium profile and uses intercepted fixture pages. It never submits a real application. It runs the real worker, options page and panel, and checks:
- profile/answer concurrency
- graduation filling
- multiple selections
- company isolation
- missing site permission

Native toolbar activation and accepting the browser permission prompt are covered by mocked API tests. Verify those two by hand before packaging a release.

`npm run media` regenerates the README demo against a live Greenhouse job, using a fictional profile. It only fills fields.

## Lessons from live Greenhouse pages

- Greenhouse wraps react-select so that the menu opens on **mouseup** or **keyup**, not on mousedown or input. The filler sends both.
- Remix removes the `__remixContext` script during hydration. The Greenhouse adapter caches it when it's still present, and otherwise re-fetches the page HTML once to read the question options.
- The phone widget keeps a hidden list of `role="option"` countries in the DOM at all times. Option lookup is therefore scoped to each combobox's own listbox.
- Some comboboxes display a short form of the chosen option ("+44" for "United Kingdom +44"). Verification accepts that only when the shown text is a whole-word part of the option that was clicked.
- Location autocompletes return many cities with the same name, so city comboboxes are searched with "City, Country".

## Adding an ATS

1. Save an application page into `tests/fixtures/`.
2. Write `src/content/detect/<ats>.ts`, implementing `AtsAdapter`. An adapter can fix up questions, options and sections, and supply page info and the job description.
3. Register it in `src/content/detect/registry.ts`.
4. Add its hosts to `static/manifest.json`.
5. Add `tests/detect.<ats>.test.ts`.
