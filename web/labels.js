/* JDT | web/labels.js - in-world labels drawn as HTML instead of GTA text.
   Lua sends label data when it changes ('labelsData') and screen positions when they move ('labels').
   Positions are applied as GPU transforms; nothing here runs unless a label exists. */
'use strict';

(function () {
  const layer = document.createElement('div');
  layer.id = 'labels';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);

  const FLAG_SHORT = { 1: 'one-way', 2: 'MLO link', 4: 'mirror', 8: 'no timecycle', 16: 'expensive mirror', 32: 'low LOD', 64: 'door hides', 128: 'mirror sun', 256: 'mirror portals', 512: 'mirror floor', 1024: 'mirror exterior', 2048: 'water', 4096: 'horizon', 8192: 'light bleed' };
  const data = new Map();      // id -> label data
  const groups = new Map();    // group -> Set(ids)
  const nodes = new Map();     // id -> element
  let positions = [];

  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ov = () => (window.JDT_OVERLAY ? window.JDT_OVERLAY.get() : { fields: { id: true, rooms: true, flags: true }, textScale: 1 });
  const num = (v) => Number(v) || 0;
  const hashNum = (v) => String(Number(v) >>> 0);

  function flagChips(flag) {
    const out = [];
    for (let b = 1; b <= 8192; b <<= 1) if (flag & b) out.push(`<span class="lb-chip">${FLAG_SHORT[b]}</span>`);
    return out.join('');
  }

  // rooms of one MLO share a long prefix (V_Michael_G_...): labels drop it, like the graph does
  const rn = (name) => {
    const st = window.JDT_MLOX && window.JDT_MLOX.state;
    const pre = st && typeof roomNamePrefix === 'function' ? roomNamePrefix((st.rooms || []).map((r) => r.name)) : '';
    return typeof shortRoom === 'function' ? shortRoom(String(name ?? ''), pre) : String(name ?? '');
  };

  // icons drawn in the tab of each tag
  const IC = {
    entity: '<svg viewBox="0 0 16 16"><path d="M8 1.5l5.5 3v7L8 14.5 2.5 11.5v-7z M2.5 4.5L8 7.5l5.5-3 M8 7.5v7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    emitter: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="1.6" fill="currentColor"/><path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    nav: '<svg viewBox="0 0 16 16"><path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  };
  const yes = (on, a, b) => `<span class="lb-st ${on ? 'on' : 'off'}">${on ? a : b}</span>`;
  const m1 = (v) => `${num(v).toFixed(1)}<i>m</i>`;

  // every tag: a colour tab (id or icon) + a body; positions and the callout leader are done in apply()
  function html(d) {
    const f = ov().fields || {};
    if (d.k === 'portal') {
      const oneWay = d.flag & 1;
      const from = d.fromName ? rn(d.fromName) : d.from, to = d.toName ? rn(d.toName) : d.to;
      const route = f.rooms
        ? `<span class="lb-route"><b>${e(from)}</b>${f.ids ? `<i>${d.from}</i>` : ''}<span class="lb-dir">${oneWay ? '→' : '⇄'}</span><b>${e(to)}</b>${f.ids ? `<i>${d.to}</i>` : ''}</span>`
        : (f.ids ? `<span class="lb-route"><b>${d.from}</b><span class="lb-dir">${oneWay ? '→' : '⇄'}</span><b>${d.to}</b></span>` : '');
      const facts = [
        f.flags && d.flag ? `<span class="lb-flag">${d.flag}</span>` : '',
        f.flagNames && d.flag ? flagChips(d.flag) : '',
        f.entities && d.attached ? `<span class="lb-chip">${d.attached} attached</span>` : '',
      ].join('');
      return `<div class="lb-tab">${f.id ? `P${d.i}` : ''}</div><div class="lb-main">
        <div class="lb-head">${route || '<b>Portal</b>'}${f.distance ? `<span class="lb-d">${m1(d.dist)}</span>` : ''}</div>
        ${facts ? `<div class="lb-facts">${facts}</div>` : ''}</div>`;
    }
    if (d.k === 'entity') {
      return `<div class="lb-tab">${IC.entity}</div><div class="lb-main">
        <div class="lb-head"><b class="lb-name">${e(d.name)}</b><span class="lb-d">${m1(d.dist)}</span></div>
        <div class="lb-sub"><span class="lb-mono">${hashNum(d.hash)}</span>${d.room ? `<span>${e(rn(d.room))}</span>` : ''}${d.door ? '<span class="lb-chip">door</span>' : ''}${d.changed ? '<span class="lb-chip lb-chg">changed</span>' : ''}</div>
        <div class="lb-grid">
          <span>Position</span><b>${num(d.x).toFixed(2)}<i>,</i> ${num(d.y).toFixed(2)}<i>,</i> ${num(d.z).toFixed(2)}</b>
          <span>Heading</span><b>${num(d.h).toFixed(1)}<i>°</i></b>
          <span>Size</span><b>${d.sx}<i>×</i>${d.sy}<i>×</i>${d.sz}<i>m</i></b>
          ${d.lod ? `<span>LOD</span><b>${Math.round(num(d.lod))}<i>m</i></b>` : ''}
        </div>
        <div class="lb-facts">${yes(d.visible, 'visible', 'hidden')}${yes(d.collision !== false, 'collision', 'no collision')}${d.frozen ? '<span class="lb-st on">frozen</span>' : ''}${num(d.alpha) < 255 ? `<span class="lb-st">alpha ${d.alpha}</span>` : ''}</div>
      </div>`;
    }
    if (d.k === 'nav') return `<div class="lb-tab">${IC.nav}</div><div class="lb-main"><div class="lb-head"><b>${d.title ? e(d.title) : `Portal ${e(d.portal)}`}</b><span class="lb-d lb-big">${m1(d.dist)}</span></div></div>`;
    if (d.k === 'emitter') {
      const state = d.enabled === false ? '<span class="lb-st off">off</span>' : d.playing ? '<span class="lb-st on">playing</span>' : '<span class="lb-st">silent</span>';
      return `<div class="lb-tab">${IC.emitter}</div><div class="lb-main">
        <div class="lb-head"><b class="lb-name">${e(d.name)}</b><span class="lb-d">${m1(d.dist)}</span></div>
        <div class="lb-facts">${state}${d.vanilla ? '<span class="lb-chip">game</span>' : ''}${d.pack ? '<span class="lb-chip">pack</span>' : ''}${d.what ? `<span class="lb-mono lb-what">${e(d.what)}</span>` : ''}</div></div>`;
    }
    return '';
  }

  function node(id) {
    let n = nodes.get(id);
    const d = data.get(id);
    if (!d) return null;
    if (!n) {
      n = document.createElement('div');
      n.className = `lb lb-${d.k}`;
      // reticle on the exact point, an elbow leader, and the tag at its end (CAD-style callout)
      n.innerHTML = '<i class="lb-pin"></i><i class="lb-lead"></i><div class="lb-body"></div>';
      layer.appendChild(n);
      nodes.set(id, n);
      n._sig = '';
    }
    const sig = JSON.stringify(d) + '|' + JSON.stringify(ov().fields || {});
    if (sig !== n._sig) {
      n._sig = sig;
      n.querySelector('.lb-body').innerHTML = html(d);
      n.classList.toggle('sel', !!d.sel);
      if (d.color) n.style.setProperty('--c', d.color);
    }
    return n;
  }

  function apply() {
    const W = window.innerWidth, H = window.innerHeight;
    const scale = Math.max(0.6, Math.min(1.8, Number(ov().textScale) || 1));
    const seen = new Set();
    positions.forEach(([id, x, y, dist], z) => {
      const n = node(id);
      if (!n) return;
      seen.add(id);
      // gentle size falloff with distance, user text size on top
      const s = scale * Math.max(0.78, Math.min(1, 7 / Math.max(dist, 0.1)));
      n.style.transform = `translate3d(${(x * W).toFixed(1)}px, ${(y * H).toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
      n.style.zIndex = String(z + 1);
      const flip = x > 0.7;   // near the right edge the callout points left, so the tag stays on screen
      if (n._flip !== flip) { n._flip = flip; n.classList.toggle('lb-l', flip); }
      if (n.hidden) n.hidden = false;
    });
    nodes.forEach((n, id) => {
      if (!data.has(id)) { n.remove(); nodes.delete(id); return; }
      if (!seen.has(id) && !n.hidden) n.hidden = true;
    });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.action === 'labels') { positions = Array.isArray(m.data) ? m.data : []; apply(); }
    else if (m.action === 'labelsData' && m.data) {
      const g = String(m.data.group);
      (groups.get(g) || new Set()).forEach((id) => data.delete(id));
      const ids = new Set();
      const items = m.data.items && typeof m.data.items === 'object' ? m.data.items : {};
      Object.entries(items).forEach(([id, d]) => { if (d && d.k) { data.set(id, d); ids.add(id); } });
      groups.set(g, ids);
      apply();
    }
  });
  window.addEventListener('resize', apply);

  window.JDT_LABELS = { refresh: () => { nodes.forEach((n) => { n._sig = ''; }); apply(); }, count: () => nodes.size };
})();
