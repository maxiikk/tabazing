// getTranslation(key, data): a string from dictionaries/<lang>.json in the interface language, with its
// placeholders filled in from `data`.
//
//   "tabs": "{count, plural, one {# tab} other {# tabs}}"
//   getTranslation('tabs', { count: 5 })                      -> "5 tabs"
//   "activeTab": "Active tab: {title}"
//   getTranslation('activeTab', { title: 'Inbox' })          -> "Active tab: Inbox"
//
// Messages use ICU MessageFormat (the syntax of ICU / FormatJS / i18next-icu), the parts Tabazing needs, with no
// library to bundle:
//   {name}                                  the value, as text
//   {name, number}                          a number in the language's format ("1,234")
//   {name, plural, =0 {…} one {…} other {…}}   by count: =N exact, then the language's plural categories
//                                           (zero one two few many other, from Intl.PluralRules); # inside is the
//                                           count; "offset:1" before the options counts from one less
//   {name, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}
//   {name, select, a {…} b {…} other {…}}   by value
//   '{' '}' '#'                             a literal brace or #; '' is one apostrophe (other apostrophes,
//                                           as in "don't", are plain text)
// A key missing in the language falls back to English, then to the key itself (easy to spot); a value missing
// from `data` leaves its {placeholder} in the text.
import EN from '../dictionaries/en.json' with { type: 'json' };
import ES from '../dictionaries/es.json' with { type: 'json' };
import RU from '../dictionaries/ru.json' with { type: 'json' };

const DICTIONARIES = { en: EN, es: ES, ru: RU };
/** The languages there is a dictionary for. */
export const LANGUAGES = Object.freeze(Object.keys(DICTIONARIES));

let locale = 'en';
/** Switch the language getTranslation() uses (an unknown one means English). Returns the one in use. */
export function setLocale(lang) {
  locale = DICTIONARIES[lang] ? lang : 'en';
  return locale;
}
export const getLocale = () => locale;

/** The text for `key` in the current language, its placeholders filled from `data`. */
export function getTranslation(key, data = {}) {
  const dict = DICTIONARIES[locale];
  const lang = key in dict ? locale : key in EN ? 'en' : null;
  if (!lang) return key;
  return formatMessage(DICTIONARIES[lang][key], data, lang, lang + '\u0000' + key);
}

/** Format an ICU message (`pattern`) with `data` for `lang`. `cacheKey` (optional) keeps the parsed message. */
export function formatMessage(pattern, data = {}, lang = locale, cacheKey = null) {
  let ast = cacheKey && parsed.get(cacheKey);
  if (!ast) {
    ast = parse(String(pattern));
    if (cacheKey) parsed.set(cacheKey, ast);
  }
  return render(ast, data || {}, lang, null);
}
const parsed = new Map(); // "lang\0key" -> the message, parsed once

/** The placeholder names a message uses, with how: { count: 'plural', title: null, ... }. Throws if it doesn't parse. */
export function messageArguments(pattern) {
  const out = {};
  const walk = (parts) => {
    for (const p of parts) {
      if (typeof p !== 'object') continue;
      if (!(p.arg in out) || p.type) out[p.arg] = p.type;
      if (p.options) Object.values(p.options).forEach(walk);
    }
  };
  walk(parse(String(pattern)));
  return out;
}

