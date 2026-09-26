// macOS only: brand the development Electron bundle (node_modules/electron/dist/Electron.app)
// as "Omoeba", so that `npm start` shows the right name in the menu bar, Dock and ⌘-Tab
// switcher, and the Omoeba icon from launch.
//
// The bold application-menu title and the Dock label come from the bundle's Info.plist and
// cannot be changed at runtime. After editing the bundle it is re-signed ad hoc (required on
// Apple Silicon). The original files are kept as *.orig. Safe to run repeatedly.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const NAME = 'Omoeba';

let app;
try {
  // node_modules/electron/path.txt holds the executable path relative to dist/.
  const electronDir = path.dirname(require.resolve('electron/package.json'));
  const exe = readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim();
  app = path.join(electronDir, 'dist', exe.split('/Contents/')[0]);
} catch {
  console.warn('[brand] Electron is not installed yet; skipping.');
  process.exit(0);
}

const plistPath = path.join(app, 'Contents', 'Info.plist');
const iconDest = path.join(app, 'Contents', 'Resources', 'electron.icns');
const iconSrc = path.join(root, 'assets', 'icon.icns');
if (!existsSync(plistPath)) process.exit(0);

let changed = false;

const plist = readFileSync(plistPath, 'utf8');
const branded = plist.replace(
  /(<key>(?:CFBundleName|CFBundleDisplayName)<\/key>\s*<string>)[^<]*(<\/string>)/g,
  `$1${NAME}$2`,
);
if (branded !== plist) {
  if (!existsSync(plistPath + '.orig')) writeFileSync(plistPath + '.orig', plist);
  writeFileSync(plistPath, branded);
  changed = true;
}

if (existsSync(iconSrc)) {
  const want = readFileSync(iconSrc);
  const have = existsSync(iconDest) ? readFileSync(iconDest) : null;
  if (!have || !want.equals(have)) {
    if (have && !existsSync(iconDest + '.orig')) copyFileSync(iconDest, iconDest + '.orig');
    copyFileSync(iconSrc, iconDest);
    changed = true;
  }
}

if (changed) {
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
  } catch {
    console.warn('[brand] Could not re-sign Electron.app; restoring the original bundle files.');
    if (existsSync(plistPath + '.orig')) copyFileSync(plistPath + '.orig', plistPath);
    if (existsSync(iconDest + '.orig')) copyFileSync(iconDest + '.orig', iconDest);
    process.exit(0);
  }
  // Nudge Launch Services / the Dock to pick up the new name and icon.
  const now = new Date();
  utimesSync(app, now, now);
  console.log(`[brand] Electron.app is now branded as ${NAME}.`);
}
