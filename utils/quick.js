// Quick answers for the command palette: arithmetic, percentages, unit conversions, number bases, colours,
// time zones and dates, worked out locally from what was typed. Pure: no DOM, no chrome.*, no network, and
// no eval / Function (arithmetic goes through the small parser below). Never throws: anything it doesn't
// understand, or that comes out as not a finite number, is null.
//
//   quick('10 km in mi', { lang: 'en' }) -> { kind: 'unit', value: '6.21371 mi', copy: '6.21371 mi', expression: '10 km = 6.21371 mi' }
//
// A result: { kind, value, copy, expr, ... }
//   kind   'calc' | 'unit' | 'base' | 'color' | 'time' | 'date' | 'days' | 'currency'
//   value  what the row shows big, formatted for `lang` (Intl.NumberFormat / DateTimeFormat); for 'days', `count` instead
//   copy   what Enter copies: numbers as plain digits with a dot ("1234.5", no grouping, no exponent: 1/10000000
//          copies "0.0000001"; pastes anywhere), a unit result with its symbol, a date as YYYY-MM-DD, anything else as shown
//   expr   the whole thing ("80 + 15% = 92"), for the row's "copy expression" button
//   alts   (colour, base) the same value in other notations; swatch (colour) '#rrggbb'; place, zone (time)
// 'currency' has nothing else: exchange rates need the internet, which Tabazing never uses.
//
// Precision: calculations are rounded to 12 significant digits (0.1 + 0.2 shows 0.3), conversions to 6
// ("10 km in mi" -> 6.21371). From 1e15 up, and below 1e-6, numbers show in scientific notation. A sum that
// cancels out to float leftovers is 0 (0.3 - 0.1 - 0.2 = 0, not -2.78E-17). Typed "2e10" / "1e-7" are numbers
// (a lone "2e" is still 2 × e).
// Numbers may use thousands separators: "1,234.5" and "1.234,5" both work; a lone comma is the decimal mark
// ("1,5" = 1.5), except where the decimal mark is a dot (English, Hebrew, Arabic): there "1,234" (groups of three) is a thousand.
// Thousands never start with 0: "0,500" is 0.5 everywhere, "0.001.000" is nothing.
// Trigonometry is in degrees, exact where the answer is: sin(30) = 0.5, cos(90) = 0, tan(90) is nothing.
// Dates run from 0001-01-01 to 9999-12-31; an expression with a date in it ("2024-01-05 + 3", "12/25/2024") isn't arithmetic.

const MAX_LENGTH = 200;

export function quick(text, { lang = 'en', now = Date.now(), zone = localTimeZone() } = {}) {
  try {
    const normalizedText = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
    if (!normalizedText || normalizedText.length > MAX_LENGTH) return null;
    const options = { lang, now, zone };
    for (const parser of [currency, color, base, timeZone, dateCalculation, unit, calculate]) {
      const result = parser(normalizedText, options);
      if (result) return result;
    }
    return null;
  } catch {
    return null;
  }
}

const localTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

// ---------------------------------------------------------------- numbers
// "1,234.5", "1.234,5", "1,5", "12" -> a number, or NaN. See the header for the comma rule.
export function parseNumber(value, lang = 'en') {
  const text = String(value);
  if (!/^\d[\d.,]*$/.test(text) || /[.,]$/.test(text)) return NaN;
  const dots = (text.match(/\./g) || []).length, commas = (text.match(/,/g) || []).length;
  let out = text;
  if (dots && commas) {
    const decimalSeparator = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const group = decimalSeparator === '.' ? ',' : '.';
    const [integerPart, fractionPart, extra] = text.split(decimalSeparator);
    if (extra !== undefined || !grouped(integerPart, group)) return NaN;
    out = integerPart.split(group).join('') + '.' + fractionPart;
  } else if (commas) {
    if (commas > 1 || (COMMA_GROUPS.has(lang) && grouped(text, ','))) { if (!grouped(text, ',')) return NaN; out = text.split(',').join(''); }
    else out = text.replace(',', '.');
  } else if (dots > 1) {
    if (!grouped(text, '.')) return NaN;
    out = text.split('.').join('');
  }
  return Number(out);
}
const COMMA_GROUPS = new Set(['en', 'he', 'ar']); // the languages that group with commas and use a decimal dot
// Groups of three after a first group that doesn't start with 0 ("0,001" and "012,345" aren't thousands).
const grouped = (text, separator) => new RegExp(`^[1-9]\\d{0,2}(\\${separator}\\d{3})+$`).test(text) || (!text.includes(separator) && /^\d+$/.test(text));

const formatters = new Map();
function numberFormat(lang, options) {
  const cacheKey = lang + JSON.stringify(options);
  let formatter = formatters.get(cacheKey);
  if (!formatter) {
    try { formatter = new Intl.NumberFormat(lang, options); } catch { formatter = new Intl.NumberFormat('en', options); }
    if (formatters.size > 50) formatters.clear();
    formatters.set(cacheKey, formatter);
  }
  return formatter;
}
// Rounded to `sig` significant digits: the shown text, and the plain one that is copied.
export function formatNumber(x, lang = 'en', significantDigits = 12) {
  const rounded = Number(x.toPrecision(significantDigits));
  const absolute = Math.abs(rounded);
  const scientific = absolute !== 0 && (absolute >= 1e15 || absolute < 1e-6);
  const shown = scientific ? numberFormat(lang, { notation: 'scientific', maximumSignificantDigits: Math.min(significantDigits, 10) }).format(rounded) : numberFormat(lang, { maximumSignificantDigits: significantDigits }).format(rounded);
  return { shown, plain: Object.is(rounded, -0) ? '0' : plainDigits(rounded) };
}
// String() without its exponent: 1.5e+21 -> "1500000000000000000000", 1e-7 -> "0.0000001".
function plainDigits(x) {
  const text = String(x), match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const digits = match[2] + (match[3] || ''), exponent = Number(match[4]);
  return match[1] + (exponent >= 0 ? digits.padEnd(exponent + 1, '0') : '0.' + '0'.repeat(-exponent - 1) + digits);
}
// a + b, or 0 when what is left is float noise against the size of a and b (1.1 * 3 - 3.3 leaves 4.4E-16).
function addExact(first, second, tolerance = 1e-12) {
  const sum = first + second;
  return Math.abs(sum) < Math.max(Math.abs(first), Math.abs(second)) * tolerance ? 0 : sum;
}

