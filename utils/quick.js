// Quick answers for the command palette: arithmetic, percentages, unit conversions, number bases, colours,
// time zones and dates, worked out locally from what was typed. Pure: no DOM, no chrome.*, no network, and
// no eval / Function (arithmetic goes through the small parser below). Never throws: anything it doesn't
// understand, or that comes out as not a finite number, is null.
//
//   quick('10 km in mi', { lang: 'en' }) -> { kind: 'unit', value: '6.21371 mi', copy: '6.21371 mi', expr: '10 km = 6.21371 mi' }
//
// A result: { kind, value, copy, expr, ... }
//   kind   'calc' | 'unit' | 'base' | 'color' | 'time' | 'date' | 'days' | 'currency'
//   value  what the row shows big, formatted for `lang` (Intl.NumberFormat / DateTimeFormat); for 'days', `count` instead
//   copy   what Enter copies: numbers as plain digits with a dot ("1234.5", no grouping, pastes anywhere),
//          a unit result with its symbol, a date as YYYY-MM-DD, anything else as shown
//   expr   the whole thing ("80 + 15% = 92"), for the row's "copy expression" button
//   alts   (colour, base) the same value in other notations; swatch (colour) '#rrggbb'; place, zone (time)
// 'currency' has nothing else: exchange rates need the internet, which Tabazing never uses.
//
// Precision: calculations are rounded to 12 significant digits (0.1 + 0.2 shows 0.3), conversions to 6
// ("10 km in mi" -> 6.21371). From 1e15 up, and below 1e-6, numbers show in scientific notation.
// Numbers may use thousands separators: "1,234.5" and "1.234,5" both work; a lone comma is the decimal mark
// ("1,5" = 1.5), except where the decimal mark is a dot (English, Hebrew, Arabic): there "1,234" (groups of three) is a thousand.
// Trigonometry is in degrees: sin(30) = 0.5.

const MAX_LEN = 200;

export function quick(text, { lang = 'en', now = Date.now(), zone = localZone() } = {}) {
  try {
    const s = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
    if (!s || s.length > MAX_LEN) return null;
    const ctx = { lang, now, zone };
    for (const fn of [currency, color, base, timeZone, dateCalc, unit, calc]) {
      const r = fn(s, ctx);
      if (r) return r;
    }
    return null;
  } catch {
    return null;
  }
}

const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

// ---------------------------------------------------------------- numbers
// "1,234.5", "1.234,5", "1,5", "12" -> a number, or NaN. See the header for the comma rule.
export function parseNumber(str, lang = 'en') {
  const s = String(str);
  if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return NaN;
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  let out = s;
  if (dots && commas) {
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const group = dec === '.' ? ',' : '.';
    const [int, frac, extra] = s.split(dec);
    if (extra !== undefined || !grouped(int, group)) return NaN;
    out = int.split(group).join('') + '.' + frac;
  } else if (commas) {
    if (commas > 1 || (COMMA_GROUPS.has(lang) && grouped(s, ','))) { if (!grouped(s, ',')) return NaN; out = s.split(',').join(''); }
    else out = s.replace(',', '.');
  } else if (dots > 1) {
    if (!grouped(s, '.')) return NaN;
    out = s.split('.').join('');
  }
  return Number(out);
}
const COMMA_GROUPS = new Set(['en', 'he', 'ar']); // the languages that group with commas and use a decimal dot
const grouped = (s, sep) => new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(s) || (!s.includes(sep) && /^\d+$/.test(s));

const formatters = new Map();
function nf(lang, opts) {
  const k = lang + JSON.stringify(opts);
  let f = formatters.get(k);
  if (!f) {
    try { f = new Intl.NumberFormat(lang, opts); } catch { f = new Intl.NumberFormat('en', opts); }
    if (formatters.size > 50) formatters.clear();
    formatters.set(k, f);
  }
  return f;
}
// Rounded to `sig` significant digits: the shown text, and the plain one that is copied.
export function formatNumber(x, lang = 'en', sig = 12) {
  const r = Number(x.toPrecision(sig));
  const a = Math.abs(r);
  const sci = a !== 0 && (a >= 1e15 || a < 1e-6);
  const shown = sci ? nf(lang, { notation: 'scientific', maximumSignificantDigits: Math.min(sig, 10) }).format(r) : nf(lang, { maximumSignificantDigits: sig }).format(r);
  return { shown, plain: Object.is(r, -0) ? '0' : String(r) };
}

// ---------------------------------------------------------------- currency
const CURRENCY_CODES = 'usd eur gbp jpy rub cny chf cad aud nzd mxn brl inr krw sek nok dkk pln czk huf try uah kzt ars clp cop pen ils zar sgd hkd thb byn gel amd btc eth';
const CURRENCY = new Set(CURRENCY_CODES.split(' '));
const CURRENCY_WORD = /^(dollars?|euros?|yen|yuan|rubles?|roubles?|pesos?|rupees?|francs?|d[oó]lar(es)?|libras? esterlinas?|рубл[ьяей]*|доллар(ов|а|ы)?|евро|юан[ьяей]*|иен[аы]?|фунт(ов|а|ы)? стерлингов|bitcoins?)$/i;
const CURRENCY_SYM = /^[$€£¥₽₹₩₺₴₸]$/;
const isCurrency = (w) => CURRENCY.has(w.toLowerCase()) || CURRENCY_WORD.test(w) || CURRENCY_SYM.test(w);
const CONNECT = /^(in|to|into|as|=|->|→|en|a|в|во)$/i;
function currency(s) {
  // Symbols may touch the number ("$10", "10€"): set them apart first.
  const words = s.replace(/([$€£¥₽₹₩₺₴₸])/g, ' $1 ').trim().split(' ').filter(Boolean);
  let num = 0, cur = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d[\d.,]*$/.test(w)) num++;
    else if (isCurrency(w)) cur++;
    else if (i + 1 < words.length && isCurrency(w + ' ' + words[i + 1])) { cur++; i++; }
    else if (!CONNECT.test(w)) return null;
  }
  return num === 1 && cur >= 1 ? { kind: 'currency' } : null;
}

