/* Every page except /diorama: the header's current-page marker, the spacer that holds
   its place under the fixed bar, and (home only) the clear-to-solid switch on scroll. */
(function () {
  const bar = document.querySelector('[data-header]');
  if (!bar) return;

  // Current page. Handles /about, /about.html and / alike (GitHub Pages serves both).
  const here = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '') || 'index';
  bar.querySelectorAll('[data-nav] a').forEach((a) => {
    if ((a.getAttribute('href') || '').replace(/\.html$/, '') === here) a.setAttribute('aria-current', 'page');
  });

  // The bar is position:fixed; the spacer keeps the page below it in place. The bar wraps
  // to two rows on narrow screens, so track its real height.
  const spacer = document.querySelector('[data-header-spacer]');
  // Never write 0: before first layout offsetHeight reads 0, and the markup's 76px default
  // is the right answer until a real measurement arrives.
  const fit = () => { const h = bar.offsetHeight; if (spacer && h) spacer.style.height = h + 'px'; };
  if (window.ResizeObserver) new ResizeObserver(fit).observe(bar, { box: 'border-box' });
  window.addEventListener('resize', fit);
  window.addEventListener('load', fit);
  fit();

  if (bar.hasAttribute('data-overlay')) {
    const check = () => bar.classList.toggle('is-solid', window.scrollY >= window.innerHeight - 90);
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    check();
  }
})();
