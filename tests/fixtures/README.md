# Form fixtures

- `greenhouse-figma.html` and `greenhouse-monzo.html` are saved public job-form snapshots for detection regressions. They are not current vacancies or user applications. Embedded Remix data retains only the job title, company, description and question definitions used by the adapter. Runtime environment configuration, provider keys, telemetry settings and submission routing metadata are removed. Recruitment contact addresses are replaced with `example.com` addresses.
- `demo-application.html` is an authored fictional vacancy used by the media recorder. It contains no personal applicant details. The recorder imports a fictional profile into a fresh browser and fulfills the form URL locally, with other external HTTP(S) requests blocked.

When adding fixtures, remove applicant values, credentials, session identifiers, runtime configuration and unrelated scripts. Keep only the markup and question metadata needed for the regression. Do not capture a personal browser session or use an answer-bank export as a fixture.
