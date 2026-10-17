# Review and verification

Reviewed on **17 October 2026**. Scope: local answer-bank matching, form detection and filling, extension storage boundaries, tests, documentation and reproducible demo assets.

The extension is intended to fill job application fields while leaving sensitive answers and submission under the user's control. Its existing company-scope guards, fresh content-side checks, structured multiple selections and serialized storage writes provide a useful foundation.

## Findings addressed

| Priority | Finding | Change and evidence |
| --- | --- | --- |
| Major | A single checkbox treated unrecognised prose as false, while answers beginning with “Yes” were accepted even when conditional. | An explicit boolean parser is shared by matching and filling. Unknown answers are excluded from bulk fill and refused without changing the checkbox. Regression tests cover “Maybe”, conditional yes and “No objection”. |
| Major | Sensitive information present only in descriptive help text was ignored by form scanning. Group descriptions were omitted entirely. | Detection includes field/group descriptions, and sensitivity classification uses both label and help text. Tests cover disability descriptions, sponsorship group help, and help text appearing after a panel scan. |
| Major | Any nonempty text remaining after a fill was considered success, even if the page restored a different old value. | Changed values now report failure. Telephone formatting is accepted only when the original digits are preserved. Regression tests cover restored text, equivalent formatting and different phone digits. |
| Hardening | The worker validated message senders, but local storage still used Chrome's default content-script access level. | Local storage is restricted to `TRUSTED_CONTEXTS` before bank operations are processed. A real isolated-world Chromium check verifies that direct reads and bank messages from content scripts are both denied. |
| Documentation / demo | The recorder depended on a live vacancy, and the README's “everything stays local” wording overstated privacy once a value is filled. | Recording now uses a bundled fictional fixture in an isolated browser with external HTTP(S) traffic blocked. README and options-page text explain that filled values are available to the destination website. Personal biography details were removed from the README. |
| Fixture hygiene | Saved public pages retained unrelated provider configuration and public client keys. | Embedded metadata now keeps only the job and question fields consumed by the adapter. Third-party runtime configuration and submission metadata are removed; recruitment contact addresses use example domains. These were public page configuration values, not user credentials. |

The storage restriction follows the [Chrome storage API's access-level mechanism](https://developer.chrome.com/docs/extensions/reference/api/storage#method-StorageArea-setAccessLevel). It limits extension content-script access; it does not encrypt browser files or exported backups.

## Verification results

Local runtime: Node.js 24.14.0 on Windows. CI is configured for Node.js 24 on Ubuntu; the hosted job has not been run as part of this review.

| Check | Result |
| --- | --- |
| Before fixes: focused regression cases | 8 failures reproduced; 2 explicit Yes/No cases already passed. |
| `npm test` | **142 tests passed across 11 test files.** |
| `npm run typecheck` | Passed. |
| `npm run build` | Passed; built Manifest V3 assets into `dist/`. |
| `npm run test:mv3` | Passed with real extension worker/options/panel, content-script storage restrictions, sender checks, write concurrency, graduation, multiple selections, company isolation, no submit and generic-site permission denial. |
| `npm run media` | Passed: five expected values filled, sponsorship remained empty until individual fill, no submit or network write attempt. Generated GIF, MP4, WebVTT captions and PNG screenshots. |
| `npm audit` | 0 reported vulnerabilities at review time. This is a dependency advisory check, not a security certification. |
| `git diff --check` | Passed. |

The [CI workflow](../.github/workflows/ci.yml) is configured to run type checking, unit/integration tests and the browser smoke test. Its hosted run is separate from these local results and has not been claimed as executed here.

## Remaining limits

- Native toolbar activation and accepting Chrome's permission prompt still need a manual release check; automated permission tests use API mocks.
- This review did not submit applications or run against current live employer forms. Saved fixtures and the offline demo cannot guarantee compatibility with every live Greenhouse page.
- Other platforms use generic detection; they do not yet have dedicated, verified adapters. Closed shadow roots and unusual custom controls may require manual completion.
- Sensitive classification is rule based. Review every application, including fields that are not flagged.
- Site input handlers can observe or autosave filled values. “Never submits” describes extension actions, not a guarantee that a destination site makes no network requests.
- AI drafting is not implemented. Existing context filters are preparation for that feature, not a claim that all personal information can be detected automatically.

**Assessment:** the reproduced issues above are fixed and covered by automated checks. The project remains a manually reviewed autofill assistant with the platform and release-check limitations listed here. No blocking author clarification remains for these local changes.
