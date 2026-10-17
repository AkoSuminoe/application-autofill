// Records the README demo: loads dist/ in headless Chromium with a fictional demo profile,
// opens a live Greenhouse application, drives the side panel and stitches the frames into a GIF.
// It only fills fields. It never submits. Requires ffmpeg on PATH.
//
//   npm run build && npm run media [-- <greenhouse job url>]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const jobUrl = process.argv[2] ?? 'https://job-boards.greenhouse.io/figma/jobs/5426468004';
const out = path.resolve('docs/media');
const frames = mkdtempSync(path.join(tmpdir(), 'aa-frames-'));
mkdirSync(out, { recursive: true });

// Fictional persona: nothing here belongs to a real person.
const now = Date.now();
const answer = (id, questions, text, sensitive) => ({
  id, questions, answer: text, kind: 'boolean', tags: [], scope: { type: 'global' },
  ...(sensitive ? { sensitive } : {}), createdAt: now, updatedAt: now, timesUsed: 0, lastUsedAt: null,
});
const demoBank = {
  app: 'application-autofill',
  exportedAt: new Date().toISOString(),
  bank: {
    schemaVersion: 2,
    profile: {
      firstName: 'Alex', lastName: 'Morgan', preferredName: 'Alex', email: 'alex.morgan@example.com', phone: '07700 900123',
      linkedin: 'https://www.linkedin.com/in/alex-morgan-demo', github: 'https://github.com/alex-morgan-demo', website: 'https://alexmorgan.example',
      location: { city: 'London', country: 'United Kingdom', postcode: '' },
      university: 'Example University', degree: 'BSc Software Engineering', graduation: { month: 6, year: 2026 }, highSchool: '',
      visaStatus: 'British citizen', needsSponsorship: 'no', salaryExpectation: '', startDate: 'September 2026',
      languages: [{ name: 'English', level: 'native' }], skills: [{ name: 'TypeScript', level: 'advanced' }, { name: 'Python', level: 'intermediate' }],
    },
    answers: [
      answer('demo-rtw', ['Are you legally authorised to work in the UK?'], 'Yes', 'right_to_work'),
      answer('demo-sponsor', ['Will you now or in the future require visa sponsorship?'], 'No', 'sponsorship'),
    ],
  },
};

const ext = path.resolve('dist');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true, deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
context.setDefaultTimeout(20000);

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  await new Promise((r) => setTimeout(r, 800));
  for (const p of context.pages()) if (p.url().includes(id)) await p.close();

  // Seed the demo bank through the normal import path, then screenshot the options page.
  const options = await context.newPage();
  await options.setViewportSize({ width: 1100, height: 1000 });
  await options.goto(`chrome-extension://${id}/options.html`);
  const res = await options.evaluate((text) => chrome.runtime.sendMessage({ type: 'bankMutation', operation: { kind: 'import', text, mode: 'merge' } }), JSON.stringify(demoBank));
  if (!res?.ok) throw new Error(`Import failed: ${res?.error}`);
  await options.reload();
  await options.getByRole('button', { name: 'Save profile', exact: true }).waitFor();
  await options.screenshot({ path: path.join(out, 'options.png') });
  await options.close();

  // Block any application POST outright, as a belt-and-braces guarantee.
  await context.route('**/*', (route) => {
    const r = route.request();
    if (r.method() === 'POST' && /applications|submit/i.test(r.url())) return route.abort();
    return route.continue();
  });

  const job = await context.newPage();
  await job.setViewportSize({ width: 900, height: 820 });
  await job.goto(jobUrl, { waitUntil: 'networkidle' });
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u.split('?')[0]))?.id, jobUrl);

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 440, height: 820 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tabId=${tabId}`);
  await panel.locator('article.card').first().waitFor();
  await panel.waitForTimeout(1200);

  const toForm = async () => {
    await job.evaluate(() => {
      const heading = [...document.querySelectorAll('h1, h2, h3')].find((h) => /apply for this job/i.test(h.textContent ?? ''));
      (heading ?? document.querySelector('#application-form'))?.scrollIntoView({ block: 'start', behavior: 'instant' });
      window.scrollBy({ top: -16, behavior: 'instant' });
    });
    await job.waitForTimeout(400);
  };
  let n = 0;
  const list = [];
  const frame = async (seconds) => {
    const i = String(n++).padStart(3, '0');
    await job.screenshot({ path: path.join(frames, `${i}-a.png`) });
    await panel.screenshot({ path: path.join(frames, `${i}-b.png`) });
    list.push({ i, seconds });
  };

  await toForm();
  await frame(2.2);

  // Bulk fill, sampling frames while it runs.
  await panel.getByRole('button', { name: /^Fill all high-confidence/ }).click();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !(await panel.locator('.notice').count())) {
    await frame(0.35);
    await panel.waitForTimeout(150);
  }
  await panel.waitForTimeout(800);
  const failed = await panel.$$eval('article.card', (cards) => cards.filter((c) => /Couldn/.test(c.textContent)).map((c) => `${c.querySelector('.q')?.textContent}: ${c.querySelector('.warn')?.textContent}`));
  if (failed.length) console.log(`Not filled:\n  ${failed.join('\n  ')}`);
  await toForm();
  await frame(2.5);

  // Flagged questions are reviewed and filled one at a time.
  const rtw = panel.locator('article.card').filter({ hasText: 'authorized to work' });
  await rtw.scrollIntoViewIfNeeded();
  await panel.evaluate(() => window.scrollBy(0, 120));
  await job.getByText(/Are you authori[sz]ed to work/).first().evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await job.waitForTimeout(300);
  await frame(2.2);
  await rtw.getByRole('button', { name: 'Fill', exact: true }).click();
  await panel.waitForTimeout(1500);
  await frame(3);

  // Still images for the README.
  await panel.evaluate(() => window.scrollTo(0, 0));
  await panel.screenshot({ path: path.join(out, 'panel.png'), fullPage: true, clip: { x: 0, y: 0, width: 440, height: 1480 } });

  // Compose: job | panel side by side, then a palette-optimised GIF.
  const concat = [];
  for (const { i, seconds } of list) {
    const pair = path.join(frames, `${i}.png`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(frames, `${i}-a.png`), '-i', path.join(frames, `${i}-b.png`), '-filter_complex', 'hstack=inputs=2', pair]);
    concat.push(`file '${pair.replace(/\\/g, '/')}'`, `duration ${seconds}`);
  }
  concat.push(`file '${path.join(frames, `${list.at(-1).i}.png`).replace(/\\/g, '/')}'`);
  const listFile = path.join(frames, 'list.txt');
  writeFileSync(listFile, concat.join('\n'));
  const gif = path.join(out, 'demo.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'fps=10,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0', gif]);
  console.log(`Wrote ${gif}, options.png, panel.png (${list.length} frames)`);
} finally {
  await context.close();
  rmSync(frames, { recursive: true, force: true });
}
