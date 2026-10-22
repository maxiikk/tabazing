// Which language the interface is in. The strings themselves live in dictionaries/<lang>.json and are read with
// translate() (utils/translations.js, ICU MessageFormat: named placeholders and plurals); _locales/ (which
// Chrome reads for the manifest's name and shortcuts) is generated from them by `npm run i18n`. Chrome gives
// extensions no way to switch language, so Tabazing picks its own: "auto" follows Chrome's language, or the
// user chooses one in Settings. Call loadLang() (or settingsLanguage) once before the first translate().
import { LANGUAGES, setLocale, translate, loadDictionary } from './translations.js';

export const LANGS = Object.freeze(['en', 'el', 'de', 'it', 'fr', 'es', 'ru', 'ar', 'he', 'ro']);
/** The languages written right to left: the pages turn round for them (dir="rtl"). */
const RIGHT_TO_LEFT_LANGUAGES = new Set(['ar', 'he']);

const chromeLang = () => {
  const language = (chrome.i18n.getUILanguage() || 'en').slice(0, 2).toLowerCase();
  return LANGS.includes(language) && LANGUAGES.includes(language) ? language : 'en';
};
let current = 'en';
let relativeTimeFormat = null;
let loaded = Promise.resolve();

// The language switches at once; its dictionary is read if it isn't yet (languageLoaded() resolves then).
function applyLanguage(lang) {
  current = setLocale(LANGS.includes(lang) ? lang : chromeLang());
  relativeTimeFormat = new Intl.RelativeTimeFormat(current, { numeric: 'auto', style: 'short' });
  loaded = loadDictionary(current).catch(() => {}); // (unreadable: its texts stay in English)
  return current;
}
applyLanguage(chromeLang());

/** Resolves once the language in use has its dictionary (after setLang, before drawing in it). */
export const languageLoaded = () => loaded;
/** Read the language setting ("auto" or a language), and that language's dictionary. Resolves to the language in use. */
export async function loadLang() {
  let preference = 'auto';
  try { const stored = await chrome.storage.local.get('prefs'); preference = (stored.prefs && stored.prefs.lang) || 'auto'; } catch {}
  const lang = applyLanguage(preference === 'auto' ? chromeLang() : preference);
  await loaded;
  return lang;
}
/** Switch right away (Settings); await languageLoaded() before drawing texts in it. */
export const setLang = (preference) => applyLanguage(preference === 'auto' ? chromeLang() : preference);
/** The language the interface is in now: one of LANGS. Also what the website pages are opened in. */
export const uiLang = () => current;
/** Whether that language is written right to left (Arabic, Hebrew). */
export const isRtl = () => RIGHT_TO_LEFT_LANGUAGES.has(current);

/** "5 min ago" in this language. `sec` is a Unix time in seconds. */
export function timeAgo(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''; // no timestamp: say nothing rather than "20000 d ago"
  const elapsedSeconds = Math.max(0, Date.now() / 1000 - seconds);
  if (elapsedSeconds < 60) return translate('justNow');
  if (elapsedSeconds < 3600) return relativeTimeFormat.format(-Math.round(elapsedSeconds / 60), 'minute');
  if (elapsedSeconds < 86400) return relativeTimeFormat.format(-Math.round(elapsedSeconds / 3600), 'hour');
  return relativeTimeFormat.format(-Math.round(elapsedSeconds / 86400), 'day');
}

/** Fill the static page (its lang and dir too): data-i18n (text), data-i18n-title, data-i18n-placeholder, data-i18n-aria. */
export function localizePage(root = document) {
  document.documentElement.lang = current;
  document.documentElement.dir = isRtl() ? 'rtl' : 'ltr';
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = translate(element.dataset.i18n);
  for (const element of root.querySelectorAll('[data-i18n-title]')) element.title = translate(element.dataset.i18nTitle);
  for (const element of root.querySelectorAll('[data-i18n-placeholder]')) element.placeholder = translate(element.dataset.i18nPlaceholder);
  for (const element of root.querySelectorAll('[data-i18n-aria]')) element.setAttribute('aria-label', translate(element.dataset.i18nAria));
}
