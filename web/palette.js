/* JDT | web/palette.js - Ctrl+K command palette: jump to any tab, room, portal or saved location, or run a command.
   Fuzzy matched, keyboard driven, rebuilt only while open. */
'use strict';

(function () {
  window.JDT_PALETTE_EXTRA = window.JDT_PALETTE_EXTRA || [];   // other modules add their own commands
  const box = document.getElementById('palette');
  const q = document.getElementById('pal-q');
  const list = document.getElementById('pal-list');
  if (!box || !q || !list) return;

  let items = [];       // { group, label, hint, icon, run }
  let shown = [];
  let active = 0;

  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mx = () => window.JDT_MLOX || {};
  const tr = (k) => (typeof t === 'function' ? t(k) : k);
  const svg = (name) => (typeof icon === 'function' ? icon(name, 15) : '');
  const after = (fn) => setTimeout(fn, 60);   // let the tab render before acting inside it

  function collect() {
    const out = [];
    TABS.forEach((tab) => out.push({ group: 'Go to', label: tr('ui_tab_' + tab), hint: '', icon: tab, run: () => setTab(tab) }));
    const st = mx().state || {};
    (st.rooms || []).forEach((r) => out.push({
      group: 'Rooms', label: r.name || `room ${r.id}`, hint: `#${r.id}`, icon: 'interior',
      run: () => { setTab('interior'); after(() => window.openRoomModal && window.openRoomModal(r.id)); },
    }));
    (st.portals || []).forEach((p) => {
      const rn = (id) => { const r = (st.rooms || []).find((x) => x.id === id); return r ? r.name : `#${id}`; };
      out.push({
        group: 'Portals', label: `Portal ${p.id}: ${rn(p.roomFrom)} → ${rn(p.roomTo)}`, hint: p.flags ? `flags ${p.flags}` : '', icon: 'mportals',
        run: () => { setTab('mportals'); after(() => window.highlightPortal && window.highlightPortal(p.id)); },
      });
    });
    (mx().waypoints || []).slice(0, 60).forEach((w) => out.push({
      group: 'Saved locations', label: w.name, hint: `${(+w.x).toFixed(0)}, ${(+w.y).toFixed(0)}`, icon: 'locations',
      run: () => window.teleportTo && window.teleportTo(w.id),
    }));
    const cmd = (label, hint, ic, run) => out.push({ group: 'Commands', label, hint, icon: ic, run });
    cmd(mx().overlayOn ? 'Hide portal overlay' : 'Show portal overlay', '', 'mportals', () => window.toggle3DOverlay && window.toggle3DOverlay(!mx().overlayOn));
    cmd('Copy my position as vector4', '', 'locations', () => document.getElementById('readout')?.click());
    cmd('Save current location', '', 'locations', () => { setTab('locations'); after(() => window.saveWaypoint && window.saveWaypoint()); });
    cmd('Select the object I am aiming at', '', 'entities', () => { setTab('entities'); after(() => window.pickAimedEntity && window.pickAimedEntity()); });
    cmd('Scan objects in this interior', '', 'entities', () => { setTab('entities'); after(() => window.scanEntities && window.scanEntities()); });
    (window.JDT_PALETTE_EXTRA || []).forEach((fn) => { try { out.push(...fn()); } catch (e) { /* ignore a broken provider */ } });
    cmd('Export interior XML', '', 'export', () => window.openExportModal && window.openExportModal());
    cmd('Reset every room and portal change', '', 'close', () => window.resetAllChanges && window.resetAllChanges());
    return out;
  }

  // subsequence match: consecutive hits and word starts score higher; returns [score, marked html] or null
  function match(text, query) {
    if (!query) return [0, e(text)];
    const lo = text.toLowerCase();
    let qi = 0, score = 0, prev = -2;
    const hits = [];
    for (let i = 0; i < lo.length && qi < query.length; i++) {
      if (lo[i] === query[qi]) {
        score += 1 + (i === prev + 1 ? 3 : 0) + (i === 0 || /[\s_\-:#>]/.test(lo[i - 1]) ? 4 : 0);
        hits.push(i); prev = i; qi++;
      }
    }
    if (qi < query.length) return null;
    score -= text.length * 0.02;
    let html = '', h = new Set(hits);
    for (let i = 0; i < text.length; i++) html += h.has(i) ? `<mark>${e(text[i])}</mark>` : e(text[i]);
    return [score, html];
  }

  function draw() {
    const query = q.value.trim().toLowerCase();
    const scored = [];
    items.forEach((it, i) => {
      const m = match(it.label, query) || (it.hint && match(it.hint, query) ? [match(it.hint, query)[0] - 2, e(it.label)] : null);
      if (m) scored.push({ it, score: m[0], html: m[1], i });
    });
    if (query) scored.sort((a, b) => b.score - a.score || a.i - b.i);
    shown = scored.slice(0, 60);
    active = Math.min(active, Math.max(shown.length - 1, 0));
    if (!shown.length) { list.innerHTML = '<div class="pal-empty">Nothing matches. Try a room name, a portal number or a tab.</div>'; return; }
    let html = '', group = null;
    shown.forEach((s, idx) => {
      // grouped while browsing, flat (best match first) while searching
      if (!query && s.it.group !== group) { group = s.it.group; html += `<div class="pal-group">${e(group)}</div>`; }
      html += `<div class="pal-item${idx === active ? ' on' : ''}" data-i="${idx}">${svg(s.it.icon)}<b>${s.html}</b>${s.it.hint ? `<span class="pal-hint">${e(s.it.hint)}</span>` : (query ? `<span class="pal-hint">${e(s.it.group)}</span>` : '')}</div>`;
    });
    list.innerHTML = html;
    list.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  function mark(i) {
    if (!shown.length) return;
    active = (i + shown.length) % shown.length;
    list.querySelectorAll('.pal-item').forEach((el) => el.classList.toggle('on', +el.dataset.i === active));
    list.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    if (!S.visible) return;
    items = collect();
    q.value = '';
    active = 0;
    box.hidden = false;
    draw();
    q.focus();
  }
  function close() { box.hidden = true; }
  function run(i) {
    const s = shown[i];
    close();
    if (s) try { s.it.run(); } catch (err) { console.error('[JDT] palette', err); }
  }

  q.addEventListener('input', () => { active = 0; draw(); });
  list.addEventListener('mousemove', (ev) => { const r = ev.target.closest('.pal-item'); if (r && +r.dataset.i !== active) mark(+r.dataset.i); });
  list.addEventListener('mousedown', (ev) => { const r = ev.target.closest('.pal-item'); if (r) { ev.preventDefault(); run(+r.dataset.i); } });
  box.addEventListener('mousedown', (ev) => { if (ev.target === box) close(); });
  document.getElementById('cmd-open')?.addEventListener('click', open);

  // capture phase: the palette owns the keyboard while it is open (Esc closes it, not the whole panel)
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault(); ev.stopPropagation();
      return box.hidden ? open() : close();
    }
    if (box.hidden) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); mark(active + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); mark(active - 1); }
    else if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); run(active); }
  }, true);

  window.JDT_PALETTE = { open, close, get open_() { return !box.hidden; } };
})();
