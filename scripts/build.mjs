// Build script: bundles the main process, preload, index worker and renderer with esbuild,
// and copies static assets (pdf.js worker, cmaps, fonts, KaTeX fonts).
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
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

/**
 * The library in a browser (src/web/app.ts): one self-contained dist/web/index.html, scripts
 * and styles inline, pdf.js and its worker included (the worker's code as a string: see
 * src/web/pdfjs.ts). Omoeba copies it into the library folders when asked in its settings.
 */
/** KaTeX's styles with each font in WOFF2 only (src: url(x.woff2) format("woff2")). */
const katexWoff2Only = {
  name: 'katex-woff2-only',
  setup(b) {
    b.onLoad({ filter: /katex(\.min)?\.css$/ }, async (args) => ({
      contents: (await readFile(args.path, 'utf8')).replace(/,\s*url\([^)]*\.(woff|ttf)\)\s*format\("(woff|truetype)"\)/g, ''),
      loader: 'css',
      resolveDir: path.dirname(args.path),
    }));
  },
};

async function buildWebPage() {
  const workerCode = await readFile(path.join(pdfjsDir, 'legacy/build/pdf.worker.min.mjs'), 'utf8');
  const workerPlugin = {
    name: 'pdfjs-worker-code',
    setup(b) {
      b.onResolve({ filter: /^pdfjs-worker-code$/ }, () => ({ path: 'pdfjs-worker-code', namespace: 'pdfjs-worker-code' }));
      b.onLoad({ filter: /.*/, namespace: 'pdfjs-worker-code' }, () => ({ contents: workerCode, loader: 'text' }));
    },
  };
  const [js, css] = await Promise.all([
    esbuild.build({
      entryPoints: ['src/web/app.ts'],
      absWorkingDir: root,
      bundle: true,
      write: false,
      minify: true,
      legalComments: 'none',
      format: 'esm',
      platform: 'browser',
      target: 'chrome120',
      external: ['node:*'],
      plugins: [workerPlugin],
      loader: { '.png': 'dataurl', '.wasm': 'binary' },
      logLevel: 'warning',
    }),
    esbuild.build({
      entryPoints: ['src/web/style.css'],
      absWorkingDir: root,
      bundle: true,
      write: false,
      minify: true,
      // KaTeX's fonts, embedded: only the WOFF2 ones (which Chrome uses), not their WOFF and TTF copies.
      loader: { '.woff2': 'dataurl' },
      plugins: [katexWoff2Only],
      logLevel: 'warning',
    }),
  ]);
  // Inline: nothing in them may close their element early.
  const inline = (s, tag) => s.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`).replace(/<!--/g, '<\\!--');
  const html =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="generator" content="Omoeba">\n<title>Omoeba library</title>\n' +
    `<style>${inline(css.outputFiles[0].text, 'style')}</style>\n</head>\n<body>\n<div id="app"></div>\n` +
    // The papers, written beside the page by Omoeba (a page opened from a file may load a
    // script beside it, but not read the folder): see src/web/paper.ts.
    '<script src="omoeba-library.js"></script>\n' +
    `<script type="module">${inline(js.outputFiles[0].text, 'script')}</script>\n</body>\n</html>\n`;
  await mkdir(path.join(dist, 'web'), { recursive: true });
  await writeFile(path.join(dist, 'web', 'index.html'), html);
  console.log(`  dist/web/index.html  ${(html.length / 1024 / 1024).toFixed(1)}mb`);
}

if (!watch) await rm(dist, { recursive: true, force: true });
await copyAssets();
await buildWebPage();
if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
  console.log('Watching for changes…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
