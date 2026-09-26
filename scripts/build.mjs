// Build script: bundles the main process, preload, index worker and renderer with esbuild,
// and copies static assets (pdf.js worker, cmaps, fonts, KaTeX fonts).
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: root,
};

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: { main: 'src/main/main.ts', 'index-worker': 'src/main/index-worker.ts' },
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron', 'pdfjs-dist'],
  },
  {
    ...common,
    entryPoints: { preload: 'src/main/preload.ts' },
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: { app: 'src/renderer/app.ts', 'app-style': 'src/renderer/styles.css' },
    outdir: path.join(dist, 'renderer'),
    platform: 'browser',
    format: 'esm',
    target: 'chrome120',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'dataurl', '.png': 'dataurl', '.gif': 'dataurl' },
    assetNames: 'assets/[name]-[hash]',
    // Never bundle Node built-ins into the renderer.
    external: ['node:*'],
  },
];

if (tests) {
  const testFiles = (await readdir(path.join(root, 'test'))).filter((f) => f.endsWith('.test.ts'));
  builds.push({
    ...common,
    entryPoints: testFiles.map((f) => path.join('test', f)),
    outdir: path.join(root, 'dist-test'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['pdfjs-dist'],
    logLevel: 'warning',
  });
}

async function copyAssets() {
  const r = path.join(dist, 'renderer');
  await mkdir(r, { recursive: true });
  await cp(path.join(root, 'src/renderer/index.html'), path.join(r, 'index.html'));
  for (const f of ['logo-mark.svg', 'logo.svg']) await cp(path.join(root, 'assets', f), path.join(r, f));
  await cp(path.join(pdfjsDir, 'legacy/build/pdf.worker.min.mjs'), path.join(r, 'pdf.worker.mjs'));
  for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    await cp(path.join(pdfjsDir, d), path.join(r, 'pdfjs', d), { recursive: true }).catch(() => undefined);
  }
}

if (!watch) await rm(dist, { recursive: true, force: true });
await copyAssets();
if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
  console.log('Watching for changes…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