// ---------------------------------------------------------------- currency
const CURRENCY_CODES = 'usd eur gbp jpy rub cny chf cad aud nzd mxn brl inr krw sek nok dkk pln czk huf try uah kzt ars clp cop pen ils zar sgd hkd thb byn gel amd btc eth';
const CURRENCY = new Set(CURRENCY_CODES.split(' '));
const CURRENCY_WORD = /^(dollars?|euros?|yen|yuan|rubles?|roubles?|pesos?|rupees?|francs?|d[oó]lar(es)?|libras? esterlinas?|рубл[ьяей]*|доллар(ов|а|ы)?|евро|юан[ьяей]*|иен[аы]?|фунт(ов|а|ы)? стерлингов|bitcoins?)$/i;
const CURRENCY_SYMBOL = /^[$€£¥₽₹₩₺₴₸]$/;
const isCurrency = (word) => CURRENCY.has(word.toLowerCase()) || CURRENCY_WORD.test(word) || CURRENCY_SYMBOL.test(word);
const CONNECT = /^(in|to|into|as|=|->|→|en|a|в|во)$/i;
function currency(text) {
  // Symbols may touch the number ("$10", "10€"): set them apart first.
  const words = text.replace(/([$€£¥₽₹₩₺₴₸])/g, ' $1 ').trim().split(' ').filter(Boolean);
  let numberCount = 0, currencyCount = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (/^\d[\d.,]*$/.test(word)) numberCount++;
    else if (isCurrency(word)) currencyCount++;
    else if (i + 1 < words.length && isCurrency(word + ' ' + words[i + 1])) { currencyCount++; i++; }
    else if (!CONNECT.test(word)) return null;
  }
  return numberCount === 1 && currencyCount >= 1 ? { kind: 'currency' } : null;
}

