// lib/msgs/<lang>.js are generated from _locales/<lang>/messages.json: they must stay identical, and every key
// the code asks for must exist.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import EN from '../../lib/msgs/en.js';
import ES from '../../lib/msgs/es.js';
import RU from '../../lib/msgs/ru.js';

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');
const BOOKS = { en: EN, es: ES, ru: RU };
const locale = (lang) => JSON.parse(read(`_locales/${lang}/messages.json`));

describe.each(Object.keys(BOOKS))('lib/msgs/%s.js', (lang) => {
  const json = locale(lang);
  const book = BOOKS[lang];
  it('has exactly the keys of messages.json', () => {
    expect(Object.keys(book).sort()).toEqual(Object.keys(json).sort());
  });
  it('has exactly the messages of messages.json', () => {
    for (const [k, v] of Object.entries(json)) expect(book[k], k).toBe(v.message);
  });
  it('says which locale it is', () => {
    expect(book.localeCode).toBe(lang);
  });
  it('every message is a non-empty string', () => {
    for (const [k, v] of Object.entries(book)) { expect(typeof v, k).toBe('string'); expect(v.trim(), k).not.toBe(''); }
  });
  it('translates every English key, with the same placeholders', () => {
    if (lang === 'en') return;
    const placeholders = (s) => [...new Set(s.match(/\$\d/g) || [])].sort();
    for (const k of Object.keys(EN)) expect(k in book, k).toBe(true);
    // A plural form may drop $1 (like English "_one") or add it (Russian _one also covers 21, 31...), so plural
    // forms only must not invent placeholders English _other lacks; other keys must match exactly.
    for (const k of Object.keys(book)) {
      if (k === 'localeCode') continue;
      const plural = /_(one|few|many|other)$/.test(k);
      const en = plural ? EN[k.replace(/_\w+$/, '_other')] : EN[k];
      expect(en, k).toBeDefined();
      if (plural) for (const p of placeholders(book[k])) expect(placeholders(en), k).toContain(p);
      else expect(placeholders(book[k]), k).toEqual(placeholders(en));
    }
  });
});

// ---- keys used by the code
const SOURCES = ['background.js', 'switcher.js', 'sweep.js', 'lib/capture.js', 'lib/store.js', 'lib/sweep.js', 'lib/archive.js', 'lib/review.js'];
const HTML = ['switcher.html', 'sweep.html'];

// The string literals in the first argument of every t(...) / tn(...) call (covers `t(cond ? 'a' : 'b')`).
function calls(src, fn) {
  const keys = new Set();
  const re = new RegExp(`(?<![\\w.$])${fn}\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 0, arg = '';
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') { const end = src.indexOf(c, i + 1); arg += src.slice(i, end + 1); i = end; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (!depth) break; depth--; }
      else if (c === ',' && !depth) break;
      arg += c;
    }
    for (const [, s] of arg.matchAll(/'([^']*)'|"([^"]*)"/g)) if (/^[A-Za-z]\w*$/.test(s)) keys.add(s);
  }
  return keys;
}

const code = SOURCES.map(read).join('\n');
const tKeys = calls(code, 't');
const tnKeys = calls(code, 'tn');
// Keys passed through a variable: FILTERS / DD_SOURCES labels and the mood buttons in switcher.js.
for (const [, k] of read('switcher.js').matchAll(/\blabel: '(\w+)'/g)) tKeys.add(k);
for (const k of ['moodGood', 'moodOkay', 'moodBad']) tKeys.add(k);
const htmlKeys = new Set(HTML.flatMap((f) => [...read(f).matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g)].map((m) => m[1])));
const manifestKeys = new Set([...read('manifest.json').matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]));

describe('keys used in the code', () => {
  it('the scan finds them (sanity check)', () => {
    expect(tKeys.size).toBeGreaterThan(50);
    expect(tnKeys.size).toBeGreaterThan(5);
    expect(htmlKeys.size).toBeGreaterThan(3);
  });
  it('every t() key exists in English', () => {
    const missing = [...tKeys, 'justNow'] // justNow: timeAgo() in lib/i18n.js
     .filter((k) => !(k in EN));
    expect(missing).toEqual([]);
  });
  it('every data-i18n* key exists in English', () => {
    expect([...htmlKeys].filter((k) => !(k in EN))).toEqual([]);
  });
  it('every __MSG_ key in manifest.json exists in every locale', () => {
    for (const lang of Object.keys(BOOKS)) expect([...manifestKeys].filter((k) => !(k in BOOKS[lang])), lang).toEqual([]);
  });
  it('every tn() key has an _other form in English', () => {
    expect([...tnKeys].filter((k) => !(`${k}_other` in EN))).toEqual([]);
  });
  it('Russian has _one/_few/_many/_other wherever English has _one', () => {
    const missing = [];
    for (const k of Object.keys(EN)) {
      if (!k.endsWith('_one')) continue;
      const base = k.slice(0, -4);
      for (const f of ['one', 'few', 'many', 'other']) if (!(`${base}_${f}` in RU)) missing.push(`${base}_${f}`);
    }
    expect(missing).toEqual([]);
  });
  it('tn() keys used by the code also have Russian forms', () => {
    const missing = [...tnKeys].flatMap((k) => ['one', 'few', 'many', 'other'].map((f) => `${k}_${f}`)).filter((k) => !(k in RU));
    expect(missing).toEqual([]);
  });
});
