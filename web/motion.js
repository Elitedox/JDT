/* JDT | web/motion.js - feel of the panel:
     * inertial wheel scrolling (CEF in FiveM scrolls in hard 100 px steps; this eases every list)
     * scroll-edge shadows so you can see there is more above / below
     * a soft light that follows the cursor over buttons, tabs and rows
   One delegated listener each; nothing runs while the mouse is still. */
'use strict';

(function () {
  const root = document.documentElement;
  const smoothOn = () => root.classList.contains('smooth') && !matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------- inertial wheel */
  const SKIP = '#graph-svg, input[type=range], select, textarea, .rdd-menu';
  const anim = new WeakMap();   // element -> { target, raf }

  function scrollable(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1) {
        const oy = getComputedStyle(n).overflowY;
        if (oy === 'auto' || oy === 'scroll') return n;
      }
    }
    return null;
  }

  function stop(st) { if (st.raf) cancelAnimationFrame(st.raf); st.raf = 0; st.busy = false; st.last = null; }
  function step(el) {
    const st = anim.get(el);
    if (!st) return;
    const max = el.scrollHeight - el.clientHeight;
    st.target = Math.max(0, Math.min(max, st.target));
    const cur = el.scrollTop;
    // the list was scrolled some other way (scrollbar, arrows, keys, a re-render): let it be
    if (st.last !== null && Math.abs(cur - st.last) > 2) return stop(st);
    const diff = st.target - cur;
    if (Math.abs(diff) < 1.5) { el.scrollTop = st.target; return stop(st); }
    st.busy = true;
    // ease out: 20 % of the remaining distance per frame, at least a whole pixel (scrollTop can round
    // a smaller move away, which used to leave the animation running forever, pulling the list back)
    const move = Math.sign(diff) * Math.max(1, Math.abs(diff) * 0.2);
    el.scrollTop = cur + move;
    if (Math.abs(el.scrollTop - cur) < 0.5) { el.scrollTop = st.target; return stop(st); }   // could not move: stop
    st.last = el.scrollTop;
    st.raf = requestAnimationFrame(() => step(el));
  }
  // grabbing a scrollbar or pressing a key ends any wheel animation at once
  const stopUnder = (ev) => { for (let n = ev.target; n && n.nodeType === 1; n = n.parentElement) { const st = anim.get(n); if (st) stop(st); } };
  document.addEventListener('mousedown', stopUnder, true);
  document.addEventListener('keydown', stopUnder, true);

  document.addEventListener('wheel', (ev) => {
    if (!smoothOn() || ev.ctrlKey || ev.defaultPrevented || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
    if (ev.target.closest && ev.target.closest(SKIP)) return;
    const el = scrollable(ev.target);
    if (!el) return;
    ev.preventDefault();
    let st = anim.get(el);
    if (!st) { st = { target: el.scrollTop, raf: 0, busy: false, last: null }; anim.set(el, st); }
    if (!st.busy) { st.target = el.scrollTop; st.last = null; }   // the user may have dragged the scrollbar since
    const unit = ev.deltaMode === 1 ? 36 : ev.deltaMode === 2 ? el.clientHeight : 1;
    st.target += ev.deltaY * unit * 0.9;
    if (!st.raf) st.raf = requestAnimationFrame(() => step(el));
  }, { passive: false, capture: true });

  /* ---------------------------------------------------------------- scroll-edge shadows */
  const EDGE = '.mx-scroll, main#view, .modal-body, .pal-list, .flag-grid';
  function edges(el) {
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    if (el.classList.contains('sh-top') !== top) el.classList.toggle('sh-top', top);
    if (el.classList.contains('sh-bot') !== bottom) el.classList.toggle('sh-bot', bottom);
  }
  document.addEventListener('scroll', (ev) => {
    const el = ev.target;
    if (el && el.matches && el.matches(EDGE)) edges(el);
  }, true);
  // lists are re-rendered by the panel: re-check their edges after each change
  let edgeQueued = false;
  new MutationObserver(() => {
    if (edgeQueued) return;
    edgeQueued = true;
    requestAnimationFrame(() => { edgeQueued = false; document.querySelectorAll(EDGE).forEach(edges); });
  }).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });

  /* ---------------------------------------------------------------- cursor light */
  const LIT = '.btn, .nav-btn, .room-card, .portal-card, .ent-card, .wp-card, .es-card, .tc-chip, .theme-card, .flag-item, .pal-item, .stat-chip, .insp-ctrl, .toggle-row, .ov-chip, .pflag-edit, .ent-mini-btn';
  let litEl = null, raf = 0, px = 0, py = 0;
  document.addEventListener('pointermove', (ev) => {
    px = ev.clientX; py = ev.clientY;
    const el = ev.target.closest ? ev.target.closest(LIT) : null;
    if (el !== litEl) { if (litEl) litEl.classList.remove('lit'); litEl = el; if (el) el.classList.add('lit'); }
    if (!el || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!litEl) return;
      const r = litEl.getBoundingClientRect();
      litEl.style.setProperty('--mx', `${(px - r.left).toFixed(0)}px`);
      litEl.style.setProperty('--my', `${(py - r.top).toFixed(0)}px`);
    });
  }, { passive: true });
  document.addEventListener('pointerleave', () => { if (litEl) litEl.classList.remove('lit'); litEl = null; });
})();
