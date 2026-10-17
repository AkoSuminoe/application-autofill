// Isolated Chromium profile; all application pages are local fixtures intercepted below.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';

const extensionPath = path.resolve('dist');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
context.setDefaultTimeout(10000);
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.getByRole('button', { name: 'Save profile', exact: true }).waitFor();
  await options.getByRole('link', { name: 'Profile', exact: true }).click();
  await options.getByLabel('First name', { exact: true }).fill('Ada');
  await options.getByLabel('University', { exact: true }).fill('Example University');
  await options.getByLabel('Graduation year', { exact: true }).fill('2026');
  await options.getByRole('button', { name: 'Save profile', exact: true }).click();
  await options.getByText('Profile saved', { exact: true }).waitFor();

  const html = `<!doctype html><html><head><title>Test application</title></head><body>
    <script>window.__remixContext = {loaderData:{job:{title:'Engineer',company_name:'Acme',questions:[]}}};</script>
    <form id="application-form" onsubmit="event.preventDefault();document.body.dataset.submitted='yes'">
      <label for="first">First name</label><input id="first">
      <label for="grad">What year did you graduate from university?</label><input id="grad">
      <fieldset><legend>Skills</legend><label><input type="checkbox" value="python">Python</label><label><input type="checkbox" value="java">Java</label></fieldset>
      <label for="why">Why do you want to work here?</label><textarea id="why"></textarea>
      <button type="submit">Submit application</button>
    </form></body></html>`;
  await context.route('https://job-boards.greenhouse.io/review/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.route('https://generic-autofill.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  const form = await context.newPage();
  await form.goto('https://job-boards.greenhouse.io/review/jobs/1');
  await form.locator('#first[data-aa-id]').waitFor();
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://job-boards.greenhouse.io/review/*' }))[0].id);
  // Verify the real Chrome boundary, not a mock: content scripts cannot read the bank
  // or bypass the sender allowlist via the worker message endpoint.
  const [access] = await worker.evaluate(async tabId => chrome.scripting.executeScript({
    target: { tabId }, world: 'ISOLATED', func: async () => {
      let storageDenied = false;
      try { await chrome.storage.local.get('bank'); } catch { storageDenied = true; }
      const response = await chrome.runtime.sendMessage({ type: 'bankMutation', operation: { kind: 'readBank' } });
      return { storageDenied, messageDenied: response?.ok === false };
    },
  }), tabId);
  assert.deepEqual(access.result, { storageDenied: true, messageDenied: true });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tabId=${tabId}`);
  await panel.locator('.card').first().waitFor();

  // Keep an older profile draft open while adding a real answer through the panel.
  await options.getByLabel('First name', { exact: true }).fill('Ada Draft');
  const skills = panel.locator('.card').filter({ has: panel.getByRole('button', { name: 'Skills', exact: true }) });
  await skills.getByRole('button', { name: 'Write answer', exact: true }).click();
  await skills.getByLabel('Python', { exact: true }).check();
  await skills.getByLabel('Java', { exact: true }).check();
  await skills.getByRole('button', { name: 'Save', exact: true }).click();
  await skills.getByRole('button', { name: 'Fill', exact: true }).waitFor();
  await options.getByRole('button', { name: 'Save profile', exact: true }).click();
  const stored = await options.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'bankMutation', operation: { kind: 'readBank' } })).data.bank);
  assert.equal(stored.profile.firstName, 'Ada Draft');
  assert.equal(stored.answers.length, 1);
  assert.deepEqual(stored.answers[0].values, ['Python', 'Java']);

  // A different company's exact-wording answer must not enter the bulk queue.
  await options.evaluate(async () => {
    const now = Date.now();
    const result = await chrome.runtime.sendMessage({ type: 'bankMutation', operation: { kind: 'addAnswer', entry: {
      id: 'beta-motivation', questions: ['Why do you want to work here?'], answer: 'Beta only', kind: 'text', tags: [],
      scope: { type: 'company', company: 'Beta' }, createdAt: now, updatedAt: now, timesUsed: 0, lastUsedAt: null,
    } } });
    if (!result.ok) throw new Error(result.error);
  });
  await panel.getByText(/Company not verified/).waitFor();
  await panel.getByRole('button', { name: /^Fill all high-confidence/ }).click();
  await panel.getByText(/Filled 3 of 3 fields/).waitFor();
  assert.equal(await form.locator('#first').inputValue(), 'Ada Draft');
  assert.equal(await form.locator('#grad').inputValue(), '2026');
  assert.equal(await form.locator('input[type=checkbox]:checked').count(), 2);
  assert.equal(await form.locator('#why').inputValue(), '');
  assert.equal(await form.locator('body').getAttribute('data-submitted'), null);

  // A real generic tab has no host permission or URL access before an extension gesture.
  const generic = await context.newPage();
  await generic.goto('https://generic-autofill.test/application');
  await generic.bringToFront();
  const genericId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const genericPanel = await context.newPage();
  await genericPanel.goto(`chrome-extension://${id}/sidepanel.html?tabId=${genericId}`);
  await genericPanel.getByRole('button', { name: 'Enable on this site', exact: true }).click();
  await genericPanel.getByText(/Click the extension icon or press/).waitFor();
  assert.equal(await worker.evaluate(() => chrome.permissions.contains({ origins: ['https://generic-autofill.test/*'] })), false);
  assert.equal(await generic.locator('[data-aa-id]').count(), 0);

  assert.deepEqual(errors, []);
  console.log('MV3 PASS: real worker/options/panel; content-script storage denied; sender checks; profile + answer concurrency; graduation; two selections; company isolation; no submit; generic site denied before gesture.');
  console.log('Native toolbar/permission prompt acceptance is covered by API-mock tests, not this headless smoke.');
} finally {
  await context.close();
}
