// Which language the interface is in. The strings themselves live in dictionaries/<lang>.json and are read with
// getTranslation() (lib/translations.js, ICU MessageFormat: named placeholders and plurals); _locales/ (which
// Chrome reads for the manifest's name and shortcuts) is generated from them by `npm run i18n`. Chrome gives
// extensions no way to switch language, so Tabazing picks its own: "auto" follows Chrome's language, or the
// user chooses one in Settings. Call loadLang() (or setLang) once before the first getTranslation().
import { LANGUAGES, setLocale, getTranslation } from './translations.js';

export const LANGS = Object.freeze(['en', 'ru', 'es']);

const chromeLang = () => {
  const l = (chrome.i18n.getUILanguage() || 'en').slice(0, 2).toLowerCase();
  return LANGS.includes(l) && LANGUAGES.includes(l) ? l : 'en';
};
let cur = 'en';
let rtf = null;

function use(lang) {
  cur = setLocale(LANGS.includes(lang) ? lang : chromeLang());
  rtf = new Intl.RelativeTimeFormat(cur, { numeric: 'auto', style: 'short' });
  return cur;
}
use(chromeLang());

/** Read the language setting ("auto" or a language). Resolves to the language in use. */
export async function loadLang() {
  let pref = 'auto';
  try { const o = await chrome.storage.local.get('prefs'); pref = (o.prefs && o.prefs.lang) || 'auto'; } catch {}
  return use(pref === 'auto' ? chromeLang() : pref);
}
/** Switch right away (Settings). */
export const setLang = (pref) => use(pref === 'auto' ? chromeLang() : pref);
/** The language the interface is in now: 'en' | 'ru' | 'es'. Also what the website pages are opened in. */
export const uiLang = () => cur;

/** "5 min ago" in this language. `sec` is a Unix time in seconds. */
export function timeAgo(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return ''; // no timestamp: say nothing rather than "20000 d ago"
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return getTranslation('justNow');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

/** Fill the static page: data-i18n (text), data-i18n-title, data-i18n-placeholder, data-i18n-aria. */
export function localizePage(root = document) {
  document.documentElement.lang = cur;
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = getTranslation(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = getTranslation(n.dataset.i18nTitle);
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = getTranslation(n.dataset.i18nPlaceholder);
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', getTranslation(n.dataset.i18nAria));
}
