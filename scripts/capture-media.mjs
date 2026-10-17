// Capture the built extension against a bundled fictional form. All HTTP(S) traffic
// is intercepted: the fixture is fulfilled locally and every other request is blocked.
// Uses an isolated Chromium profile, never the user's browser or saved answer bank.
// npm run media (requires Playwright Chromium and ffmpeg on PATH).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.argv.length > 2) throw new Error('This recorder only uses the bundled offline fixture; URL arguments are not accepted.');
execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
const jobUrl = 'https://job-boards.greenhouse.io/autofill-demo/jobs/1';
const fixture = readFileSync('tests/fixtures/demo-application.html', 'utf8');
const out = path.resolve('docs/media');
const frames = mkdtempSync(path.join(tmpdir(), 'aa-frames-'));
mkdirSync(out, { recursive: true });

const demoBank = {
  app: 'application-autofill',
  bank: {
    schemaVersion: 2,
    profile: {
      firstName: 'Alex', lastName: 'Example', preferredName: 'Alex',
      email: 'alex@example.com', phone: '07700 900123',
      linkedin: '', github: '', website: 'https://portfolio.example',
      location: { city: 'London', country: 'United Kingdom', postcode: '' },
      university: 'Example University', degree: 'BSc Software Engineering',
      graduation: { month: 6, year: 2026 }, highSchool: '', visaStatus: '',
      needsSponsorship: 'no', salaryExpectation: '', startDate: '',
      languages: [{ name: 'English', level: 'native' }],
      skills: [{ name: 'TypeScript', level: 'advanced' }],
    },
    answers: [],
  },
};

let context;
try {
  const ext = path.resolve('dist');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, deviceScaleFactor: 1, colorScheme: 'light',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  context.setDefaultTimeout(15000);
  let blockedWrites = 0;
  await context.route(/^https?:\/\//, route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) blockedWrites++;
    if (request.url() === jobUrl && request.method() === 'GET') {
      return route.fulfill({ contentType: 'text/html', body: fixture });
    }
    return route.abort();
  });

  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const options = await context.newPage();
  await options.setViewportSize({ width: 1100, height: 1000 });
  await options.goto(`chrome-extension://${id}/options.html`);
  const imported = await options.evaluate(text => chrome.runtime.sendMessage({
    type: 'bankMutation', operation: { kind: 'import', text, mode: 'merge' },
  }), JSON.stringify(demoBank));
  assert.equal(imported?.ok, true, 'Fictional demo profile must import');
  await options.reload();
  await options.getByLabel('First name', { exact: true }).waitFor();
  assert.equal(await options.getByLabel('First name', { exact: true }).inputValue(), 'Alex');
  await options.screenshot({ path: path.join(out, 'options.png') });
  await options.close();

  const job = await context.newPage();
  await job.setViewportSize({ width: 900, height: 820 });
  await job.goto(jobUrl);
  await job.locator('#first[data-aa-id]').waitFor();
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0]?.id, jobUrl);
  assert.ok(Number.isInteger(tabId));
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 440, height: 820 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tabId=${tabId}`);
  await panel.getByRole('button', { name: 'Fill all high-confidence (5)', exact: true }).waitFor();
  await panel.screenshot({ path: path.join(out, 'panel.png'), fullPage: true });

  const list = [];
  const frame = async seconds => {
    const i = String(list.length).padStart(3, '0');
    await job.screenshot({ path: path.join(frames, `${i}-a.png`) });
    await panel.screenshot({ path: path.join(frames, `${i}-b.png`) });
    list.push({ i, seconds });
  };
  const caption = async (step, title, text) => job.evaluate(({ step, title, text }) => {
    document.querySelector('#demo-step').textContent = step;
    document.querySelector('#demo-title').textContent = title;
    document.querySelector('#demo-caption').textContent = text;
  }, { step, title, text });

  await frame(3);
  await panel.getByRole('button', { name: 'Fill all high-confidence (5)', exact: true }).click();
  await panel.getByText(/Filled 5 of 5 fields/).waitFor();
  for (const [selector, expected] of [['#first', 'Alex'], ['#last', 'Example'], ['#email', 'alex@example.com'], ['#university', 'Example University'], ['#graduation', '2026']]) {
    assert.equal(await job.locator(selector).inputValue(), expected);
  }
  assert.equal(await job.locator('#sponsorship').inputValue(), '');
  await caption('02', 'Five fields. One click.', 'High-confidence answers are filled; sponsorship stays empty.');
  await frame(3.5);

  const sponsorship = panel.locator('article.card').filter({ hasText: 'Will you require visa sponsorship?' });
  await sponsorship.scrollIntoViewIfNeeded();
  await caption('03', 'Sensitive answers stay in your hands.', 'Check the flagged answer, then choose Fill for this question.');
  await frame(3);
  await sponsorship.getByRole('button', { name: 'Fill', exact: true }).click();
  await sponsorship.locator('p.ok').waitFor();
  assert.equal(await job.locator('#sponsorship').inputValue(), 'No');
  await caption('04', 'Ready for your final review.', 'The form is filled. The application has not been submitted.');
  await frame(4);
  assert.equal(await job.locator('body').getAttribute('data-submitted'), null);
  assert.equal(blockedWrites, 0, 'The extension must never attempt a network write');

  const ffmpeg = args => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { windowsHide: true });
  const concat = [];
  for (const { i, seconds } of list) {
    // Relative filenames keep machine paths out of the playlist.
    ffmpeg(['-i', path.join(frames, `${i}-a.png`), '-i', path.join(frames, `${i}-b.png`), '-filter_complex', 'hstack=inputs=2', '-frames:v', '1', path.join(frames, `${i}.png`)]);
    concat.push(`file '${i}.png'`, `duration ${seconds}`);
  }
  concat.push(`file '${list.at(-1).i}.png'`);
  const listFile = path.join(frames, 'list.txt');
  writeFileSync(listFile, concat.join('\n'));
  const source = ['-f', 'concat', '-safe', '1', '-i', listFile];
  const duration = String(list.reduce((total, frame) => total + frame.seconds, 0));
  ffmpeg([...source, '-t', duration, '-vf', 'fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', path.join(out, 'demo.gif')]);
  ffmpeg([...source, '-t', duration, '-vf', 'fps=24,scale=1340:820', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1', path.join(out, 'demo.mp4')]);
  writeFileSync(path.join(out, 'demo.vtt'), `WEBVTT\n\n00:00.000 --> 00:03.000\nThe extension matches a fictional form against a local answer bank.\n\n00:03.000 --> 00:06.500\nFive high-confidence fields fill in one click. Sponsorship stays empty.\n\n00:06.500 --> 00:09.500\nReview the flagged sponsorship answer and fill it individually.\n\n00:09.500 --> 00:13.500\nThe form is ready for final review. Nothing has been submitted.\n`);
  console.log('MEDIA PASS: 5 bulk-filled fields; sensitive field reviewed individually; no submission or network writes.');
  console.log('Created docs/media/{demo.gif,demo.mp4,demo.vtt,panel.png,options.png} using fictional data only.');
} finally {
  await context?.close();
  // Only the exact directory created by mkdtemp above is removed.
  const tempRoot = path.resolve(tmpdir());
  if (path.dirname(path.resolve(frames)) !== tempRoot || !path.basename(frames).startsWith('aa-frames-')) throw new Error('Unexpected temporary directory');
  rmSync(frames, { recursive: true, force: true });
}