// ---- parsing: a message is a list of parts: text, COUNT (a # in a plural), or { arg, type, options, offset }
const COUNT = Symbol('#');
function parse(s) {
  const [parts, end] = parseParts(s, 0, false);
  if (end < s.length) throw new SyntaxError(`Unexpected "}" at ${end} in: ${s}`);
  return parts;
}
function parseParts(s, i, inPlural) {
  const parts = [];
  let text = '';
  const flush = () => { if (text) { parts.push(text); text = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const next = s[i + 1];
      if (next === "'") { text += "'"; i += 2; continue; }
      if (next === '{' || next === '}' || next === '|' || (next === '#' && inPlural)) { // quoted literal up to the next lone '
        let j = i + 1;
        for (; j < s.length; j++) {
          if (s[j] === "'") { if (s[j + 1] === "'") { text += "'"; j++; continue; } break; }
          text += s[j];
        }
        i = j + 1;
        continue;
      }
      text += c; i++; continue;
    }
    if (c === '{') { flush(); const [arg, j] = parseArg(s, i + 1); parts.push(arg); i = j; continue; }
    if (c === '}') break;
    if (c === '#' && inPlural) { flush(); parts.push(COUNT); i++; continue; }
    text += c; i++;
  }
  flush();
  return [parts, i];
}
const skipSpace = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };
function readWord(s, i) {
  const start = i;
  while (i < s.length && !/[\s,{}]/.test(s[i])) i++;
  return [s.slice(start, i), i];
}
function parseArg(s, i) {
  let name;
  i = skipSpace(s, i);
  [name, i] = readWord(s, i);
  i = skipSpace(s, i);
  if (!name) throw new SyntaxError(`Empty argument in: ${s}`);
  if (s[i] === '}') return [{ arg: name, type: null }, i + 1];
  if (s[i] !== ',') throw new SyntaxError(`Expected "," or "}" after {${name} in: ${s}`);
  let type;
  i = skipSpace(s, i + 1);
  [type, i] = readWord(s, i);
  i = skipSpace(s, i);
  if (type !== 'plural' && type !== 'selectordinal' && type !== 'select') { // number (a style after it is ignored)
    const end = s.indexOf('}', i);
    if (end < 0) throw new SyntaxError(`Unclosed {${name} in: ${s}`);
    return [{ arg: name, type }, end + 1];
  }
  if (s[i] !== ',') throw new SyntaxError(`Expected "," after {${name}, ${type} in: ${s}`);
  i++;
  const options = {};
  let offset = 0;
  for (;;) {
    i = skipSpace(s, i);
    if (s[i] === '}') break;
    if (i >= s.length) throw new SyntaxError(`Unclosed {${name}, ${type} in: ${s}`);
    let sel;
    [sel, i] = readWord(s, i);
    if (sel.startsWith('offset:')) { offset = Number(sel.slice(7)); continue; }
    i = skipSpace(s, i);
    if (s[i] !== '{') throw new SyntaxError(`Expected "{" after "${sel}" in: ${s}`);
    const [sub, j] = parseParts(s, i + 1, type !== 'select');
    if (s[j] !== '}') throw new SyntaxError(`Unclosed option "${sel}" in: ${s}`);
    options[sel] = sub;
    i = j + 1;
  }
  if (!options.other) throw new SyntaxError(`{${name}, ${type}} needs an "other" option in: ${s}`);
  return [{ arg: name, type, options, offset }, i + 1];
}

// ---- formatting
const rules = new Map(); // "lang/type" -> Intl.PluralRules
const numbers = new Map(); // lang -> Intl.NumberFormat
function pluralRules(lang, type) {
  const k = lang + '/' + type;
  if (!rules.has(k)) rules.set(k, new Intl.PluralRules(lang, { type }));
  return rules.get(k);
}
function number(lang, n) {
  if (!numbers.has(lang)) numbers.set(lang, new Intl.NumberFormat(lang));
  return numbers.get(lang).format(n);
}
function render(parts, data, lang, count) {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') out += p;
    else if (p === COUNT) out += count === null ? '#' : number(lang, count);
    else out += renderArg(p, data, lang, count);
  }
  return out;
}
function renderArg(p, data, lang, count) {
  if (!(p.arg in data)) return '{' + p.arg + '}';
  const v = data[p.arg];
  if (p.type === null) return String(v);
  if (p.type === 'number') return number(lang, Number(v));
  if (p.type === 'select') return render(p.options[String(v)] || p.options.other, data, lang, count);
  const n = Number(v);
  const exact = p.options['=' + n];
  if (exact) return render(exact, data, lang, n - p.offset);
  const cat = pluralRules(lang, p.type === 'plural' ? 'cardinal' : 'ordinal').select(n - p.offset);
  return render(p.options[cat] || p.options.other, data, lang, n - p.offset);
}
