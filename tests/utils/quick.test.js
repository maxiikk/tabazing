// utils/quick.js: the command palette's quick answers. Pure, so every case is a plain call. Times and dates use a
// fixed "now" and local time zone, so they don't depend on the machine running the tests.
import { describe, it, expect } from 'vitest';
import { quick, parseNumber, formatNumber, resolveZone, zoneOffset, unitOf } from '../../utils/quick.js';

const NOW = Date.UTC(2026, 9, 18, 12, 0); // Sunday 18 October 2026, 12:00 UTC (14:00 in Madrid)
const q = (s, opts = {}) => quick(s, { lang: 'en', now: NOW, zone: 'Europe/Madrid', ...opts });
const v = (s, opts) => { const r = q(s, opts); return r && (r.value ?? r.count); };
const sp = (s) => s.replace(/[  ]/g, ' '); // Intl may use narrow / no-break spaces

describe('numbers', () => {
  it('parseNumber: thousands separators and decimal marks', () => {
    expect(parseNumber('1234')).toBe(1234);
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('1.234,5')).toBe(1234.5);
    expect(parseNumber('1,234,567')).toBe(1234567);
    expect(parseNumber('1.234.567')).toBe(1234567);
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('1.5')).toBe(1.5);
    expect(parseNumber('1,234', 'en')).toBe(1234); // English: groups of three are thousands...
    expect(parseNumber('1,234', 'es')).toBe(1.234); // ...elsewhere a lone comma is the decimal mark
    expect(parseNumber('1,234', 'ru')).toBe(1.234);
    for (const bad of ['', '1,2,3', '1.2.3', '1,23,456', '12,', '.5', 'abc', '1..2', '1,234.5.6']) expect(parseNumber(bad), bad).toBeNaN();
  });

  it('formatNumber: rounded to significant digits, scientific for the very big and very small, plain digits to copy', () => {
    expect(formatNumber(0.1 + 0.2, 'en')).toEqual({ shown: '0.3', plain: '0.3' });
    expect(formatNumber(1234567.891, 'en')).toEqual({ shown: '1,234,567.891', plain: '1234567.891' });
    expect(formatNumber(1234.5, 'es').shown).toMatch(/^1\.?234,5$/);
    expect(sp(formatNumber(1234.5, 'ru').shown)).toBe('1 234,5');
    expect(formatNumber(2 / 3, 'en', 6).shown).toBe('0.666667');
    expect(formatNumber(1e21, 'en').shown).toBe('1E21');
    expect(formatNumber(1.5e-9, 'en').shown).toBe('1.5E-9');
    expect(formatNumber(-0, 'en').plain).toBe('0');
  });
});

describe('arithmetic', () => {
  it.each([
    ['2+2', '4'], ['2 + 3 * 4', '14'], ['(2 + 3) * 4', '20'], ['10 / 4', '2.5'], ['7 - 10', '-3'],
    ['2^10', '1,024'], ['2**3', '8'], ['2^3^2', '512'], ['-2^2', '-4'], ['(-2)^2', '4'], ['- -3 + 1', '4'],
    ['6 × 7', '42'], ['84 ÷ 2', '42'], ['5 · 3', '15'], ['9 − 4', '5'], ['10 % 3', '1'], ['10 mod 4', '2'],
    ['1,234.5 * 2', '2,469'], ['1/3', '0.333333333333'], ['0.1 + 0.2', '0.3'],
    ['sqrt(16)', '4'], ['sqrt 16 + 1', '5'], ['√81', '9'], ['cbrt(27)', '3'], ['abs(-3)', '3'], ['round(2.5)', '3'], ['floor(2.7)', '2'], ['ceil(2.1)', '3'],
    ['sin(30)', '0.5'], ['cos(60)', '0.5'], ['tan(45)', '1'], ['ln(e)', '1'], ['log(1000)', '3'], ['exp(0)', '1'],
    ['pi', '3.14159265359'], ['π', '3.14159265359'], ['2pi', '6.28318530718'], ['3(4 + 1)', '15'], ['2 sqrt(9)', '6'],
  ])('%s = %s', (s, want) => {
    const r = q(s);
    expect(r).toMatchObject({ kind: 'calc', value: want });
    expect(r.expr).toBe(`${s} = ${want}`);
  });

  it('percentages: of, added, taken off, and alone', () => {
    expect(v('15% of 80')).toBe('12');
    expect(v('80 + 15%')).toBe('92');
    expect(v('80 - 15%')).toBe('68');
    expect(v('80 * 15%')).toBe('12');
    expect(v('50%+10')).toBe('10.5');
    expect(v('15%')).toBe('0.15');
  });

  it('copies plain digits, shows the language’s', () => {
    expect(q('1000 * 1.5')).toMatchObject({ value: '1,500', copy: '1500' });
    expect(q('1,5 + 1', { lang: 'es' })).toMatchObject({ value: '2,5', copy: '2.5' });
    expect(sp(q('1000 * 1.5', { lang: 'ru' }).value)).toBe('1 500');
  });

  it('nothing for plain numbers, words, dates, phone numbers, or what isn’t finite', () => {
    for (const s of ['42', '-5', '3.14', 'e', 'hello', 'covid-19', 'v2', '2026-10-18', '555-1234', '1/0', '0/0', 'sqrt(-1)', '10^400', 'log', '2 3', '(1 + 2', '1 + 2)', '+', '*2', '2 +', 'foo(2)']) {
      expect(q(s), s).toBeNull();
    }
  });

  it('never throws on garbage, and refuses very long input', () => {
    const junk = ['((((((((((', ')'.repeat(50), '%%%', '^^^', '√√√', '1e999', '\u0000', '{}', '[]', '<script>', 'NaN', 'Infinity', '9'.repeat(400), '('.repeat(80) + '1' + ')'.repeat(80), null, undefined, 42, {}];
    for (const s of junk) expect(() => quick(s)).not.toThrow();
    expect(quick('1+'.repeat(150) + '1')).toBeNull();
    expect(quick('('.repeat(80) + '1' + ')'.repeat(80))).toBeNull(); // too deep
  });
});

