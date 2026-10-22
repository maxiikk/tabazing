// Writes _locales/<lang>/messages.json from dictionaries/<lang>.json: `npm run i18n`.
//
// dictionaries/ holds every string Tabazing shows, one file per language (utils/i18n.js reads them).
// Chrome itself only reads _locales/, for what manifest.json names with __MSG_key__ (the extension's
// name, description, shortcut names, toolbar title), so only those keys are written there. Run this after
// changing any of them, or after adding a language; tests/utils/dictionaries.test.js fails until you do.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

/** The languages there are dictionaries for: ['ar', 'de', 'el', 'en', …]. */
export const languages = () => readdirSync(join(ROOT, 'dictionaries')).filter((filename) => filename.endsWith('.json')).map((filename) => filename.slice(0, -5)).sort();
/** The keys manifest.json asks Chrome for (__MSG_key__). */
export const manifestKeys = () => [...new Set([...read('manifest.json').matchAll(/__MSG_(\w+)__/g)].map((match) => match[1]))].sort();

/** The messages.json text for one language: just the manifest's keys, in Chrome's { key: { message } } form. */
export function localeFile(lang) {
  const dict = JSON.parse(read(`dictionaries/${lang}.json`));
  const out = {};
  for (const key of manifestKeys()) {
    if (typeof dict[key] !== 'string') throw new Error(`dictionaries/${lang}.json has no "${key}" (manifest.json uses __MSG_${key}__)`);
    out[key] = { message: dict[key] };
  }
  return JSON.stringify(out, null, 3) + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const lang of languages()) {
    mkdirSync(join(ROOT, '_locales', lang), { recursive: true });
    writeFileSync(join(ROOT, '_locales', lang, 'messages.json'), localeFile(lang));
    console.log(`_locales/${lang}/messages.json`);
  }
}
