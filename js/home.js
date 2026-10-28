/* Home page hero: the copy fades in over the live diorama after a few seconds;
   "Explore the shop" hands the scene the pointer (orbit, zoom, close-ups) and hides the
   copy; Esc, the close button or scrolling away hands it back. On phones, a pre-rendered
   loop (assets/diorama-loop.mp4) replaces the live scene if that file exists. */
(function () {
  const stage = () => document.querySelector('shop-diorama');
  let showCopy = false, exploring = false;

  function paint() {
    const on = showCopy && !exploring;
    document.querySelectorAll('[data-copy]').forEach((el) => {
      const k = el.dataset.copy;
      if (k.includes('opacity')) el.style.opacity = on ? '1' : '0';
      if (k.includes('shift')) el.style.transform = 'translateY(' + (on ? '0px' : '14px') + ')';
      if (k.includes('pe')) el.style.pointerEvents = on ? 'auto' : 'none';
    });
    document.querySelectorAll('[data-when="exploring"]').forEach((el) => (el.style.display = exploring ? 'contents' : 'none'));
  }

  function setExplore(on) {
    const el = stage();
    if (el && el.setExplore) el.setExplore(on);
    if (on && window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
    exploring = on;
    paint();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'explore') setExplore(true);
    if (a.dataset.action === 'leave') setExplore(false);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && exploring) setExplore(false); });
  window.addEventListener('scroll', () => { if (exploring && window.scrollY > 60) setExplore(false); }, { passive: true });

  // Let the scene play on its own before the copy arrives.
  setTimeout(() => { showCopy = true; paint(); }, 2800);

  // Phones: swap to the video loop if one has been exported.
  if (window.matchMedia('(max-width: 760px), (pointer: coarse)').matches) {
    const src = 'assets/diorama-loop.mp4';
    fetch(src, { method: 'HEAD' }).then((r) => {
      if (!r.ok) return;
      const slot = document.querySelector('[data-hero-video-slot]');
      if (!slot) return;
      const v = document.createElement('video');
      Object.assign(v, { src, muted: true, loop: true, autoplay: true, playsInline: true });
      v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
      v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover';
      const live = (on) => document.querySelectorAll('[data-when="live"]').forEach((el) => (el.style.display = on ? 'contents' : 'none'));
      const fail = () => { v.remove(); live(true); };
      v.addEventListener('error', fail);
      v.addEventListener('playing', () => { live(false); const d = stage(); if (d) d.remove(); }, { once: true });
      slot.appendChild(v);
      if (v.play) v.play().catch(() => {});
      setTimeout(() => { if (v.readyState < 2) fail(); }, 3500);
    }).catch(() => {});
  }
})();
