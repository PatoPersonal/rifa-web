(function(){
  const lb = document.getElementById('lightbox');
  if (!lb) return;
  const imgEl = document.getElementById('lightbox-img');
  const captionEl = document.getElementById('lightbox-caption');
  const counterEl = document.getElementById('lightbox-counter');
  const btnClose = document.getElementById('lightbox-close');
  const btnPrev = document.getElementById('lightbox-prev');
  const btnNext = document.getElementById('lightbox-next');

  let current = [];
  let idx = 0;
  let lastFocus = null;

  function show(i){
    if (!current.length) return;
    idx = (i + current.length) % current.length;
    const item = current[idx];
    imgEl.src = item.src;
    imgEl.alt = item.alt || '';
    captionEl.textContent = item.alt || '';
    captionEl.style.display = item.alt ? '' : 'none';
    counterEl.textContent = (idx + 1) + ' / ' + current.length;
    const single = current.length <= 1;
    btnPrev.disabled = single;
    btnNext.disabled = single;
    btnPrev.style.display = single ? 'none' : '';
    btnNext.style.display = single ? 'none' : '';
  }
  function openLb(items, i){
    current = items;
    lastFocus = document.activeElement;
    lb.classList.add('is-open');
    lb.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lightbox-open');
    show(i);
    btnClose.focus();
  }
  function closeLb(){
    lb.classList.remove('is-open');
    lb.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lightbox-open');
    imgEl.src = '';
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }
  function next(){ show(idx + 1); }
  function prev(){ show(idx - 1); }

  document.querySelectorAll('.gallery-grid').forEach(grid => {
    const links = Array.from(grid.querySelectorAll('a.gallery-item'));
    if (!links.length) return;
    const items = links.map(a => {
      const img = a.querySelector('img');
      return { src: a.getAttribute('href'), alt: img ? img.getAttribute('alt') : '' };
    });
    links.forEach((a, i) => {
      a.addEventListener('click', e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
        e.preventDefault();
        openLb(items, i);
      });
    });
  });

  btnClose.addEventListener('click', closeLb);
  btnPrev.addEventListener('click', prev);
  btnNext.addEventListener('click', next);
  lb.addEventListener('click', e => { if (e.target === lb) closeLb(); });

  document.addEventListener('keydown', e => {
    if (!lb.classList.contains('is-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeLb(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  });

  let touchX = null, touchY = null;
  imgEl.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  }, { passive: true });
  imgEl.addEventListener('touchend', e => {
    if (touchX == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX;
    const dy = t.clientY - touchY;
    touchX = touchY = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) next(); else prev();
    }
  }, { passive: true });
})();
