// Writes _locales/<lang>/messages.json from dictionaries/<lang>.json: `npm run i18n`.
//
// dictionaries/ holds every string Tabazing shows, one file per language (lib/i18n.js reads them).
// Chrome itself only reads _locales/, for what manifest.json names with __MSG_key__ (the extension's
// name, description, shortcut names, toolbar title), so only those keys are written there. Run this after
// changing any of them, or after adding a language; tests/lib/dictionaries.test.js fails until you do.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** The languages there are dictionaries for: ['en', 'es', 'ru']. */
export const languages = () => readdirSync(join(ROOT, 'dictionaries')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
/** The keys manifest.json asks Chrome for (__MSG_key__). */
export const manifestKeys = () => [...new Set([...read('manifest.json').matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]))].sort();

/** The messages.json text for one language: just the manifest's keys, in Chrome's { key: { message } } form. */
export function localeFile(lang) {
  const dict = JSON.parse(read(`dictionaries/${lang}.json`));
  const out = {};
  for (const k of manifestKeys()) {
    if (typeof dict[k] !== 'string') throw new Error(`dictionaries/${lang}.json has no "${k}" (manifest.json uses __MSG_${k}__)`);
    out[k] = { message: dict[k] };
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