describe('units', () => {
  it.each([
    ['10 km in mi', '6.21371 mi'], ['10km to miles', '6.21371 mi'], ['1 mile in km', '1.60934 km'], ['6 ft in m', '1.8288 m'],
    ['10 in cm', '25.4 cm'], ['100 cm in in', '39.3701 in'], ['1 nautical mile in km', '1.852 km'], ['3 yd to ft', '9 ft'],
    ['5 lb kg', '2.26796 kg'], ['1 kg in lb', '2.20462 lb'], ['16 oz to lb', '1 lb'], ['1 st in kg', '6.35029 kg'], ['2 t in kg', '2,000 kg'],
    ['70f in c', '21.1111°C'], ['100 °C to °F', '212°F'], ['0 c in k', '273.15 K'], ['-40 f in c', '-40°C'], ['300 kelvin in celsius', '26.85°C'],
    ['1 gal in l', '3.78541 L'], ['500 ml in cups', '2.11338 cup'], ['2 tbsp in tsp', '6 tsp'], ['1 m3 in l', '1,000 L'], ['8 fl oz in ml', '236.588 mL'],
    ['1 acre in ha', '0.404686 ha'], ['100 sq ft in m2', '9.2903 m²'], ['1 km² in ha', '100 ha'], ['1 square mile in km2', '2.58999 km²'],
    ['100 km/h in mph', '62.1371 mph'], ['10 m/s in km/h', '36 km/h'], ['30 knots in km/h', '55.56 km/h'],
    ['2 GB in MB', '2,000 MB'], ['1 GiB in MiB', '1,024 MiB'], ['1 GiB in MB', '1,073.74 MB'], ['1 MB in KiB', '976.563 KiB'], ['1 gigabit in MB', '125 MB'], ['8 bits in bytes', '1 B'],
    ['1.5 h in min', '90 min'], ['90 min to hours', '1.5 h'], ['1 day in hours', '24 h'], ['2 weeks in days', '14 d'], ['1 year in days', '365.243 d'], ['500 ms in s', '0.5 s'],
  ])('%s = %s', (s, want) => {
    const r = q(s);
    expect(r && r.kind, s).toBe('unit');
    expect(r.value).toBe(want);
  });

  it('a unit alone converts to its usual counterpart', () => {
    expect(v('10 km')).toBe('6.21371 mi');
    expect(v('5 miles')).toBe('8.04672 km');
    expect(v('20 c')).toBe('68°F');
    expect(v('3 kg')).toBe('6.61387 lb');
    expect(q('3 days')).toBeNull(); // nothing obvious to convert to
  });

  it('the expression and what is copied', () => {
    expect(q('10 km in mi')).toMatchObject({ copy: '6.21371 mi', expr: '10 km = 6.21371 mi', from: 'km', to: 'mi', family: 'length' });
    expect(q('1234 m in km')).toMatchObject({ value: '1.234 km', expr: '1,234 m = 1.234 km' });
    expect(q('10 km in mi', { lang: 'es' }).value).toBe('6,21371 mi');
  });

  it('Spanish and Russian unit names', () => {
    expect(v('10 kilómetros en millas')).toBe('6.21371 mi');
    expect(v('5 libras a kilos')).toBe('2.26796 kg');
    expect(v('10 км в милях'.replace('милях', 'миль'))).toBe('6.21371 mi');
    expect(v('2 часа в мин')).toBe('120 min');
  });

  it('different kinds don’t convert; unknown units are nothing', () => {
    for (const s of ['10 km in kg', '5 lb in mi', '3 foo in bar', '10 km in', 'km in mi', '10 c in mph']) expect(q(s), s).toBeNull();
  });

  it('unitOf knows names, plurals, symbols and square forms', () => {
    expect(unitOf('Miles').sym).toBe('mi');
    expect(unitOf('°F').sym).toBe('°F');
    expect(unitOf('degrees f').sym).toBe('°F');
    expect(unitOf('sq km').sym).toBe('km²');
    expect(unitOf('m²').sym).toBe('m²');
    expect(unitOf('cubic meters').sym).toBe('m³');
    expect(unitOf('KiB').sym).toBe('KiB');
    expect(unitOf('nope')).toBeNull();
  });
});

