// Builds the Firefox copy of the extension (`npm run firefox`): dist/firefox/, the folder to load in Firefox
// (about:debugging → This Firefox → Load Temporary Add-on → its manifest.json), and dist/tabazing-firefox-<version>.zip,
// the file to upload to addons.mozilla.org. The code is the same as Chrome's; only the manifest differs:
//   - the background runs as a script (Firefox has no extension service workers);
//   - Firefox's own settings: the add-on's id, the oldest Firefox it runs in, what it collects (nothing);
//   - what only Chrome knows is left out: the favicon permission (Firefox gives extensions no favicon service: the
//     background keeps the icons itself, utils/browser.js), and keys Firefox would warn about.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFiles } from '../utils/zip.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'dist', 'firefox');
export const GECKO_ID = 'tabazing@maxiikk.github.io';
export const FIREFOX_MIN = '140.0'; // tab groups (139), MAIN-world content scripts (128), the popover API (125): the ESR
// What the extension is made of: everything Chrome loads. The rest of the folder is development only.
export const PARTS = ['manifest.json', 'background.js', 'hotkey.js', 'media-hook.js', 'media-relay.js', 'switcher.js', 'sweep.js', 'LICENSE', '_locales', 'dictionaries', 'icons', 'markup', 'styles', 'utils'];

/** Chrome's manifest, as Firefox wants it. */
export function firefoxManifest(manifest) {
  const out = structuredClone(manifest);
  out.background = { scripts: [manifest.background.service_worker], type: manifest.background.type };
  delete out.minimum_chrome_version;
  out.permissions = out.permissions.filter((permission) => permission !== 'favicon');
  for (const script of out.content_scripts) delete script.match_origin_as_fallback;
  for (const resource of out.web_accessible_resources) delete resource.use_dynamic_url;
  out.browser_specific_settings = { gecko: { id: GECKO_ID, strict_min_version: FIREFOX_MIN, data_collection_permissions: { required: ['none'] } } };
  return out;
}

const filesUnder = (path) => (statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => filesUnder(join(path, name))) : [path]);

/** Writes dist/firefox/ and the zip; resolves to the zip's path. */
export function build() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const part of PARTS) cpSync(join(ROOT, part), join(OUT, part), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(firefoxManifest(manifest), null, 2) + '\n');
  const zipPath = join(ROOT, 'dist', `tabazing-firefox-${manifest.version}.zip`);
  const files = filesUnder(OUT).map((path) => ({ name: relative(OUT, path).split(sep).join('/'), data: readFileSync(path) }));
  writeFileSync(zipPath, zipFiles(files));
  return zipPath;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log('Written:', relative(ROOT, OUT), 'and', relative(ROOT, build()));
