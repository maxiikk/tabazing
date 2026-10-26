// utils/lookups.js: the only things Tabazing fetches. Exchange rates from open.er-api.com (kept, read again after six
// hours, the last ones when they can't be read now) and the weather from Open-Meteo (the place found, then the weather
// now there). fetch is a stand-in here: what is asked of it, and what it answers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exchangeRates, weatherNow, weatherCondition, RATES_URL } from '../../utils/lookups.js';

let answers;
beforeEach(() => {
  answers = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { ok: next.ok !== false, status: next.status || 200, json: async () => next.body };
  }));
});
afterEach(() => vi.unstubAllGlobals());
const RATES = { result: 'success', time_last_update_unix: 1793000000, rates: { USD: 1, EUR: 0.92, GBP: 0.79, XXX: 'bad' } };

describe('exchangeRates', () => {
  it('reads today’s rates (per dollar), without cookies, and keeps them', async () => {
    answers.push({ body: RATES });
    expect(await exchangeRates(1_000)).toEqual({ rates: { USD: 1, EUR: 0.92, GBP: 0.79 }, updated: 1793000000000 });
    expect(fetch).toHaveBeenCalledWith(RATES_URL, expect.objectContaining({ credentials: 'omit' }));
    expect((await chrome.storage.local.get('rates')).rates).toMatchObject({ rates: { EUR: 0.92 }, t: 1_000 });
  });

  it('asks again only after six hours', async () => {
    answers.push({ body: RATES }, { body: { ...RATES, rates: { USD: 1, EUR: 0.95 } } });
    await exchangeRates(1_000);
    expect((await exchangeRates(1_000 + 5 * 3600e3)).rates.EUR).toBe(0.92);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await exchangeRates(1_000 + 7 * 3600e3)).rates.EUR).toBe(0.95);
  });

  it('offline: the last rates kept (stale); none kept: it fails', async () => {
    answers.push(new Error('offline'));
    await expect(exchangeRates(1_000)).rejects.toThrow('offline');
    answers.push({ body: RATES }, new Error('offline'));
    await exchangeRates(2_000);
    expect(await exchangeRates(2_000 + 7 * 3600e3)).toMatchObject({ rates: { EUR: 0.92 }, stale: true });
  });

  it('an answer that isn’t rates is refused', async () => {
    answers.push({ body: { result: 'error', 'error-type': 'quota' } });
    await expect(exchangeRates(1_000)).rejects.toThrow();
  });
});

describe('weatherNow', () => {
  const ATHENS = { results: [{ name: 'Athens', admin1: 'Attica', country: 'Greece', latitude: 37.98, longitude: 23.72 }] };
  const NOW = { current: { temperature_2m: 24.4, apparent_temperature: 25.1, relative_humidity_2m: 40, weather_code: 2, wind_speed_10m: 12.3, is_day: 1 } };

  it('finds the place, then the weather now there', async () => {
    answers.push({ body: ATHENS }, { body: NOW });
    expect(await weatherNow('Athens', 'el', 1)).toEqual({ found: true, place: 'Athens', region: 'Attica', country: 'Greece', temperature: 24.4, feelsLike: 25.1, humidity: 40, wind: 12.3, code: 2, isDay: true, units: 'metric' });
    const [geocoding, forecast] = fetch.mock.calls.map(([url]) => url);
    expect(geocoding).toBe('https://geocoding-api.open-meteo.com/v1/search?name=Athens&count=1&language=el&format=json');
    expect(forecast).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=37\.98&longitude=23\.72&current=/);
    expect(forecast).not.toContain('fahrenheit');
  });

  it('in °F and mph where the place is in the United States; the place is sent as typed, encoded', async () => {
    answers.push({ body: { results: [{ name: 'New York', country_code: 'US', latitude: 40.7, longitude: -74 }] } }, { body: NOW });
    expect((await weatherNow('New York & co', 'en', 1)).units).toBe('imperial');
    expect(fetch.mock.calls[0][0]).toContain('name=New%20York%20%26%20co');
    expect(fetch.mock.calls[1][0]).toContain('&temperature_unit=fahrenheit&wind_speed_unit=mph');
  });

  it('no such place: found false (and no forecast is asked)', async () => {
    answers.push({ body: {} });
    expect(await weatherNow('Qwxzzy', 'en', 1)).toEqual({ found: false });
    expect(fetch).toHaveBeenCalledTimes(1); // (English, the language asked in, tried once)
  });

  it('a name not found in the language asked: in the one it is written in, then English (Θεσσαλονίκη is found in Greek)', async () => {
    answers.push({ body: {} }, { body: { results: [{ name: 'Θεσσαλονίκη', country: 'Ελλάδα', country_code: 'GR', latitude: 40.6, longitude: 22.9 }] } }, { body: NOW });
    expect(await weatherNow('Θεσσαλονίκη', 'en', 1)).toMatchObject({ found: true, place: 'Θεσσαλονίκη', units: 'metric' });
    expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('language'))).toEqual(['en', 'el', null]);
  });

  it('the same place again within ten minutes: as it was', async () => {
    answers.push({ body: ATHENS }, { body: NOW });
    await weatherNow('Paris', 'fr', 100);
    await weatherNow('paris', 'fr', 100 + 9 * 60e3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('weatherCondition', () => {
  it('names the sky a WMO code means', () => {
    expect([0, 1, 2, 3, 45, 53, 56, 63, 67, 73, 77, 81, 86, 95, 99, 42].map(weatherCondition)).toEqual(['clear', 'mainlyClear', 'partlyCloudy', 'overcast', 'fog', 'drizzle', 'freezingDrizzle', 'rain', 'freezingRain', 'snow', 'snowGrains', 'showers', 'snowShowers', 'thunderstorm', 'thunderHail', 'unknown']);
  });
});