// ---------------------------------------------------------------- colours
const twoHexDigits = (value) => value.toString(16).padStart(2, '0');
const toHex = ([red, green, blue]) => '#' + twoHexDigits(red) + twoHexDigits(green) + twoHexDigits(blue);
const rgbText = ([red, green, blue]) => `rgb(${red}, ${green}, ${blue})`;
const hslText = ([hue, saturation, lightness]) => `hsl(${hue}, ${saturation}%, ${lightness}%)`;
function rgbToHsl([red, green, blue]) {
  red /= 255; green /= 255; blue /= 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), lightness = (max + min) / 2, delta = max - min;
  let hue = 0, saturation = 0;
  if (delta) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    hue = max === red ? ((green - blue) / delta) % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return [Math.round(hue) % 360, Math.round(saturation * 100), Math.round(lightness * 100)];
}
function hslToRgb([hue, saturation, lightness]) {
  saturation /= 100; lightness /= 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation, x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1)), lightnessMatch = lightness - chroma / 2;
  const [red, green, blue] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [red, green, blue].map((channel) => Math.round((channel + lightnessMatch) * 255));
}
function color(text) {
  const match = /^(.+?)(?: (?:in|to|as|en|a|в) (hex|rgb|hsl))?$/i.exec(text);
  const source = match[1].trim(), want = match[2] && match[2].toLowerCase();
  let rgb = null, from = null;
  let x;
  if ((x = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(source))) {
    const hex = x[1].length === 3 ? x[1].replace(/./g, '$&$&') : x[1];
    rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    from = 'hex';
  } else if ((x = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(source))) {
    rgb = [x[1], x[2], x[3]].map(Number);
    if (rgb.some((channel) => channel > 255)) return null;
    from = 'rgb';
  } else if ((x = /^hsla?\(\s*(\d{1,3}(?:\.\d+)?)(?:deg)?\s*[, ]\s*(\d{1,3}(?:\.\d+)?)%\s*[, ]\s*(\d{1,3}(?:\.\d+)?)%\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(source))) {
    const hsl = [Number(x[1]) % 360, Number(x[2]), Number(x[3])];
    if (hsl[1] > 100 || hsl[2] > 100) return null;
    rgb = hslToRgb(hsl);
    from = 'hsl';
  } else return null;
  const all = { hex: toHex(rgb).toUpperCase(), rgb: rgbText(rgb), hsl: hslText(rgbToHsl(rgb)) };
  const main = want && want !== from ? want : from === 'hex' ? 'rgb' : 'hex';
  const alts = ['hex', 'rgb', 'hsl'].filter((key) => key !== main && key !== from).map((key) => all[key]);
  return { kind: 'color', value: all[main], copy: all[main], expression: `${from === 'hex' ? all.hex : source} = ${all[main]}`, alts, swatch: toHex(rgb) };
}

// ---------------------------------------------------------------- number bases
const BASES = { hex: 16, hexadecimal: 16, bin: 2, binary: 2, oct: 8, octal: 8, dec: 10, decimal: 10 };
const PREFIX = { 16: '0x', 2: '0b', 8: '0o', 10: '' };
function readInteger(word) {
  const match = /^(-)?(?:0x([0-9a-f]+)|0b([01]+)|0o([0-7]+)|(\d+))$/i.exec(word);
  if (!match) return null;
  const [, negative, hexDigits, binaryDigits, octalDigits, decimalDigits] = match;
  const value = hexDigits ? parseInt(hexDigits, 16) : binaryDigits ? parseInt(binaryDigits, 2) : octalDigits ? parseInt(octalDigits, 8) : parseInt(decimalDigits, 10);
  if (!Number.isSafeInteger(value)) return null;
  return { n: negative ? -value : value, base: hexDigits ? 16 : binaryDigits ? 2 : octalDigits ? 8 : 10 };
}
const inBase = (value, radix) => (value < 0 ? '-' : '') + PREFIX[radix] + Math.abs(value).toString(radix).toUpperCase();
function base(text) {
  let match, parsedNumber, to;
  if ((match = /^(\S+) (?:in|to|as|into|en|a|в) (\w+)$/i.exec(text)) && BASES[match[2].toLowerCase()]) { parsedNumber = readInteger(match[1]); to = BASES[match[2].toLowerCase()]; }
  else if ((match = /^(\w+) (\S+)$/i.exec(text)) && BASES[match[1].toLowerCase()]) { parsedNumber = readInteger(match[2]); to = BASES[match[1].toLowerCase()]; }
  else if (/^-?0[xbo]/i.test(text)) { parsedNumber = readInteger(text); to = 10; }
  if (!parsedNumber || to === parsedNumber.base) return null; // "0xff in hex" says nothing new
  const value = inBase(parsedNumber.n, to);
  const alts = [10, 16, 2, 8].filter((radix) => radix !== to && radix !== parsedNumber.base).map((radix) => inBase(parsedNumber.n, radix));
  return { kind: 'base', value, copy: value, expression: `${inBase(parsedNumber.n, parsedNumber.base)} = ${value}`, alts };
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
  for (const zone of all) {
    zoneIndex.set(zone.toLowerCase(), zone);
    const city = zone.split('/').pop().replace(/_/g, ' ').toLowerCase();
    if (!zoneIndex.has(city)) zoneIndex.set(city, zone);
  }
  return zoneIndex;
}
const validZone = (zone) => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } };
const placeName = (zone) => (zone === 'UTC' ? 'UTC' : zone.split('/').pop().replace(/_/g, ' '));
// A place -> { zone, place } or null. "UTC+3" / "GMT-5" for whole hours (Etc/GMT zones; their sign is reversed).
export function resolveZone(name, localZ = 'UTC') {
  const normalized = String(name || '').trim().toLowerCase().replace(/[?.!]+$/, '');
  if (!normalized) return null;
  if (/^(here|local|aquí|aqui|здесь)$/.test(normalized)) return { zone: localZ, place: placeName(localZ) };
  const offsetMatch = /^(?:utc|gmt)\s*([+\-−])\s*(\d{1,2})$/.exec(normalized); // "−" as the offsets are shown
  if (offsetMatch) {
    const hours = Number(offsetMatch[2]), sign = offsetMatch[1] === '+' ? '+' : '-';
    if (hours > 14) return null;
    const zone = hours === 0 ? 'UTC' : `Etc/GMT${sign === '+' ? '-' : '+'}${hours}`;
    return validZone(zone) ? { zone, place: `UTC${sign}${hours}` } : null;
  }
  const alias = ZONE_ALIAS[normalized];
  if (alias) return validZone(alias) ? { zone: alias, place: alias === 'UTC' ? 'UTC' : titleCase(normalized.length <= 4 ? placeName(alias) : normalized) } : null;
  const found = zones().get(normalized) || zones().get(normalized.replace(/ /g, '_'));
  return found ? { zone: found, place: placeName(found) } : null;
}
const titleCase = (text) => text.replace(/(^|[\s-])(\p{L})/gu, (match, prefix, letter) => prefix + letter.toUpperCase());

