// Bundles the extension into dist/. `node build.mjs --watch` rebuilds on change.
import * as esbuild from 'esbuild';
import { cpSync, rmSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('static', outdir, { recursive: true });

const common = { bundle: true, target: 'chrome116', sourcemap: 'linked', logLevel: 'info', outdir };

const configs = [
  // Content scripts can't be ES modules, so this one is an IIFE.
  { ...common, entryPoints: { content: 'src/content/index.ts' }, format: 'iife' },
  { ...common, entryPoints: { sw: 'src/background/sw.ts', sidepanel: 'src/sidepanel/main.ts', options: 'src/options/main.ts' }, format: 'esm' },
];

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
  // static/ is copied once; restart watch after editing HTML/CSS/manifest.
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