describe('number bases', () => {
  it.each([
    ['255 in hex', '0xFF'], ['255 to binary', '0b11111111'], ['8 in oct', '0o10'], ['0xff', '255'], ['0xFF in dec', '255'],
    ['0b1010 in dec', '10'], ['0b1010', '10'], ['0o17', '15'], ['hex 255', '0xFF'], ['bin 5', '0b101'], ['dec 0x10', '16'], ['-255 in hex', '-0xFF'],
  ])('%s = %s', (s, want) => expect(q(s)).toMatchObject({ kind: 'base', value: want, copy: want }));

  it('shows the other bases too, and leaves out the pointless and the impossible', () => {
    expect(q('255 in hex').alts).toEqual(['0b11111111', '0o377']);
    expect(q('255 in hex').expr).toBe('255 = 0xFF');
    for (const s of ['255 in dec', '0xzz', '0b102', 'hex', 'hex zz', '99999999999999999999 in hex']) expect(q(s), s).toBeNull();
  });
});

describe('colours', () => {
  it('#hex -> rgb (and hsl), with a swatch', () => {
    expect(q('#ff8800')).toEqual({ kind: 'color', value: 'rgb(255, 136, 0)', copy: 'rgb(255, 136, 0)', expr: '#FF8800 = rgb(255, 136, 0)', alts: ['hsl(32, 100%, 50%)'], swatch: '#ff8800' });
    expect(q('#F80')).toMatchObject({ value: 'rgb(255, 136, 0)', swatch: '#ff8800' });
  });
  it('rgb() and hsl() -> #hex', () => {
    expect(q('rgb(255, 0, 0)')).toMatchObject({ value: '#FF0000', alts: ['hsl(0, 100%, 50%)'], swatch: '#ff0000' });
    expect(q('rgb(0 128 255)')).toMatchObject({ value: '#0080FF' });
    expect(q('rgba(10, 20, 30, 0.5)')).toMatchObject({ value: '#0A141E' });
    expect(q('hsl(120, 100%, 50%)')).toMatchObject({ value: '#00FF00', alts: ['rgb(0, 255, 0)'] });
    expect(q('hsl(0, 0%, 100%)')).toMatchObject({ value: '#FFFFFF' });
  });
  it('a notation asked for', () => {
    expect(v('#ff8800 in hsl')).toBe('hsl(32, 100%, 50%)');
    expect(v('rgb(255,0,0) to hsl')).toBe('hsl(0, 100%, 50%)');
  });
  it('not colours', () => {
    for (const s of ['ff8800', '#ff88', '#ggg', 'rgb(300, 0, 0)', 'rgb(1,2)', 'hsl(10, 200%, 50%)']) expect(q(s), s).toBeNull();
  });
});

