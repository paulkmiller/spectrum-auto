/* /diorama: the secret effects console. ↑ ↑ ↓ ↓ ← → ← → B A, then Enter, toggles it.
   Pins time of day, weather (and its intensity) and holiday dressing on the scene via
   the <shop-diorama> element's methods. "Live" returns everything to the real feed. */
(function () {
  const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a', 'Enter'];
  const DAY_PHASES = { live: null, dawn: 0.03, morning: 0.17, midday: 0.3, golden: 0.62, dusk: 0.73, night: 0.88 };
  const RATES = { calm: 0.3, steady: 0.6, heavy: 0.95 };
  const state = { day: 'live', wx: 'live', rate: 'steady', hol: 'live' };
  const panel = document.querySelector('[data-console]');
  const stage = () => document.querySelector('shop-diorama');

  // Cloud / fog values that make each condition read at a glance; `label` is what the
  // on-screen readout shows while pinned (Overcast and Fog don't precipitate).
  function wxPayload(key, rateKey) {
    const r = RATES[rateKey] ?? 0.6;
    switch (key) {
      case 'clear': return { label: 'clear', cloud: 0.04, precip: 'none', precipRate: 0, fog: 0 };
      case 'overcast': return { label: 'overcast', cloud: 0.95, precip: 'none', precipRate: 0, fog: 0.12 };
      case 'rain': return { label: 'rain', cloud: 0.88, precip: 'rain', precipRate: r, fog: 0.18 };
      case 'snow': return { label: 'snow', cloud: 0.82, precip: 'snow', precipRate: r, fog: 0.28 };
      case 'fog': return { label: 'fog', cloud: 0.6, precip: 'none', precipRate: 0, fog: 0.55 + r * 0.45 };
      default: return null;
    }
  }

  const SKIN_ON = { borderColor: 'rgba(232,178,58,0.55)', background: 'rgba(232,178,58,0.16)', color: '#F0CB77' };
  const SKIN_OFF = { borderColor: 'rgba(237,234,228,0.14)', background: 'rgba(237,234,228,0.04)', color: '#B9B3A9' };
  function paint() {
    document.querySelectorAll('[data-opt]').forEach((b) => {
      const [g, k] = b.dataset.opt.split(':');
      Object.assign(b.style, state[g] === k ? SKIN_ON : SKIN_OFF);
    });
    const hint = document.querySelector('[data-hint]');
    if (hint) hint.textContent = (state.wx === 'rain' || state.wx === 'snow' || state.wx === 'fog')
      ? 'Rain runs the gutters and downpipes. Lamps and wall packs follow whatever hour you pin.'
      : 'Pin an hour or a condition, or leave both on Live to follow Papillion in real time. Enter the code again to close.';
  }

  function pick(group, key) {
    const el = stage();
    state[group] = key;
    if (!el) return paint();
    if (group === 'day' && el.setDayPhase) el.setDayPhase(DAY_PHASES[key]);
    if ((group === 'wx' || group === 'rate') && el.setWeather) el.setWeather(wxPayload(state.wx, state.rate));
    if (group === 'hol' && el.setHoliday) el.setHoliday(key === 'live' ? null : key);
    paint();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-opt]');
    if (b) { const [g, k] = b.dataset.opt.split(':'); pick(g, k); return; }
    if (e.target.closest('[data-action="reset"]')) {
      const el = stage();
      if (el) { el.setDayPhase && el.setDayPhase(null); el.setWeather && el.setWeather(null); el.setHoliday && el.setHoliday(null); }
      Object.assign(state, { day: 'live', wx: 'live', hol: 'live' });
      paint();
    }
  });

  let progress = 0;
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    const got = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (got === KONAMI[progress]) {
      if (++progress === KONAMI.length) {
        progress = 0; e.preventDefault();
        if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
      }
    } else progress = got === KONAMI[0] ? 1 : 0;
  });
})();
