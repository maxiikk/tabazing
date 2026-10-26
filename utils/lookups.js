// The only things Tabazing fetches from the internet, and only when the command palette is asked for them (what the
// background does for MESSAGE.LOOKUP): today's exchange rates (open.er-api.com, free, no key, updated daily) and the
// weather where you ask (Open-Meteo: its geocoding finds the place, its forecast gives the weather now; free, no key).
// Nothing but the place typed, or nothing at all for the rates, is sent; no cookies (credentials: 'omit'). The
// extension's pages may connect to these three addresses only (manifest.json, content_security_policy).
import { KEY } from './constants.js';

export const RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const RATES_FRESH_MILLISECONDS = 6 * 60 * 60 * 1000; // the rates change once a day: read again after six hours
const WEATHER_FRESH_MILLISECONDS = 10 * 60 * 1000;
const TIMEOUT_MILLISECONDS = 8000;

async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MILLISECONDS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Today's rates: { rates: { [code]: units per US dollar }, updated (ms) }. The last ones kept when they can't be read
 * now (stale: true); throws when there are none at all. */
export async function exchangeRates(now = Date.now()) {
  const kept = (await chrome.storage.local.get(KEY.RATES))[KEY.RATES];
  const valid = (value) => value && typeof value === 'object' && value.rates && value.rates.USD === 1 && Number.isFinite(value.updated) && Number.isFinite(value.t);
  if (valid(kept) && now - kept.t < RATES_FRESH_MILLISECONDS) return { rates: kept.rates, updated: kept.updated };
  try {
    const data = await fetchJson(RATES_URL);
    if (!data || data.result !== 'success' || !data.rates || data.rates.USD !== 1) throw new Error('unexpected answer');
    const rates = Object.fromEntries(Object.entries(data.rates).filter(([code, rate]) => /^[A-Z]{3}$/.test(code) && Number.isFinite(rate) && rate > 0));
    const fresh = { rates, updated: Number(data.time_last_update_unix) * 1000 || now, t: now };
    await chrome.storage.local.set({ [KEY.RATES]: fresh });
    return { rates: fresh.rates, updated: fresh.updated };
  } catch (error) {
    if (valid(kept)) return { rates: kept.rates, updated: kept.updated, stale: true };
    throw error;
  }
}

// Open-Meteo's geocoding finds a name in the language it is asked in ("Θεσσαλονίκη" only in Greek): the interface's
// language first, then the one the name is written in, then English.
const SCRIPT_LANGUAGES = [[/\p{Script=Greek}/u, 'el'], [/\p{Script=Cyrillic}/u, 'ru'], [/\p{Script=Hebrew}/u, 'he'], [/\p{Script=Arabic}/u, 'ar']];
// Where the weather comes in °F and mph (the United States, Liberia, Myanmar); °C and km/h everywhere else.
const IMPERIAL_COUNTRIES = new Set(['US', 'LR', 'MM']);
const weatherKept = new Map(); // "place|lang" -> { t, answer }
/** The weather now where `place` is: { place, region, country, temperature, feelsLike, humidity, wind, code, isDay,
 * units: 'metric' | 'imperial' (by where the place is) }, or { found: false } when no such place is known. */
export async function weatherNow(place, lang = 'en', now = Date.now()) {
  const cacheKey = `${place.toLowerCase()}|${lang}`;
  const kept = weatherKept.get(cacheKey);
  if (kept && now - kept.t < WEATHER_FRESH_MILLISECONDS) return kept.answer;
  let spot = null;
  for (const language of new Set([lang, ...SCRIPT_LANGUAGES.filter(([script]) => script.test(place)).map(([, language]) => language), 'en'])) {
    const found = await fetchJson(`${GEOCODING_URL}?name=${encodeURIComponent(place)}&count=1&language=${encodeURIComponent(language)}&format=json`);
    spot = found && Array.isArray(found.results) && found.results[0];
    if (spot) break;
  }
  if (!spot || !Number.isFinite(spot.latitude) || !Number.isFinite(spot.longitude)) return { found: false };
  const imperial = IMPERIAL_COUNTRIES.has(spot.country_code);
  const forecast = await fetchJson(`${FORECAST_URL}?latitude=${spot.latitude}&longitude=${spot.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day&timezone=auto${imperial ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : ''}`);
  const current = forecast && forecast.current;
  if (!current || !Number.isFinite(current.temperature_2m)) throw new Error('unexpected answer');
  const answer = {
    found: true, place: String(spot.name || place), region: String(spot.admin1 || ''), country: String(spot.country || ''),
    temperature: current.temperature_2m, feelsLike: current.apparent_temperature, humidity: current.relative_humidity_2m,
    wind: current.wind_speed_10m, code: current.weather_code, isDay: current.is_day === 1, units: imperial ? 'imperial' : 'metric',
  };
  weatherKept.set(cacheKey, { t: now, answer });
  if (weatherKept.size > 50) weatherKept.delete(weatherKept.keys().next().value);
  return answer;
}

/** The kind of sky a WMO weather code means (Open-Meteo's weather_code): weatherCondition's choices. */
export function weatherCondition(code) {
  if (code === 0) return 'clear';
  if (code === 1) return 'mainlyClear';
  if (code === 2) return 'partlyCloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 55) return 'drizzle';
  if (code === 56 || code === 57) return 'freezingDrizzle';
  if (code >= 61 && code <= 65) return 'rain';
  if (code === 66 || code === 67) return 'freezingRain';
  if (code >= 71 && code <= 75) return 'snow';
  if (code === 77) return 'snowGrains';
  if (code >= 80 && code <= 82) return 'showers';
  if (code === 85 || code === 86) return 'snowShowers';
  if (code === 95) return 'thunderstorm';
  if (code === 96 || code === 99) return 'thunderHail';
  return 'unknown';
}