// ---------------------------------------------------------------- colours
const hex2 = (n) => n.toString(16).padStart(2, '0');
const toHex = ([r, g, b]) => '#' + hex2(r) + hex2(g) + hex2(b);
const rgbText = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;
const hslText = ([h, s, l]) => `hsl(${h}, ${s}%, ${l}%)`;
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [Math.round(h) % 360, Math.round(s * 100), Math.round(l * 100)];
}
function hslToRgb([h, s, l]) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}
function color(s) {
  const m = /^(.+?)(?: (?:in|to|as|en|a|в) (hex|rgb|hsl))?$/i.exec(s);
  const src = m[1].trim(), want = m[2] && m[2].toLowerCase();
  let rgb = null, from = null;
  let x;
  if ((x = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(src))) {
    const h = x[1].length === 3 ? x[1].replace(/./g, '$&$&') : x[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    from = 'hex';
  } else if ((x = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(src))) {
    rgb = [x[1], x[2], x[3]].map(Number);
    if (rgb.some((v) => v > 255)) return null;
    from = 'rgb';
  } else if ((x = /^hsla?\(\s*(\d{1,3}(?:\.\d+)?)(?:deg)?\s*[, ]\s*(\d{1,3}(?:\.\d+)?)%\s*[, ]\s*(\d{1,3}(?:\.\d+)?)%\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(src))) {
    const hsl = [Number(x[1]) % 360, Number(x[2]), Number(x[3])];
    if (hsl[1] > 100 || hsl[2] > 100) return null;
    rgb = hslToRgb(hsl);
    from = 'hsl';
  } else return null;
  const all = { hex: toHex(rgb).toUpperCase(), rgb: rgbText(rgb), hsl: hslText(rgbToHsl(rgb)) };
  const main = want && want !== from ? want : from === 'hex' ? 'rgb' : 'hex';
  const alts = ['hex', 'rgb', 'hsl'].filter((k) => k !== main && k !== from).map((k) => all[k]);
  return { kind: 'color', value: all[main], copy: all[main], expr: `${from === 'hex' ? all.hex : src} = ${all[main]}`, alts, swatch: toHex(rgb) };
}

// ---------------------------------------------------------------- number bases
const BASES = { hex: 16, hexadecimal: 16, bin: 2, binary: 2, oct: 8, octal: 8, dec: 10, decimal: 10 };
const PREFIX = { 16: '0x', 2: '0b', 8: '0o', 10: '' };
function readInt(w) {
  const m = /^(-)?(?:0x([0-9a-f]+)|0b([01]+)|0o([0-7]+)|(\d+))$/i.exec(w);
  if (!m) return null;
  const [, neg, hx, bn, oc, dc] = m;
  const n = hx ? parseInt(hx, 16) : bn ? parseInt(bn, 2) : oc ? parseInt(oc, 8) : parseInt(dc, 10);
  if (!Number.isSafeInteger(n)) return null;
  return { n: neg ? -n : n, base: hx ? 16 : bn ? 2 : oc ? 8 : 10 };
}
const inBase = (n, b) => (n < 0 ? '-' : '') + PREFIX[b] + Math.abs(n).toString(b).toUpperCase();
function base(s) {
  let m, num, to;
  if ((m = /^(\S+) (?:in|to|as|into|en|a|в) (\w+)$/i.exec(s)) && BASES[m[2].toLowerCase()]) { num = readInt(m[1]); to = BASES[m[2].toLowerCase()]; }
  else if ((m = /^(\w+) (\S+)$/i.exec(s)) && BASES[m[1].toLowerCase()]) { num = readInt(m[2]); to = BASES[m[1].toLowerCase()]; }
  else if (/^-?0[xbo]/i.test(s)) { num = readInt(s); to = 10; }
  if (!num || (to === num.base && num.base === 10)) return null;
  const value = inBase(num.n, to);
  const alts = [10, 16, 2, 8].filter((b) => b !== to && b !== num.base).map((b) => inBase(num.n, b));
  return { kind: 'base', value, copy: value, expr: `${inBase(num.n, num.base)} = ${value}`, alts };
}

// ---------------------------------------------------------------- time zones
// Common places by name (English, Spanish, Russian) and abbreviations; anything else is looked up among the
// time zones the browser knows (Intl.supportedValuesOf): "Europe/Paris", or just "Paris".
const ZONE_ALIAS = {
  'new york': 'America/New_York', nyc: 'America/New_York', 'nueva york': 'America/New_York', 'нью-йорк': 'America/New_York', 'нью йорк': 'America/New_York',
  'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', sf: 'America/Los_Angeles', seattle: 'America/Los_Angeles', 'лос-анджелес': 'America/Los_Angeles',
  chicago: 'America/Chicago', dallas: 'America/Chicago', houston: 'America/Chicago', denver: 'America/Denver', boston: 'America/New_York',
  washington: 'America/New_York', miami: 'America/New_York', toronto: 'America/Toronto', vancouver: 'America/Vancouver', 'mexico city': 'America/Mexico_City',
  'ciudad de méxico': 'America/Mexico_City', 'ciudad de mexico': 'America/Mexico_City', cdmx: 'America/Mexico_City', 'buenos aires': 'America/Argentina/Buenos_Aires',
  'são paulo': 'America/Sao_Paulo', 'sao paulo': 'America/Sao_Paulo', 'rio de janeiro': 'America/Sao_Paulo', lima: 'America/Lima', bogota: 'America/Bogota', 'bogotá': 'America/Bogota', santiago: 'America/Santiago',
  london: 'Europe/London', londres: 'Europe/London', 'лондон': 'Europe/London', paris: 'Europe/Paris', 'parís': 'Europe/Paris', 'париж': 'Europe/Paris',
  berlin: 'Europe/Berlin', 'berlín': 'Europe/Berlin', 'берлин': 'Europe/Berlin', madrid: 'Europe/Madrid', 'мадрид': 'Europe/Madrid', barcelona: 'Europe/Madrid', rome: 'Europe/Rome', roma: 'Europe/Rome', 'рим': 'Europe/Rome',
  amsterdam: 'Europe/Amsterdam', brussels: 'Europe/Brussels', vienna: 'Europe/Vienna', zurich: 'Europe/Zurich', stockholm: 'Europe/Stockholm', oslo: 'Europe/Oslo', warsaw: 'Europe/Warsaw', prague: 'Europe/Prague',
  athens: 'Europe/Athens', atenas: 'Europe/Athens', 'афины': 'Europe/Athens', istanbul: 'Europe/Istanbul', 'estambul': 'Europe/Istanbul', 'стамбул': 'Europe/Istanbul', kyiv: 'Europe/Kyiv', kiev: 'Europe/Kyiv', 'киев': 'Europe/Kyiv',
  moscow: 'Europe/Moscow', 'moscú': 'Europe/Moscow', 'москва': 'Europe/Moscow', 'санкт-петербург': 'Europe/Moscow', 'st petersburg': 'Europe/Moscow', 'петербург': 'Europe/Moscow', lisbon: 'Europe/Lisbon', lisboa: 'Europe/Lisbon', dublin: 'Europe/Dublin',
  dubai: 'Asia/Dubai', 'dubái': 'Asia/Dubai', 'дубай': 'Asia/Dubai', mumbai: 'Asia/Kolkata', kolkata: 'Asia/Kolkata', calcutta: 'Asia/Kolkata', delhi: 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', bangalore: 'Asia/Kolkata', india: 'Asia/Kolkata',
  singapore: 'Asia/Singapore', singapur: 'Asia/Singapore', 'сингапур': 'Asia/Singapore', 'hong kong': 'Asia/Hong_Kong', beijing: 'Asia/Shanghai', 'pekín': 'Asia/Shanghai', 'пекин': 'Asia/Shanghai', shanghai: 'Asia/Shanghai',
  tokyo: 'Asia/Tokyo', tokio: 'Asia/Tokyo', 'токио': 'Asia/Tokyo', seoul: 'Asia/Seoul', 'seúl': 'Asia/Seoul', 'сеул': 'Asia/Seoul', bangkok: 'Asia/Bangkok', jakarta: 'Asia/Jakarta', manila: 'Asia/Manila',
  sydney: 'Australia/Sydney', 'sídney': 'Australia/Sydney', 'сидней': 'Australia/Sydney', melbourne: 'Australia/Melbourne', perth: 'Australia/Perth', auckland: 'Pacific/Auckland', honolulu: 'Pacific/Honolulu', hawaii: 'Pacific/Honolulu',
  cairo: 'Africa/Cairo', 'el cairo': 'Africa/Cairo', johannesburg: 'Africa/Johannesburg', lagos: 'Africa/Lagos', nairobi: 'Africa/Nairobi', 'tel aviv': 'Asia/Jerusalem', jerusalem: 'Asia/Jerusalem',
  almaty: 'Asia/Almaty', 'алматы': 'Asia/Almaty', tbilisi: 'Asia/Tbilisi', yerevan: 'Asia/Yerevan', minsk: 'Europe/Minsk', 'минск': 'Europe/Minsk', 'новосибирск': 'Asia/Novosibirsk', 'владивосток': 'Asia/Vladivostok', 'екатеринбург': 'Asia/Yekaterinburg',
  utc: 'UTC', gmt: 'UTC', z: 'UTC', zulu: 'UTC',
  est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York', cst: 'America/Chicago', cdt: 'America/Chicago', ct: 'America/Chicago',
  mst: 'America/Denver', mdt: 'America/Denver', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles',
  bst: 'Europe/London', cet: 'Europe/Paris', cest: 'Europe/Paris', eet: 'Europe/Athens', eest: 'Europe/Athens', msk: 'Europe/Moscow', ist: 'Asia/Kolkata', jst: 'Asia/Tokyo', kst: 'Asia/Seoul', aest: 'Australia/Sydney', aedt: 'Australia/Sydney',
};
let zoneIndex = null; // lower-case name -> IANA zone (the full name, and its city part)
function zones() {
  if (zoneIndex) return zoneIndex;
  zoneIndex = new Map();
  let all = [];
  try { all = Intl.supportedValuesOf('timeZone'); } catch {}
  for (const z of all) {
    zoneIndex.set(z.toLowerCase(), z);
    const city = z.split('/').pop().replace(/_/g, ' ').toLowerCase();
    if (!zoneIndex.has(city)) zoneIndex.set(city, z);
  }
  return zoneIndex;
}
const validZone = (z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };
const placeName = (z) => (z === 'UTC' ? 'UTC' : z.split('/').pop().replace(/_/g, ' '));
// A place -> { zone, place } or null. "UTC+3" / "GMT-5" for whole hours (Etc/GMT zones; their sign is reversed).
export function resolveZone(name, localZ = 'UTC') {
  const n = String(name || '').trim().toLowerCase().replace(/[?.!]+$/, '');
  if (!n) return null;
  if (/^(here|local|aquí|aqui|здесь)$/.test(n)) return { zone: localZ, place: placeName(localZ) };
  const off = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})$/.exec(n);
  if (off) {
    const h = Number(off[2]);
    if (h > 14) return null;
    const zone = h === 0 ? 'UTC' : `Etc/GMT${off[1] === '+' ? '-' : '+'}${h}`;
    return validZone(zone) ? { zone, place: `UTC${off[1]}${h}` } : null;
  }
  const alias = ZONE_ALIAS[n];
  if (alias) return validZone(alias) ? { zone: alias, place: alias === 'UTC' ? 'UTC' : titleCase(n.length <= 4 ? placeName(alias) : n) } : null;
  const z = zones().get(n) || zones().get(n.replace(/ /g, '_'));
  return z ? { zone: z, place: placeName(z) } : null;
}
const titleCase = (s) => s.replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

