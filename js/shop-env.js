/* Spectrum Auto — shop environment feed.
   Real local time at the shop (America/Chicago) plus current weather for Papillion, NE
   from Open-Meteo (no API key, no attribution requirement, CORS-open).

   window.SpectrumEnv.get() -> {
     phase,        // 0..1 day-cycle position derived from real sunrise/sunset
     clockLabel,   // "14:32" shop-local
     phaseLabel,   // "Dusk"
     isDay,
     cloud,        // 0..1 cloud cover
     precip,       // 'none' | 'rain' | 'snow'
     precipRate,   // 0..1
     fog,          // 0..1
     windDeg, windSpeed, tempC, tempF, code, conditionLabel, live
   }
   Fails soft: with no network it still returns real local time and clear weather. */
(function () {
  'use strict';

  const LAT = 41.15, LON = -96.04;            // Papillion, NE
  const TZ = 'America/Chicago';
  const REFRESH = 10 * 60 * 1000;             // re-fetch every 10 minutes

  const env = {
    phase: 0.5, clockLabel: '--:--', phaseLabel: '', isDay: true,
    cloud: 0, precip: 'none', precipRate: 0, fog: 0,
    windDeg: 0, windSpeed: 0, tempC: null, tempF: null,
    code: 0, conditionLabel: 'Clear', live: false,
    sunrise: 6.5, sunset: 20.0                // decimal hours, replaced by real data
  };

  /* ---- shop-local wall clock, independent of the viewer's timezone ---- */
  function shopHours() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date());
    const get = (t) => +(parts.find(p => p.type === t) || {}).value;
    let h = get('hour');
    if (h === 24) h = 0;                      // some engines emit 24 for midnight
    return h + get('minute') / 60 + get('second') / 3600;
  }

  /* ---- map real sunrise/sunset onto the renderer's 0..1 day phase ----
     The renderer's stops assume: 0 dawn · 0.30 midday · 0.60 golden · 0.72 dusk · 0.86 night.
     So anchor sunrise->0.02, solar noon->0.30, sunset->0.66, and spread the night. */
  function phaseFromClock(h, sunrise, sunset) {
    const DAWN_P = 0.02, NOON_P = 0.30, SET_P = 0.66;
    const noon = (sunrise + sunset) / 2;
    if (h >= sunrise && h <= noon) {
      return DAWN_P + (h - sunrise) / (noon - sunrise) * (NOON_P - DAWN_P);
    }
    if (h > noon && h <= sunset) {
      return NOON_P + (h - noon) / (sunset - noon) * (SET_P - NOON_P);
    }
    // Night: sunset -> next sunrise wraps SET_P -> 1.0
    const nightLen = (24 - sunset) + sunrise;
    const into = h > sunset ? h - sunset : (24 - sunset) + h;
    return SET_P + (into / nightLen) * (1 - SET_P);
  }

  function labelFor(p) {
    // Boundaries follow phaseFromClock's mapping: 0.30 is solar noon, so afternoon starts
    // there rather than at 0.42, which was landing mid-afternoon still labelled "Morning".
    return p < 0.08 ? 'Dawn' : p < 0.30 ? 'Morning' : p < 0.56 ? 'Afternoon'
         : p < 0.66 ? 'Golden hour' : p < 0.78 ? 'Dusk' : 'Night';
  }

  /* ---- WMO weather codes -> what the scene should draw ---- */
  const CODES = {
    0: ['Clear', 'none'], 1: ['Mainly clear', 'none'], 2: ['Partly cloudy', 'none'],
    3: ['Overcast', 'none'], 45: ['Fog', 'none'], 48: ['Freezing fog', 'none'],
    51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy drizzle', 'rain'],
    56: ['Freezing drizzle', 'rain'], 57: ['Freezing drizzle', 'rain'],
    61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
    66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'],
    71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'],
    77: ['Snow grains', 'snow'],
    80: ['Rain showers', 'rain'], 81: ['Rain showers', 'rain'], 82: ['Heavy showers', 'rain'],
    85: ['Snow showers', 'snow'], 86: ['Snow showers', 'snow'],
    95: ['Thunderstorm', 'rain'], 96: ['Thunderstorm', 'rain'], 99: ['Thunderstorm', 'rain'],
  };
  const RATE = {
    51: 0.25, 53: 0.45, 55: 0.7, 56: 0.35, 57: 0.5,
    61: 0.35, 63: 0.6, 65: 0.95, 66: 0.5, 67: 0.7,
    71: 0.3, 73: 0.55, 75: 0.9, 77: 0.4,
    80: 0.4, 81: 0.65, 82: 1.0, 85: 0.5, 86: 0.8,
    95: 0.85, 96: 0.9, 99: 1.0,
  };

  function recompute() {
    const h = shopHours();
    env.phase = phaseFromClock(h, env.sunrise, env.sunset);
    env.phaseLabel = labelFor(env.phase);
    env.isDay = h >= env.sunrise && h <= env.sunset;
    env.hour = h;   // decimal shop-local hour, for anything keyed to opening times
    env.clockLabel = String(Math.floor(h)).padStart(2, '0') + ':' +
                     String(Math.floor((h % 1) * 60)).padStart(2, '0');
    return env;
  }

  function hourFromISO(iso) {
    // "2026-08-30T06:41" — already shop-local from the API
    const m = /T(\d{2}):(\d{2})/.exec(iso || '');
    return m ? +m[1] + +m[2] / 60 : null;
  }

  async function fetchWeather() {
    const url = 'https://api.open-meteo.com/v1/forecast' +
      '?latitude=' + LAT + '&longitude=' + LON +
      '&current=temperature_2m,weather_code,cloud_cover,precipitation,wind_speed_10m,wind_direction_10m,is_day' +
      '&daily=sunrise,sunset&timezone=' + encodeURIComponent(TZ) + '&forecast_days=1';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('weather ' + res.status);
    const j = await res.json();

    const c = j.current || {};
    const code = c.weather_code | 0;
    const info = CODES[code] || ['Clear', 'none'];

    env.code = code;
    env.conditionLabel = info[0];
    env.precip = info[1];
    env.precipRate = env.precip === 'none' ? 0 : (RATE[code] || 0.5);
    env.cloud = Math.max(0, Math.min(1, (c.cloud_cover || 0) / 100));
    env.fog = (code === 45 || code === 48) ? 0.85 : Math.max(0, (env.cloud - 0.6) * 0.5);
    env.tempC = typeof c.temperature_2m === 'number' ? c.temperature_2m : null;
    env.tempF = env.tempC == null ? null : env.tempC * 9 / 5 + 32;
    env.windSpeed = c.wind_speed_10m || 0;
    env.windDeg = c.wind_direction_10m || 0;

    const sr = hourFromISO(((j.daily || {}).sunrise || [])[0]);
    const ss = hourFromISO(((j.daily || {}).sunset || [])[0]);
    if (sr != null && ss != null && ss > sr) { env.sunrise = sr; env.sunset = ss; }

    env.live = true;
    recompute();
    return env;
  }

  const listeners = [];
  const api = {
    get: recompute,
    data: env,
    labelFor,   // the console pins a phase directly and needs the same wording
    onUpdate(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
    refresh() {
      return fetchWeather()
        .then(() => { listeners.forEach(f => { try { f(env); } catch (e) {} }); return env; })
        .catch(() => env);   // keep real local time, clear weather
    },
  };
  window.SpectrumEnv = api;

  recompute();
  api.refresh();
  setInterval(() => api.refresh(), REFRESH);
  setInterval(recompute, 15000);
})();