const dateTimeFormats = new Map();
function dateTimeFormat(lang, options) {
  const cacheKey = lang + JSON.stringify(options);
  let formatter = dateTimeFormats.get(cacheKey);
  if (!formatter) {
    try { formatter = new Intl.DateTimeFormat(lang, options); } catch { formatter = new Intl.DateTimeFormat('en', options); }
    if (dateTimeFormats.size > 50) dateTimeFormats.clear();
    dateTimeFormats.set(cacheKey, formatter);
  }
  return formatter;
}
// The wall clock in `zone` at `ms`: { y, mo (0-11), d, h, mi }.
function wallClock(zone, milliseconds) {
  const parts = {};
  for (const x of dateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(milliseconds)) parts[x.type] = Number(x.value);
  return { year: parts.year, month: parts.month - 1, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}
// Minutes `zone` is ahead of UTC at `ms`.
export function zoneOffset(zone, milliseconds) {
  const clock = wallClock(zone, milliseconds);
  return Math.round((Date.UTC(clock.year, clock.month, clock.day, clock.hour, clock.minute, clock.second) - Math.floor(milliseconds / 1000) * 1000) / 60000);
}
// The moment the clock in `zone` shows y-mo-d h:mi.
function instantOf(zone, y, month, day, hour, minute) {
  const guess = Date.UTC(y, month, day, hour, minute);
  const first = guess - zoneOffset(zone, guess) * 60000;
  return guess - zoneOffset(zone, first) * 60000;
}
const offsetText = (minutes) => { const absoluteMinutes = Math.abs(minutes); return 'UTC' + (minutes < 0 ? '−' : '+') + Math.floor(absoluteMinutes / 60) + (absoluteMinutes % 60 ? ':' + String(absoluteMinutes % 60).padStart(2, '0') : ''); };

const TIME_WORD = '(?:time|now|hora|время|сейчас)';
const PLACE_WORD = '(?:in|at|to|en|a|в|во)';
const CLOCK = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?|noon|midnight|mediod[ií]a|medianoche|полдень|полночь';
function readClock(match) {
  const word = match[0].toLowerCase();
  if (/^(noon|mediod[ií]a|полдень)/.test(word)) return { hour: 12, minute: 0 };
  if (/^(midnight|medianoche|полночь)/.test(word)) return { hour: 0, minute: 0 };
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0, meridiem = match[3] && match[3][0].toLowerCase();
  if (!match[2] && !meridiem) return null; // "3 London in Tokyo": too likely something else
  if (meridiem) { if (hour < 1 || hour > 12) return null; hour = (hour % 12) + (meridiem === 'p' ? 12 : 0); }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}
function timeZone(text, { lang, now, zone: localZ }) {
  let match, target, at = now, from = null;
  if ((match = new RegExp(`^(?:what(?:'s| is) the )?${TIME_WORD}(?: ${PLACE_WORD})? (.+)$`, 'i').exec(text))) target = resolveZone(match[1], localZ);
  else if ((match = new RegExp(`^(.+?) ${TIME_WORD}\\??$`, 'i').exec(text))) target = resolveZone(match[1], localZ);
  else if ((match = new RegExp(`^(${CLOCK})(?: (.+?))? ${PLACE_WORD} (.+)$`, 'i').exec(text))) {
    const clock = readClock(match.slice(1));
    if (!clock) return null;
    from = match[5] ? resolveZone(match[5], localZ) : { zone: localZ, place: placeName(localZ) };
    target = resolveZone(match[6], localZ);
    if (!from || !target) return null;
    const today = wallClock(from.zone, now);
    at = instantOf(from.zone, today.year, today.month, today.day, clock.hour, clock.minute);
  } else return null;
  if (!target) return null;
  const value = dateTimeFormat(lang, { timeZone: target.zone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at);
  const fromText = from ? dateTimeFormat(lang, { timeZone: from.zone, hour: 'numeric', minute: '2-digit' }).format(at) + ' ' + from.place : null;
  return {
    kind: 'time', value, copy: value, place: target.place, zone: target.zone, offset: offsetText(zoneOffset(target.zone, at)), at,
    expression: (fromText ? fromText + ' = ' : '') + value + ' ' + target.place,
  };
}

// ---------------------------------------------------------------- dates
const DAY = 864e5;
const TODAY = /^(today|hoy|сегодня|now)$/i, TOMORROW = /^(tomorrow|mañana|manana|завтра)$/i, YESTERDAY = /^(yesterday|ayer|вчера)$/i;
// UTC midnight of y-mo-d; unlike Date.UTC, years 0-99 stay themselves (not 1900-1999).
const utcTime = (y, month, day) => new Date(0).setUTCFullYear(y, month, day);
const inRange = (timestamp) => { const y = new Date(timestamp).getUTCFullYear(); return y >= 1 && y <= 9999; }; // what YYYY-MM-DD can write
// A day as a UTC midnight (dates have no time zone here: "today" is today where you are).
function readDate(word, today) {
  if (TODAY.test(word)) return today;
  if (TOMORROW.test(word)) return today + DAY;
  if (YESTERDAY.test(word)) return today - DAY;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(word);
  if (!match) return null;
  const [y, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const timestamp = utcTime(y, month, day);
  const back = new Date(timestamp);
  return back.getUTCMonth() === month && back.getUTCDate() === day && y >= 1 ? timestamp : null; // 2026-02-30 is no date
}
const DATE_UNITS = [
  [/^(days?|d|d[ií]as?|дней|дня|день|д)$/i, 'day'], [/^(weeks?|w|wk|semanas?|недел[ьяи]|нед)$/i, 'week'],
  [/^(months?|mo|mes(es)?|месяц(ев|а)?|мес)$/i, 'month'], [/^(years?|y|yr|a[ñn]os?|лет|года?|г)$/i, 'year'],
];
// Add months the calendar way; a day the month doesn't have becomes its last day (Jan 31 + 1 month = Feb 28).
function addTo(timestamp, amount, unitName) {
  if (unitName === 'day') return timestamp + amount * DAY;
  if (unitName === 'week') return timestamp + amount * 7 * DAY;
  const date = new Date(timestamp), months = unitName === 'year' ? amount * 12 : amount;
  const y = date.getUTCFullYear(), month = date.getUTCMonth() + months;
  const last = new Date(utcTime(y, month + 1, 0)).getUTCDate();
  return utcTime(y, month, Math.min(date.getUTCDate(), last));
}
const isoDate = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);
function dateCalculation(text, { lang, now, zone }) {
  const clock = wallClock(zone, now);
  const today = Date.UTC(clock.year, clock.month, clock.day);
  let match;
  if ((match = /^(?:days?|d[ií]as?|дней|дня) (until|till|to|hasta|до|since|desde|с|после) (\S+)$/i.exec(text))) {
    const date = readDate(match[2], today);
    if (date === null) return null;
    const since = /^(since|desde|с|после)$/i.test(match[1]);
    const count = Math.round((since ? today - date : date - today) / DAY);
    return { kind: 'days', count, copy: String(count), expression: `${text} = ${count}` };
  }
  if ((match = /^(?:days? )?between (\S+) and (\S+)$/i.exec(text)) || (match = /^d[ií]as? entre (\S+) y (\S+)$/i.exec(text))) {
    const firstDate = readDate(match[1], today), secondDate = readDate(match[2], today);
    if (firstDate === null || secondDate === null) return null;
    const count = Math.abs(Math.round((secondDate - firstDate) / DAY));
    return { kind: 'days', count, copy: String(count), expression: `${text} = ${count}` };
  }
  if ((match = /^(\S+) ?([+-]) ?(\d{1,5}) ?(\S+)$/.exec(text))) {
    const date = readDate(match[1], today);
    const unitEntry = DATE_UNITS.find(([pattern]) => pattern.test(match[4]));
    if (date === null || !unitEntry) return null;
    const newTimestamp = addTo(date, (match[2] === '-' ? -1 : 1) * Number(match[3]), unitEntry[1]);
    if (!Number.isFinite(newTimestamp) || !inRange(newTimestamp)) return null;
    const value = dateTimeFormat(lang, { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).format(newTimestamp);
    return { kind: 'date', value, copy: isoDate(newTimestamp), expression: `${text} = ${isoDate(newTimestamp)}` };
  }
  return null;
}

// ---------------------------------------------------------------- units
// [family, symbol shown, factor to the family's base unit, ...names]. Temperatures convert by formula.
const UNIT_TABLE = [
  ['length', 'mm', 1e-3, 'mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres', 'мм', 'milímetros', 'milimetros'],
  ['length', 'cm', 1e-2, 'cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres', 'см', 'centímetros', 'centimetros'],
  ['length', 'm', 1, 'm', 'meter', 'meters', 'metre', 'metres', 'м', 'metro', 'metros', 'метр', 'метров', 'метра', 'метры', 'метрах'],
  ['length', 'km', 1e3, 'km', 'kilometer', 'kilometers', 'kilometre', 'kilometres', 'км', 'kilómetros', 'kilometros', 'kilómetro', 'километр', 'километров', 'километра', 'километры', 'километрах'],
  ['length', 'in', 0.0254, 'in', 'inch', 'inches', '"', 'pulgadas', 'pulgada', 'дюйм', 'дюймов', 'дюйма', 'дюймы', 'дюймах'],
  ['length', 'ft', 0.3048, 'ft', 'foot', 'feet', "'", 'pies', 'pie', 'фут', 'футов', 'фута', 'футы', 'футах'],
  ['length', 'yd', 0.9144, 'yd', 'yard', 'yards', 'yardas', 'ярд', 'ярдов', 'ярда', 'ярды', 'ярдах'],
  ['length', 'mi', 1609.344, 'mi', 'mile', 'miles', 'millas', 'milla', 'миля', 'миль', 'мили', 'милях'],
  ['length', 'nmi', 1852, 'nmi', 'nautical mile', 'nautical miles', 'millas náuticas', 'морская миля', 'морских миль', 'морские мили', 'морских милях'],
  ['mass', 'mg', 1e-6, 'mg', 'milligram', 'milligrams', 'мг'],
  ['mass', 'g', 1e-3, 'g', 'gram', 'grams', 'gramme', 'grammes', 'г', 'гр', 'gramos', 'gramo', 'грамм', 'граммов', 'грамма', 'граммы', 'граммах'],
  ['mass', 'kg', 1, 'kg', 'kilogram', 'kilograms', 'kilo', 'kilos', 'кг', 'kilogramos', 'килограмм', 'килограммов', 'килограмма', 'килограммы', 'килограммах'],
  ['mass', 't', 1000, 't', 'tonne', 'tonnes', 'ton', 'tons', 'toneladas', 'тонна', 'тонн', 'тонны', 'тоннах', 'т'],
  ['mass', 'oz', 0.028349523125, 'oz', 'ounce', 'ounces', 'onzas', 'onza', 'унция', 'унций', 'унции', 'унциях'],
  ['mass', 'lb', 0.45359237, 'lb', 'lbs', 'pound', 'pounds', 'libras', 'libra', 'фунт', 'фунтов', 'фунта', 'фунты', 'фунтах'],
  ['mass', 'st', 6.35029318, 'st', 'stone', 'stones'],
  ['temp', '°C', 0, 'c', '°c', 'ºc', 'celsius', 'centigrade', 'degc', 'цельсия', '°с', 'с'],
  ['temp', '°F', 0, 'f', '°f', 'ºf', 'fahrenheit', 'degf', 'фаренгейта'],
  ['temp', 'K', 0, 'k', 'kelvin', 'kelvins', 'кельвин', 'кельвинов', 'кельвина'],
  ['volume', 'mL', 1e-3, 'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'мл', 'mililitros'],
  ['volume', 'cL', 1e-2, 'cl', 'centiliter', 'centilitre'],
  ['volume', 'dL', 1e-1, 'dl', 'deciliter', 'decilitre'],
  ['volume', 'L', 1, 'l', 'liter', 'liters', 'litre', 'litres', 'л', 'litros', 'litro', 'литр', 'литров', 'литра', 'литры', 'литрах'],
  ['volume', 'm³', 1000, 'm3', 'cubic meter', 'cubic meters', 'cubic metre', 'cubic metres', 'м3'],
  ['volume', 'tsp', 0.00492892159375, 'tsp', 'teaspoon', 'teaspoons'],
  ['volume', 'tbsp', 0.01478676478125, 'tbsp', 'tablespoon', 'tablespoons'],
  ['volume', 'fl oz', 0.0295735295625, 'fl oz', 'floz', 'fluid ounce', 'fluid ounces'],
  ['volume', 'cup', 0.2365882365, 'cup', 'cups', 'tazas', 'taza'],
  ['volume', 'pt', 0.473176473, 'pt', 'pint', 'pints', 'pintas'],
  ['volume', 'qt', 0.946352946, 'qt', 'quart', 'quarts'],
  ['volume', 'gal', 3.785411784, 'gal', 'gallon', 'gallons', 'galones', 'galón', 'галлон', 'галлонов', 'галлона', 'галлоны', 'галлонах'],
  ['area', 'mm²', 1e-6, 'mm2'],
  ['area', 'cm²', 1e-4, 'cm2', 'см2'],
  ['area', 'm²', 1, 'm2', 'square meter', 'square meters', 'square metre', 'square metres', 'sqm', 'м2', 'metros cuadrados'],
  ['area', 'km²', 1e6, 'km2', 'square kilometer', 'square kilometers', 'square kilometre', 'square kilometres', 'км2'],
  ['area', 'ha', 1e4, 'ha', 'hectare', 'hectares', 'hectáreas', 'hectareas', 'га', 'гектар', 'гектаров', 'гектара', 'гектары', 'гектарах'],
  ['area', 'ac', 4046.8564224, 'ac', 'acre', 'acres'],
  ['area', 'in²', 0.00064516, 'in2', 'sq in', 'square inch', 'square inches'],
  ['area', 'ft²', 0.09290304, 'ft2', 'sq ft', 'sqft', 'square foot', 'square feet'],
  ['area', 'yd²', 0.83612736, 'yd2', 'sq yd', 'square yard', 'square yards'],
  ['area', 'mi²', 2589988.110336, 'mi2', 'sq mi', 'square mile', 'square miles'],
  ['speed', 'm/s', 1, 'm/s', 'mps', 'meters per second', 'metres per second', 'м/с'],
  ['speed', 'km/h', 1 / 3.6, 'km/h', 'kmh', 'kph', 'km per hour', 'kilometers per hour', 'kilometres per hour', 'км/ч'],
  ['speed', 'mph', 0.44704, 'mph', 'mi/h', 'miles per hour'],
  ['speed', 'kn', 0.514444444444, 'kn', 'kt', 'knot', 'knots', 'nudos', 'узел', 'узлов', 'узла', 'узлы', 'узлах'],
  ['speed', 'ft/s', 0.3048, 'ft/s', 'fps', 'feet per second'],
  ['data', 'bit', 0.125, 'bit', 'bits', 'бит', 'бита', 'биты', 'битах'],
  ['data', 'kbit', 125, 'kbit', 'kbits', 'kilobit', 'kilobits', 'кбит'],
  ['data', 'Mbit', 125e3, 'mbit', 'mbits', 'megabit', 'megabits', 'мбит'],
  ['data', 'Gbit', 125e6, 'gbit', 'gbits', 'gigabit', 'gigabits', 'гбит'],
  ['data', 'B', 1, 'b', 'byte', 'bytes', 'байт', 'байта', 'байтов', 'байты', 'байтах'],
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
  ['time', 's', 1, 's', 'sec', 'secs', 'second', 'seconds', 'segundos', 'segundo', 'с', 'сек', 'секунд', 'секунда', 'секунды', 'секундах'],
  ['time', 'min', 60, 'min', 'mins', 'minute', 'minutes', 'minutos', 'minuto', 'мин', 'минут', 'минута', 'минуты', 'минутах'],
  ['time', 'h', 3600, 'h', 'hr', 'hrs', 'hour', 'hours', 'horas', 'hora', 'ч', 'час', 'часа', 'часов', 'часы', 'часах'],
  ['time', 'd', 86400, 'd', 'day', 'days', 'días', 'dias', 'día', 'дн', 'день', 'дня', 'дней', 'дни', 'днях'],
  ['time', 'wk', 604800, 'wk', 'week', 'weeks', 'semanas', 'semana', 'нед', 'неделя', 'недели', 'недель', 'неделях'],
  ['time', 'mo', 2629746, 'mo', 'month', 'months', 'meses', 'mes', 'месяц', 'месяца', 'месяцев', 'месяцы', 'месяцах'],
  ['time', 'yr', 31556952, 'yr', 'year', 'years', 'años', 'año', 'год', 'года', 'лет', 'годы', 'годах'],
];
const UNITS = new Map();
for (const [family, symbol, factor, ...names] of UNIT_TABLE) {
  const definition = { family, symbol, factor };
  for (const name of names) if (!UNITS.has(name)) UNITS.set(name, definition); // the first family named wins (с: Celsius before seconds)
}
// Russian "с" is listed for Celsius first; as a lone unit after a number it means seconds far more often.
UNITS.set('с', UNITS.get('сек'));
// Where "10 km" alone converts to.
const DEFAULT_TO = { km: 'mi', mi: 'km', m: 'ft', ft: 'm', cm: 'in', in: 'cm', kg: 'lb', lb: 'kg', g: 'oz', oz: 'g', '°C': '°F', '°F': '°C', K: '°C', L: 'gal', gal: 'L', 'km/h': 'mph', mph: 'km/h', 'm²': 'ft²', 'ft²': 'm²', ha: 'ac', ac: 'ha' };
const bySymbol = new Map(UNIT_TABLE.map(([family, symbol, factor]) => [symbol, { family, symbol, factor }]));

export function unitOf(name) {
  let normalized = String(name || '').trim().toLowerCase().replace(/\.$/, '').replace(/²/g, '2').replace(/³/g, '3').replace(/^degrees? /, '°').replace(/^grados? /, '°').replace(/^градус(ов|а)? /, '°');
  normalized = normalized.replace(/^(sq|square) (\S+)$/, (match, prefixWord, unitWord) => (UNITS.has(unitWord) && UNITS.get(unitWord).family === 'length' ? UNITS.get(unitWord).symbol.toLowerCase() + '2' : match));
  normalized = normalized.replace(/^cubic (\S+)$/, (match, unitWord) => (UNITS.get(unitWord) && UNITS.get(unitWord).symbol === 'm' ? 'm3' : match));
  return UNITS.get(normalized) || UNITS.get(normalized.replace(/^°/, '')) || null;
}
function convert(x, fromUnit, toUnit) {
  if (fromUnit.family !== 'temp') return (x * fromUnit.factor) / toUnit.factor;
  // The offsets cancel out exactly enough at 6 digits: -17.7777777778 °C is 0 °F, not -4.0E-11.
  const add = (first, second) => addExact(first, second, 1e-10);
  const celsius = fromUnit.symbol === '°C' ? x : fromUnit.symbol === '°F' ? add(x, -32) * 5 / 9 : add(x, -273.15);
  return toUnit.symbol === '°C' ? celsius : toUnit.symbol === '°F' ? add(celsius * 9 / 5, 32) : add(celsius, 273.15);
}
const NUMBER_WITH_UNIT = /^(-?\d[\d.,]*)\s*(.*)$/;
function unit(text, { lang }) {
  const match = NUMBER_WITH_UNIT.exec(text);
  if (!match || !match[2]) return null;
  const x = (match[1].startsWith('-') ? -1 : 1) * parseNumber(match[1].replace(/^-/, ''), lang);
  if (!Number.isFinite(x)) return null;
  const words = match[2].split(' ');
  let from = null, to = null;
  // "10 km in mi", "10km to miles": split at the word that joins them...
  for (let i = 1; i < words.length - 1 && !from; i++) {
    if (!CONNECT.test(words[i])) continue;
    const candidateFrom = unitOf(words.slice(0, i).join(' ')), candidateTo = unitOf(words.slice(i + 1).join(' '));
    if (candidateFrom && candidateTo && candidateFrom.family === candidateTo.family) { from = candidateFrom; to = candidateTo; }
  }
  if (!from && words.length > 1 && CONNECT.test(words[words.length - 1])) return null; // "10 km in": still being typed
  // ...or anywhere between two units of the same kind ("5 lb kg", "10 sq ft m2")...
  for (let i = 1; i < words.length && !from; i++) {
    const candidateFrom = unitOf(words.slice(0, i).join(' ')), candidateTo = unitOf(words.slice(i).join(' '));
    if (candidateFrom && candidateTo && candidateFrom.family === candidateTo.family) { from = candidateFrom; to = candidateTo; }
  }
  // ...or a unit alone, to its usual counterpart ("10 km" -> miles). A bare "k" is a thousand ("10k"),
  // not kelvin: kelvin goes to °C only when it is spelt out ("300 kelvin").
  if (!from) {
    const bareUnit = unitOf(match[2]);
    if (!bareUnit || !DEFAULT_TO[bareUnit.symbol] || /^k$/i.test(match[2])) return null;
    from = bareUnit; to = bySymbol.get(DEFAULT_TO[bareUnit.symbol]);
  }
  if (from.symbol === to.symbol) return null; // "10 km in km", "10 c in c"
  const y = convert(x, from, to);
  if (!Number.isFinite(y)) return null;
  const out = formatNumber(y, lang, 6), input = formatNumber(x, lang, 12);
  const spacer = (symbol) => (symbol.startsWith('°') ? '' : ' ');
  const value = out.shown + spacer(to.symbol) + to.symbol;
  return { kind: 'unit', value, copy: out.plain + spacer(to.symbol) + to.symbol, expression: `${input.shown}${spacer(from.symbol)}${from.symbol} = ${value}`, from: from.symbol, to: to.symbol, family: from.family };
}

// ---------------------------------------------------------------- arithmetic
// Grammar (lowest first):  sum := product (('+' | '-') product)*      a + b% is a plus b percent of a (15% + 15% = 30%)
//                          product := unary (('*' | '/' | '%' | 'mod' | 'of' | implicit) unary)*   '%' here is modulo
//                                     'of' only after a percentage ("15% of 80"; "Part 1 of 3" is nothing)
//                          unary := ('-' | '+') unary | power         so -2^2 = -4
//                          power := postfix ('^' unary)?              right-associative: 2^3^2 = 2^9
//                          postfix := primary '%'?                    15% = 0.15 (marked as a percentage)
//                          primary := number | pi | π | e | func primary | '(' sum ')' | '√' primary
// Degrees, exact where the answer is (sin 180 = 0, not 1.2E-16); tan 90 has none.
function sinDeg(x) {
  const normalizedDegrees = ((x % 360) + 360) % 360;
  if (normalizedDegrees % 90 === 0) return [0, 1, 0, -1][normalizedDegrees / 90];
  if (normalizedDegrees % 60 === 30) return normalizedDegrees < 180 ? 0.5 : -0.5; // 30, 150, 210, 330
  return Math.sin((normalizedDegrees * Math.PI) / 180);
}
function tanDeg(x) {
  const normalizedDegrees = ((x % 180) + 180) % 180;
  if (normalizedDegrees === 90) return NaN;
  if (normalizedDegrees % 45 === 0) return [0, 1, NaN, -1][normalizedDegrees / 45];
  return Math.tan((normalizedDegrees * Math.PI) / 180);
}
const FUNCTIONS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: (x) => Math.sign(x) * Math.round(Math.abs(x)), // half away from zero: round(-2.5) = -3
  sin: sinDeg, cos: (x) => sinDeg(x + 90), tan: tanDeg,
  ln: Math.log, log: Math.log10, exp: Math.exp,
};
const CONSTANTS = { pi: Math.PI, 'π': Math.PI, e: Math.E };
const OF_WORDS = new Set(['of', 'de', 'от', 'von', 'di', 'din', 'του']); // "15% of 80" in en, es/fr, ru, de, it, ro, el
function tokenize(text, lang) {
  const out = [];
  const source = text.replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/\*\*/g, '^');
  for (let i = 0; i < source.length;) {
    const character = source[i];
    if (character === ' ') { i++; continue; }
    let match;
    if ((match = /^(\d[\d.,]*)(?:e([+-]?\d+))?/i.exec(source.slice(i)))) { // "2e10", "1e-7"; "2e" alone is 2 × e
      const value = parseNumber(match[1], lang), x = match[2] ? Number(match[2]) : 0;
      const scaledValue = x < 0 ? value / 10 ** -x : value * 10 ** x; // dividing keeps 1.5e-7 exact
      if (!Number.isFinite(scaledValue)) return null;
      out.push({ type: 'num', value: scaledValue });
      i += match[0].length;
    } else if ((match = /^\p{L}+/u.exec(source.slice(i)))) {
      const word = match[0].toLowerCase();
      if (OF_WORDS.has(word)) out.push({ type: 'of' });
      else if (word === 'mod') out.push({ type: 'op', value: 'mod' });
      else if (FUNCTIONS[word]) out.push({ type: 'fn', value: word });
      else if (word in CONSTANTS) out.push({ type: 'num', value: CONSTANTS[word], constant: true });
      else return null;
      i += match[0].length;
    } else if ('+-*/^%()√'.includes(character)) { out.push(character === '(' || character === ')' ? { type: character } : character === '√' ? { type: 'fn', value: 'sqrt' } : { type: 'op', value: character }); i++; }
    else return null;
    if (out.length > 120) return null;
  }
  return out;
}
function parseExpression(tokens) {
  let i = 0, depth = 0, operationCount = 0;
  const peek = () => tokens[i];
  const isOperator = (operator) => peek() && peek().type === 'op' && peek().value === operator;
  const startsOperand = (token) => !!token && (token.type === 'num' || token.type === '(' || token.type === 'fn');
  function sum() {
    let total = product();
    while (isOperator('+') || isOperator('-')) {
      const operator = tokens[i++].value; operationCount++;
      const operand = product();
      const addend = operand.percent && !total.percent ? total.value * operand.value : operand.value; // 80 + 15% = 92, but 15% + 15% = 30%
      total = { value: addExact(total.value, operator === '+' ? addend : -addend), percent: total.percent && operand.percent };
    }
    return total;
  }
  function product() {
    let total = unary();
    for (;;) {
      const token = peek();
      if (token && token.type === 'op' && (token.value === '*' || token.value === '/' || token.value === '%' || token.value === 'mod')) {
        i++; operationCount++;
        const operand = unary(); // "mod" is always modulo, so "10 mod -3" works
        total = { value: token.value === '*' ? total.value * operand.value : token.value === '/' ? total.value / operand.value : total.value % operand.value };
      } else if (token && token.type === 'of') { // 15% of 80; "1 of 3" is a title, not a product
        if (!total.percent) throw new Error('of');
        i++; operationCount++;
        const operand = unary();
        total = { value: total.value * operand.value, percent: operand.percent }; // 50% of 50% is 25%
      } else if (token && (token.type === '(' || token.type === 'fn' || (token.type === 'num' && token.constant))) { // 2pi, 3(4 + 1), 2 sqrt 9
        operationCount++;
        total = { value: total.value * unary().value };
      } else return total;
    }
  }
  function unary() {
    if (isOperator('-')) { i++; const x = unary(); return { value: -x.value, percent: x.percent }; }
    if (isOperator('+')) { i++; return unary(); }
    return power();
  }
  function power() {
    const baseValue = postfix();
    if (!isOperator('^')) return baseValue;
    i++; operationCount++;
    const exponent = unary(); // right-associative, and 2^-1 works
    return { value: baseValue.value ** exponent.value };
  }
  function postfix() {
    const value = primary();
    // "15%" is a percentage unless an operand follows ("10 % 3" is modulo).
    if (isOperator('%') && !startsOperand(tokens[i + 1])) { i++; operationCount++; return { value: value.value / 100, percent: true }; }
    return value;
  }
  function primary() {
    const token = tokens[i++];
    if (!token) throw new Error('end');
    if (token.type === 'num') return { value: token.value };
    if (token.type === 'fn') { operationCount++; if (++depth > 60) throw new Error('deep'); const x = FUNCTIONS[token.value](token.type === 'fn' && peek() && peek().type === '(' ? primary().value : unary().value); depth--; return { value: x }; }
    if (token.type === '(') {
      if (++depth > 60) throw new Error('deep');
      const value = sum();
      if (!peek() || peek().type !== ')') throw new Error('paren');
      i++; depth--;
      return { value: value.value };
    }
    throw new Error('unexpected');
  }
  const result = sum();
  if (i !== tokens.length) throw new Error('trailing');
  return { value: result.value, operationCount };
}
// YYYY-MM-DD, YYYY/MM/DD, or DD/MM/YYYY (MM/DD/YYYY) written without spaces, anywhere in the text.
const DATE_LIKE = /(?:^|[^\d.,])(?:\d{4}([-/])\d{1,2}\1\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})(?![\d.,])/;
function calculate(text, { lang }) {
  if (/^\d+(-\d+)+$/.test(text)) return null; // a date or a phone number ("555-1234"), not a sum: "7 - 3" has spaces
  if (DATE_LIKE.test(text)) return null; // "2026-10-21 - 2026-01-01", "2024-01-05 + 3", "12/25/2024": dates, not sums
  const tokens = tokenize(text, lang);
  if (!tokens || !tokens.length) return null;
  const lone = tokens.length === 1 && tokens[0].constant && /^(pi|π)$/i.test(text);
  const result = parseExpression(tokens);
  if ((!result.operationCount && !lone) || !Number.isFinite(result.value)) return null;
  const { shown, plain } = formatNumber(result.value, lang, 12);
  return { kind: 'calculation', value: shown, copy: plain, expression: `${text} = ${shown}` };
}