describe('time zones', () => {
  it('the time somewhere now', () => {
    expect(sp(v('time in Tokyo'))).toBe('Sun 9:00 PM');
    expect(q('time in Tokyo')).toMatchObject({ kind: 'time', place: 'Tokyo', zone: 'Asia/Tokyo', offset: 'UTC+9' });
    expect(sp(v('Tokyo time'))).toBe('Sun 9:00 PM');
    expect(sp(v('now in UTC'))).toBe('Sun 12:00 PM');
    expect(sp(v('time in new york'))).toBe('Sun 8:00 AM');
    expect(q('time in new york')).toMatchObject({ place: 'New York', offset: 'UTC−4' });
    expect(sp(v('time in Europe/Paris'))).toBe('Sun 2:00 PM');
    expect(sp(v('time in Kolkata'))).toBe('Sun 5:30 PM');
    expect(sp(v('time in Halifax'))).toBe('Sun 9:00 AM'); // found among the browser's zones by its city
    expect(sp(v('time in UTC+3'))).toBe('Sun 3:00 PM');
    expect(sp(v('time in GMT-5'))).toBe('Sun 7:00 AM');
    expect(sp(v('hora en Tokio', { lang: 'es' }))).toMatch(/^dom\.?,? 21:00$/);
    expect(sp(v('время в Москве'.replace('Москве', 'москва'), { lang: 'ru' }))).toMatch(/^вс,? 15:00$/);
  });

  it('a time in one place, in another', () => {
    expect(sp(v('3pm London in New York'))).toBe('Sun 10:00 AM');
    expect(sp(q('3pm London in New York').expr)).toBe('3:00 PM London = Sun 10:00 AM New York');
    expect(sp(v('15:30 in Tokyo'))).toBe('Sun 10:30 PM'); // from here (Madrid)
    expect(sp(v('9am PST to CET'))).toBe('Sun 6:00 PM');
    expect(sp(v('noon UTC in Sydney'))).toBe('Sun 11:00 PM');
    expect(sp(v('midnight tokyo to london'))).toBe('Sat 4:00 PM');
  });

  it('nothing for unknown places or times that aren’t', () => {
    for (const s of ['time in Atlantis', 'time machine', '3 London in Tokyo', '25:00 in Tokyo', '13pm in Tokyo', 'time in UTC+20']) expect(q(s), s).toBeNull();
  });

  it('resolveZone and zoneOffset', () => {
    expect(resolveZone('Москва')).toMatchObject({ zone: 'Europe/Moscow' });
    expect(resolveZone('nueva york')).toMatchObject({ zone: 'America/New_York' });
    expect(resolveZone('here', 'Asia/Tokyo')).toMatchObject({ zone: 'Asia/Tokyo', place: 'Tokyo' });
    expect(resolveZone('')).toBeNull();
    expect(zoneOffset('Asia/Kolkata', NOW)).toBe(330);
    expect(zoneOffset('America/New_York', Date.UTC(2026, 0, 15))).toBe(-300); // winter time
  });
});

describe('dates', () => {
  it('days until, since and between', () => {
    expect(q('days until 2027-01-01')).toMatchObject({ kind: 'days', count: 75, copy: '75' });
    expect(v('days since 2026-10-01')).toBe(17);
    expect(v('days until tomorrow')).toBe(1);
    expect(v('days between 2026-01-01 and 2026-12-31')).toBe(364);
    expect(v('días hasta 2026-12-25')).toBe(68);
    expect(v('дней до 2026-10-28')).toBe(10);
  });

  it('a date plus or minus days, weeks, months, years', () => {
    expect(q('2026-10-18 + 30 days')).toMatchObject({ kind: 'date', value: 'Tue, Nov 17, 2026', copy: '2026-11-17', expr: '2026-10-18 + 30 days = 2026-11-17' });
    expect(q('today + 2 weeks').copy).toBe('2026-11-01');
    expect(q('today - 1 month').copy).toBe('2026-09-18');
    expect(q('2026-01-31 + 1 month').copy).toBe('2026-02-28'); // no Feb 31: the month's last day
    expect(q('2024-02-29 + 1 year').copy).toBe('2025-02-28');
    expect(q('hoy + 3 días', { lang: 'es' }).copy).toBe('2026-10-21');
    expect(q('сегодня + 1 неделя', { lang: 'ru' }).copy).toBe('2026-10-25');
  });

  it('nothing for impossible dates', () => {
    for (const s of ['2026-02-30 + 1 day', 'days until 2026-13-01', 'days until someday', '2026-10-18 + 3 parsecs']) expect(q(s), s).toBeNull();
  });
});

describe('currency', () => {
  it('looks like money: one row saying it needs the internet (no rate is ever made up)', () => {
    for (const s of ['10 usd in eur', '10 USD to EUR', '$10 in eur', '10€ in $', '100 rub', '5 dollars in euros', '10 евро в рубли'.replace('рубли', 'рублей')]) {
      expect(q(s), s).toEqual({ kind: 'currency' });
    }
  });
  it('but pounds are weight, and words are words', () => {
    expect(q('10 pounds in kg').kind).toBe('unit');
    expect(q('usd')).toBeNull();
    expect(q('euro news')).toBeNull();
  });
});