const dtfs = new Map();
function dtf(lang, opts) {
  const k = lang + JSON.stringify(opts);
  let f = dtfs.get(k);
  if (!f) {
    try { f = new Intl.DateTimeFormat(lang, opts); } catch { f = new Intl.DateTimeFormat('en', opts); }
    if (dtfs.size > 50) dtfs.clear();
    dtfs.set(k, f);
  }
  return f;
}
// The wall clock in `zone` at `ms`: { y, mo (0-11), d, h, mi }.
function wall(zone, ms) {
  const p = {};
  for (const x of dtf('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms)) p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
// Minutes `zone` is ahead of UTC at `ms`.
export function zoneOffset(zone, ms) {
  const w = wall(zone, ms);
  return Math.round((Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000) / 60000);
}
// The moment the clock in `zone` shows y-mo-d h:mi.
function instantOf(zone, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - zoneOffset(zone, guess) * 60000;
  return guess - zoneOffset(zone, first) * 60000;
}
const offText = (min) => { const a = Math.abs(min); return 'UTC' + (min < 0 ? '−' : '+') + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''); };

const TIME_WORD = '(?:time|now|hora|время|сейчас)';
const IN = '(?:in|at|to|en|a|в|во)';
const CLOCK = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?|noon|midnight|mediod[ií]a|medianoche|полдень|полночь';
function readClock(m) {
  const w = m[0].toLowerCase();
  if (/^(noon|mediod[ií]a|полдень)/.test(w)) return { h: 12, mi: 0 };
  if (/^(midnight|medianoche|полночь)/.test(w)) return { h: 0, mi: 0 };
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0, ap = m[3] && m[3][0].toLowerCase();
  if (!m[2] && !ap) return null; // "3 London in Tokyo": too likely something else
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'p' ? 12 : 0); }
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}
function timeZone(s, { lang, now, zone: localZ }) {
  let m, target, at = now, from = null;
  if ((m = new RegExp(`^(?:what(?:'s| is) the )?${TIME_WORD}(?: ${IN})? (.+)$`, 'i').exec(s))) target = resolveZone(m[1], localZ);
  else if ((m = new RegExp(`^(.+?) ${TIME_WORD}$`, 'i').exec(s))) target = resolveZone(m[1], localZ);
  else if ((m = new RegExp(`^(${CLOCK})(?: (.+?))? ${IN} (.+)$`, 'i').exec(s))) {
    const clock = readClock(m.slice(1));
    if (!clock) return null;
    from = m[5] ? resolveZone(m[5], localZ) : { zone: localZ, place: placeName(localZ) };
    target = resolveZone(m[6], localZ);
    if (!from || !target) return null;
    const today = wall(from.zone, now);
    at = instantOf(from.zone, today.y, today.mo, today.d, clock.h, clock.mi);
  } else return null;
  if (!target) return null;
  const value = dtf(lang, { timeZone: target.zone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at);
  const fromText = from ? dtf(lang, { timeZone: from.zone, hour: 'numeric', minute: '2-digit' }).format(at) + ' ' + from.place : null;
  return {
    kind: 'time', value, copy: value, place: target.place, zone: target.zone, offset: offText(zoneOffset(target.zone, at)), at,
    expr: (fromText ? fromText + ' = ' : '') + value + ' ' + target.place,
  };
}

// ---------------------------------------------------------------- dates
const DAY = 864e5;
const TODAY = /^(today|hoy|сегодня|now)$/i, TOMORROW = /^(tomorrow|mañana|manana|завтра)$/i, YESTERDAY = /^(yesterday|ayer|вчера)$/i;
// A day as a UTC midnight (dates have no time zone here: "today" is today where you are).
function readDate(w, today) {
  if (TODAY.test(w)) return today;
  if (TOMORROW.test(w)) return today + DAY;
  if (YESTERDAY.test(w)) return today - DAY;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(w);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const t = Date.UTC(y, mo, d);
  const back = new Date(t);
  return back.getUTCMonth() === mo && back.getUTCDate() === d && y >= 1 ? t : null; // 2026-02-30 is no date
}
const DATE_UNITS = [
  [/^(days?|d|d[ií]as?|дней|дня|день|д)$/i, 'day'], [/^(weeks?|w|wk|semanas?|недел[ьяи]|нед)$/i, 'week'],
  [/^(months?|mo|mes(es)?|месяц(ев|а)?|мес)$/i, 'month'], [/^(years?|y|yr|a[ñn]os?|лет|года?|г)$/i, 'year'],
];
// Add months the calendar way; a day the month doesn't have becomes its last day (Jan 31 + 1 month = Feb 28).
function addTo(t, n, unitName) {
  if (unitName === 'day') return t + n * DAY;
  if (unitName === 'week') return t + n * 7 * DAY;
  const d = new Date(t), months = unitName === 'year' ? n * 12 : n;
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return Date.UTC(y, mo, Math.min(d.getUTCDate(), last));
}
const iso = (t) => new Date(t).toISOString().slice(0, 10);
function dateCalc(s, { lang, now, zone }) {
  const w = wall(zone, now);
  const today = Date.UTC(w.y, w.mo, w.d);
  let m;
  if ((m = /^(?:days?|d[ií]as?|дней|дня) (until|till|to|hasta|до|since|desde|с|после) (\S+)$/i.exec(s))) {
    const d = readDate(m[2], today);
    if (d === null) return null;
    const since = /^(since|desde|с|после)$/i.test(m[1]);
    const count = Math.round((since ? today - d : d - today) / DAY);
    return { kind: 'days', count, copy: String(count), expr: `${s} = ${count}` };
  }
  if ((m = /^(?:days? )?between (\S+) and (\S+)$/i.exec(s)) || (m = /^d[ií]as? entre (\S+) y (\S+)$/i.exec(s))) {
    const a = readDate(m[1], today), b = readDate(m[2], today);
    if (a === null || b === null) return null;
    const count = Math.abs(Math.round((b - a) / DAY));
    return { kind: 'days', count, copy: String(count), expr: `${s} = ${count}` };
  }
  if ((m = /^(\S+) ?([+-]) ?(\d{1,5}) ?(\S+)$/.exec(s))) {
    const d = readDate(m[1], today);
    const u = DATE_UNITS.find(([re]) => re.test(m[4]));
    if (d === null || !u) return null;
    const t = addTo(d, (m[2] === '-' ? -1 : 1) * Number(m[3]), u[1]);
    if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) return null;
    const value = dtf(lang, { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).format(t);
    return { kind: 'date', value, copy: iso(t), expr: `${s} = ${iso(t)}` };
  }
  return null;
}

// ---------------------------------------------------------------- units
// [family, symbol shown, factor to the family's base unit, ...names]. Temperatures convert by formula.
const U = [
  ['length', 'mm', 1e-3, 'mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres', 'мм', 'milímetros', 'milimetros'],
  ['length', 'cm', 1e-2, 'cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres', 'см', 'centímetros', 'centimetros'],
  ['length', 'm', 1, 'm', 'meter', 'meters', 'metre', 'metres', 'м', 'metro', 'metros', 'метр', 'метров', 'метра'],
  ['length', 'km', 1e3, 'km', 'kilometer', 'kilometers', 'kilometre', 'kilometres', 'км', 'kilómetros', 'kilometros', 'kilómetro', 'километр', 'километров', 'километра'],
  ['length', 'in', 0.0254, 'in', 'inch', 'inches', '"', 'pulgadas', 'pulgada', 'дюйм', 'дюймов', 'дюйма'],
  ['length', 'ft', 0.3048, 'ft', 'foot', 'feet', "'", 'pies', 'pie', 'фут', 'футов', 'фута'],
  ['length', 'yd', 0.9144, 'yd', 'yard', 'yards', 'yardas', 'ярд', 'ярдов'],
  ['length', 'mi', 1609.344, 'mi', 'mile', 'miles', 'millas', 'milla', 'миля', 'миль', 'мили'],
  ['length', 'nmi', 1852, 'nmi', 'nautical mile', 'nautical miles', 'millas náuticas', 'морская миля', 'морских миль'],
  ['mass', 'mg', 1e-6, 'mg', 'milligram', 'milligrams', 'мг'],
  ['mass', 'g', 1e-3, 'g', 'gram', 'grams', 'gramme', 'grammes', 'г', 'гр', 'gramos', 'gramo', 'грамм', 'граммов'],
  ['mass', 'kg', 1, 'kg', 'kilogram', 'kilograms', 'kilo', 'kilos', 'кг', 'kilogramos', 'килограмм', 'килограммов'],
  ['mass', 't', 1000, 't', 'tonne', 'tonnes', 'ton', 'tons', 'toneladas', 'тонна', 'тонн', 'т'],
  ['mass', 'oz', 0.028349523125, 'oz', 'ounce', 'ounces', 'onzas', 'onza', 'унция', 'унций'],
  ['mass', 'lb', 0.45359237, 'lb', 'lbs', 'pound', 'pounds', 'libras', 'libra', 'фунт', 'фунтов', 'фунта'],
  ['mass', 'st', 6.35029318, 'st', 'stone', 'stones'],
  ['temp', '°C', 0, 'c', '°c', 'ºc', 'celsius', 'centigrade', 'degc', 'цельсия', '°с', 'с'],
  ['temp', '°F', 0, 'f', '°f', 'ºf', 'fahrenheit', 'degf', 'фаренгейта'],
  ['temp', 'K', 0, 'k', 'kelvin', 'kelvins', 'кельвин', 'кельвинов'],
  ['volume', 'mL', 1e-3, 'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'мл', 'mililitros'],
  ['volume', 'cL', 1e-2, 'cl', 'centiliter', 'centilitre'],
  ['volume', 'dL', 1e-1, 'dl', 'deciliter', 'decilitre'],
  ['volume', 'L', 1, 'l', 'liter', 'liters', 'litre', 'litres', 'л', 'litros', 'litro', 'литр', 'литров', 'литра'],
  ['volume', 'm³', 1000, 'm3', 'cubic meter', 'cubic meters', 'cubic metre', 'cubic metres', 'м3'],
  ['volume', 'tsp', 0.00492892159375, 'tsp', 'teaspoon', 'teaspoons'],
  ['volume', 'tbsp', 0.01478676478125, 'tbsp', 'tablespoon', 'tablespoons'],
  ['volume', 'fl oz', 0.0295735295625, 'fl oz', 'floz', 'fluid ounce', 'fluid ounces'],
  ['volume', 'cup', 0.2365882365, 'cup', 'cups', 'tazas', 'taza'],
  ['volume', 'pt', 0.473176473, 'pt', 'pint', 'pints', 'pintas'],
  ['volume', 'qt', 0.946352946, 'qt', 'quart', 'quarts'],
  ['volume', 'gal', 3.785411784, 'gal', 'gallon', 'gallons', 'galones', 'galón', 'галлон', 'галлонов'],
  ['area', 'mm²', 1e-6, 'mm2'],
  ['area', 'cm²', 1e-4, 'cm2', 'см2'],
  ['area', 'm²', 1, 'm2', 'square meter', 'square meters', 'square metre', 'square metres', 'sqm', 'м2', 'metros cuadrados'],
  ['area', 'km²', 1e6, 'km2', 'square kilometer', 'square kilometers', 'square kilometre', 'square kilometres', 'км2'],
  ['area', 'ha', 1e4, 'ha', 'hectare', 'hectares', 'hectáreas', 'hectareas', 'га', 'гектар', 'гектаров'],
  ['area', 'ac', 4046.8564224, 'ac', 'acre', 'acres'],
  ['area', 'in²', 0.00064516, 'in2', 'sq in', 'square inch', 'square inches'],
  ['area', 'ft²', 0.09290304, 'ft2', 'sq ft', 'sqft', 'square foot', 'square feet'],
  ['area', 'yd²', 0.83612736, 'yd2', 'sq yd', 'square yard', 'square yards'],
  ['area', 'mi²', 2589988.110336, 'mi2', 'sq mi', 'square mile', 'square miles'],
  ['speed', 'm/s', 1, 'm/s', 'mps', 'meters per second', 'metres per second', 'м/с'],
  ['speed', 'km/h', 1 / 3.6, 'km/h', 'kmh', 'kph', 'km per hour', 'kilometers per hour', 'kilometres per hour', 'км/ч'],
  ['speed', 'mph', 0.44704, 'mph', 'mi/h', 'miles per hour'],
  ['speed', 'kn', 0.514444444444, 'kn', 'kt', 'knot', 'knots', 'nudos', 'узел', 'узлов'],
  ['speed', 'ft/s', 0.3048, 'ft/s', 'fps', 'feet per second'],
  ['data', 'bit', 0.125, 'bit', 'bits', 'бит'],
  ['data', 'kbit', 125, 'kbit', 'kbits', 'kilobit', 'kilobits', 'кбит'],
  ['data', 'Mbit', 125e3, 'mbit', 'mbits', 'megabit', 'megabits', 'мбит'],
  ['data', 'Gbit', 125e6, 'gbit', 'gbits', 'gigabit', 'gigabits', 'гбит'],
  ['data', 'B', 1, 'b', 'byte', 'bytes', 'байт', 'байта', 'байтов'],
  ['data', 'kB', 1e3, 'kb', 'kilobyte', 'kilobytes', 'кб'],
  ['data', 'MB', 1e6, 'mb', 'megabyte', 'megabytes', 'мб'],
  ['data', 'GB', 1e9, 'gb', 'gigabyte', 'gigabytes', 'гб'],
  ['data', 'TB', 1e12, 'tb', 'terabyte', 'terabytes', 'тб'],
  ['data', 'PB', 1e15, 'pb', 'petabyte', 'petabytes'],
  ['data', 'KiB', 1024, 'kib', 'kibibyte', 'kibibytes'],
  ['data', 'MiB', 1024 ** 2, 'mib', 'mebibyte', 'mebibytes'],
  ['data', 'GiB', 1024 ** 3, 'gib', 'gibibyte', 'gibibytes'],
  ['data', 'TiB', 1024 ** 4, 'tib', 'tebibyte', 'tebibytes'],
  ['data', 'PiB', 1024 ** 5, 'pib', 'pebibyte', 'pebibytes'],
  ['time', 'ms', 1e-3, 'ms', 'millisecond', 'milliseconds', 'мс'],
  ['time', 's', 1, 's', 'sec', 'secs', 'second', 'seconds', 'segundos', 'segundo', 'с', 'сек', 'секунд', 'секунды'],
  ['time', 'min', 60, 'min', 'mins', 'minute', 'minutes', 'minutos', 'minuto', 'мин', 'минут', 'минуты'],
  ['time', 'h', 3600, 'h', 'hr', 'hrs', 'hour', 'hours', 'horas', 'hora', 'ч', 'час', 'часа', 'часов'],
  ['time', 'd', 86400, 'd', 'day', 'days', 'días', 'dias', 'día', 'дн', 'день', 'дня', 'дней'],
  ['time', 'wk', 604800, 'wk', 'week', 'weeks', 'semanas', 'semana', 'нед', 'неделя', 'недели', 'недель'],
  ['time', 'mo', 2629746, 'month', 'months', 'meses', 'mes', 'месяц', 'месяца', 'месяцев'],
  ['time', 'yr', 31556952, 'yr', 'year', 'years', 'años', 'año', 'год', 'года', 'лет'],
];
const UNITS = new Map();
for (const [family, sym, factor, ...names] of U) {
  const u = { family, sym, factor };
  for (const n of names) if (!UNITS.has(n)) UNITS.set(n, u); // the first family named wins (с: Celsius before seconds)
}
// Russian "с" is listed for Celsius first; as a lone unit after a number it means seconds far more often.
UNITS.set('с', UNITS.get('сек'));
// Where "10 km" alone converts to.
const DEFAULT_TO = { km: 'mi', mi: 'km', m: 'ft', ft: 'm', cm: 'in', in: 'cm', kg: 'lb', lb: 'kg', g: 'oz', oz: 'g', '°C': '°F', '°F': '°C', K: '°C', L: 'gal', gal: 'L', 'km/h': 'mph', mph: 'km/h', 'm²': 'ft²', 'ft²': 'm²', ha: 'ac', ac: 'ha' };
const bySym = new Map(U.map(([family, sym, factor]) => [sym, { family, sym, factor }]));

export function unitOf(name) {
  let n = String(name || '').trim().toLowerCase().replace(/\.$/, '').replace(/²/g, '2').replace(/³/g, '3').replace(/^degrees? /, '°').replace(/^grados? /, '°').replace(/^градус(ов|а)? /, '°');
  n = n.replace(/^(sq|square) (\S+)$/, (m, a, b) => (UNITS.has(b) && UNITS.get(b).family === 'length' ? UNITS.get(b).sym.toLowerCase() + '2' : m));
  n = n.replace(/^cubic (\S+)$/, (m, b) => (UNITS.get(b) && UNITS.get(b).sym === 'm' ? 'm3' : m));
  return UNITS.get(n) || UNITS.get(n.replace(/^°/, '')) || null;
}
function convert(x, a, b) {
  if (a.family !== 'temp') return (x * a.factor) / b.factor;
  const c = a.sym === '°C' ? x : a.sym === '°F' ? (x - 32) * 5 / 9 : x - 273.15;
  return b.sym === '°C' ? c : b.sym === '°F' ? c * 9 / 5 + 32 : c + 273.15;
}
const NUM = /^(-?\d[\d.,]*)\s*(.*)$/;
function unit(s, { lang }) {
  const m = NUM.exec(s);
  if (!m || !m[2]) return null;
  const x = (m[1].startsWith('-') ? -1 : 1) * parseNumber(m[1].replace(/^-/, ''), lang);
  if (!Number.isFinite(x)) return null;
  const words = m[2].split(' ');
  let from = null, to = null;
  // "10 km in mi", "10km to miles": split at the word that joins them...
  for (let i = 1; i < words.length - 1 && !from; i++) {
    if (!CONNECT.test(words[i])) continue;
    const a = unitOf(words.slice(0, i).join(' ')), b = unitOf(words.slice(i + 1).join(' '));
    if (a && b && a.family === b.family) { from = a; to = b; }
  }
  if (!from && words.length > 1 && CONNECT.test(words[words.length - 1])) return null; // "10 km in": still being typed
  // ...or anywhere between two units of the same kind ("5 lb kg", "10 sq ft m2")...
  for (let i = 1; i < words.length && !from; i++) {
    const a = unitOf(words.slice(0, i).join(' ')), b = unitOf(words.slice(i).join(' '));
    if (a && b && a.family === b.family) { from = a; to = b; }
  }
  // ...or a unit alone, to its usual counterpart ("10 km" -> miles).
  if (!from) {
    const a = unitOf(m[2]);
    if (!a || !DEFAULT_TO[a.sym]) return null;
    from = a; to = bySym.get(DEFAULT_TO[a.sym]);
  }
  if (from.family !== 'temp' && from.sym === to.sym) return null;
  const y = convert(x, from, to);
  if (!Number.isFinite(y)) return null;
  const out = formatNumber(y, lang, 6), inp = formatNumber(x, lang, 12);
  const sp = (sym) => (sym.startsWith('°') ? '' : ' ');
  const value = out.shown + sp(to.sym) + to.sym;
  return { kind: 'unit', value, copy: out.plain + sp(to.sym) + to.sym, expr: `${inp.shown}${sp(from.sym)}${from.sym} = ${value}`, from: from.sym, to: to.sym, family: from.family };
}

// ---------------------------------------------------------------- arithmetic
// Grammar (lowest first):  sum := product (('+' | '-') product)*      a + b% is a plus b percent of a
//                          product := unary (('*' | '/' | '%' | 'of' | implicit) unary)*   '%' here is modulo
//                          unary := ('-' | '+') unary | power         so -2^2 = -4
//                          power := postfix ('^' unary)?              right-associative: 2^3^2 = 2^9
//                          postfix := primary '%'?                    15% = 0.15 (marked as a percentage)
//                          primary := number | pi | π | e | func primary | '(' sum ')' | '√' primary
const FUNCS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: (x) => Math.sin((x * Math.PI) / 180), cos: (x) => Math.cos((x * Math.PI) / 180), tan: (x) => Math.tan((x * Math.PI) / 180),
  ln: Math.log, log: Math.log10, exp: Math.exp,
};
const CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E };
function tokenize(s, lang) {
  const out = [];
  const src = s.replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/\*\*/g, '^');
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === ' ') { i++; continue; }
    let m;
    if ((m = /^\d[\d.,]*/.exec(src.slice(i)))) {
      const n = parseNumber(m[0], lang);
      if (!Number.isFinite(n)) return null;
      out.push({ t: 'num', v: n });
      i += m[0].length;
    } else if ((m = /^[a-zπ]+/i.exec(src.slice(i)))) {
      const w = m[0].toLowerCase();
      if (w === 'of' || w === 'de' || w === 'от') out.push({ t: 'of' });
      else if (w === 'mod') out.push({ t: 'op', v: '%' });
      else if (FUNCS[w]) out.push({ t: 'fn', v: w });
      else if (w in CONSTS) out.push({ t: 'num', v: CONSTS[w], c: true });
      else return null;
      i += m[0].length;
    } else if ('+-*/^%()√'.includes(c)) { out.push(c === '(' || c === ')' ? { t: c } : c === '√' ? { t: 'fn', v: 'sqrt' } : { t: 'op', v: c }); i++; }
    else return null;
    if (out.length > 120) return null;
  }
  return out;
}
function parseExpr(tokens) {
  let i = 0, depth = 0, ops = 0;
  const peek = () => tokens[i];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const startsOperand = (tk) => !!tk && (tk.t === 'num' || tk.t === '(' || tk.t === 'fn');
  function sum() {
    let a = product();
    while (isOp('+') || isOp('-')) {
      const op = tokens[i++].v; ops++;
      const b = product();
      const v = b.pct ? a.v * b.v : b.v; // 80 + 15% = 92
      a = { v: op === '+' ? a.v + v : a.v - v };
    }
    return a;
  }
  function product() {
    let a = unary();
    for (;;) {
      const tk = peek();
      if (tk && tk.t === 'op' && (tk.v === '*' || tk.v === '/' || tk.v === '%')) {
        i++; ops++;
        const b = unary();
        a = { v: tk.v === '*' ? a.v * b.v : tk.v === '/' ? a.v / b.v : a.v % b.v };
      } else if (tk && tk.t === 'of') { // 15% of 80
        i++; ops++;
        a = { v: a.v * unary().v };
      } else if (tk && (tk.t === '(' || tk.t === 'fn' || (tk.t === 'num' && tk.c))) { // 2pi, 3(4 + 1), 2 sqrt 9
        ops++;
        a = { v: a.v * unary().v };
      } else return a;
    }
  }
  function unary() {
    if (isOp('-')) { i++; const x = unary(); return { v: -x.v, pct: x.pct }; }
    if (isOp('+')) { i++; return unary(); }
    return power();
  }
  function power() {
    const a = postfix();
    if (!isOp('^')) return a;
    i++; ops++;
    const b = unary(); // right-associative, and 2^-1 works
    return { v: a.v ** b.v };
  }
  function postfix() {
    const a = primary();
    // "15%" is a percentage unless an operand follows ("10 % 3" is modulo).
    if (isOp('%') && !startsOperand(tokens[i + 1])) { i++; ops++; return { v: a.v / 100, pct: true }; }
    return a;
  }
  function primary() {
    const tk = tokens[i++];
    if (!tk) throw new Error('end');
    if (tk.t === 'num') return { v: tk.v };
    if (tk.t === 'fn') { ops++; if (++depth > 60) throw new Error('deep'); const x = FUNCS[tk.v](tk.t === 'fn' && peek() && peek().t === '(' ? primary().v : unary().v); depth--; return { v: x }; }
    if (tk.t === '(') {
      if (++depth > 60) throw new Error('deep');
      const a = sum();
      if (!peek() || peek().t !== ')') throw new Error('paren');
      i++; depth--;
      return { v: a.v };
    }
    throw new Error('unexpected');
  }
  const r = sum();
  if (i !== tokens.length) throw new Error('trailing');
  return { v: r.v, ops };
}
function calc(s, { lang }) {
  if (/^\d+(-\d+)+$/.test(s)) return null; // a date or a phone number ("555-1234"), not a sum: "7 - 3" has spaces
  const tokens = tokenize(s, lang);
  if (!tokens || !tokens.length) return null;
  const lone = tokens.length === 1 && tokens[0].c && /^(pi|π)$/i.test(s);
  const r = parseExpr(tokens);
  if ((!r.ops && !lone) || !Number.isFinite(r.v)) return null;
  const { shown, plain } = formatNumber(r.v, lang, 12);
  return { kind: 'calc', value: shown, copy: plain, expr: `${s} = ${shown}` };
}
