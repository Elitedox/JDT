/* JDT | web/emitters.js - Audio > Emitters: every audio emitter around you, nearest first,
   with a live in-world view (markers, ranges, HTML labels) and "Locate" to walk to one.
   The list refreshes in place (no re-render) while the tab is open; nothing polls otherwise. */
'use strict';

(function () {
  const KEY = 'jdt:emit';
  const DEF = { on: false, distance: 50, max: 5, ranges: true, labels: true, placed: true, static: true, radius: 180 };
  const load = () => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || '{}'), locate: null }; } catch (e) { return { ...DEF, locate: null }; } };
  let EM = load();
  let list = [], total = 0, timer = 0, filter = '', busy = false;
  const save = () => { try { const { locate, ...keep } = EM; localStorage.setItem(KEY, JSON.stringify(keep)); } catch (e) { /* storage unavailable */ } };
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const TYPE = {
    sound: ['Sound', '#7fa8d9'], ambient: ['Ambient', '#4fd1c5'], radio: ['Radio', '#ffad6b'], static: ['Static emitter', '#58c98b'],
    zone: ['Zone', '#e46a8c'], prop: ['Prop', '#b18cff'], vanilla: ['Game emitter', '#ffd166'],
  };

  ICON.emitters = '<circle cx="10" cy="10" r="1.8" fill="currentColor"/><path d="M6.6 6.6a4.8 4.8 0 0 0 0 6.8M13.4 6.6a4.8 4.8 0 0 1 0 6.8M4.1 4.1a8.3 8.3 0 0 0 0 11.8M15.9 4.1a8.3 8.3 0 0 1 0 11.8"/>';
  const audio = NAV.find((g) => g.sec === 'ui_nav_audio');
  if (audio && !audio.tabs.includes('emitters')) audio.tabs.splice(audio.tabs.indexOf('map') + 1, 0, 'emitters');
  if (!TABS.includes('emitters')) TABS.splice(TABS.indexOf('map') + 1, 0, 'emitters');

  // factory reset: back to defaults, nothing drawn in the world
  window.JDT_EMIT_RESET = () => { EM = { ...DEF, locate: null }; return sendView(); };

  function sendView() {
    save();
    return nui('emit:view', { on: EM.on, distance: EM.distance, max: EM.max, ranges: EM.ranges, labels: EM.labels, placed: EM.placed, static: EM.static, locate: EM.locate || false });
  }

  const sw = (id, on, fn) => `<label class="sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} onchange="${fn}"><span class="sw-track"><span class="sw-thumb"></span></span></label>`;
  const chip = (k, label) => `<button class="ov-chip${EM[k] ? ' on' : ''}" onclick="emSet('${k}', ${!EM[k]})">${label}</button>`;

  VIEWS.emitters = () => `
    <div class="toggle-row">
      <span class="trow-label">Show emitters in the world <span class="mx-count" id="em-sum">${EM.on ? `nearest ${EM.max} within ${EM.distance} m` : 'off'}</span></span>
      ${sw('em-on', EM.on, 'emSet(\'on\', this.checked)')}
    </div>
    <div class="em-controls">
      <div class="ov-row"><span class="ov-k">Draw distance</span><input type="range" class="dist-range" min="10" max="300" step="5" value="${EM.distance}" oninput="emSet('distance', +this.value, true)"><span class="dist-val ov-v" id="em-v-distance">${EM.distance}m</span></div>
      <div class="ov-row"><span class="ov-k">Max shown</span><input type="range" class="dist-range" min="1" max="60" step="1" value="${EM.max}" oninput="emSet('max', +this.value, true)"><span class="dist-val ov-v" id="em-v-max">${EM.max}</span></div>
      <div class="ov-fields">${chip('placed', 'Placed with JDT')}${chip('static', 'Game emitters')}${chip('ranges', 'Ranges')}${chip('labels', 'Labels')}</div>
    </div>
    <div class="em-locate" id="em-locate"></div>
    <div class="ent-toolbar">
      <div class="ent-search-wrap"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="9" r="5.5"/><path d="M13.2 13.2L17 17"/></svg>
        <input id="em-filter" class="field-input" type="text" placeholder="Filter by name, sound or station" spellcheck="false" autocomplete="off" value="${e(filter)}" oninput="emFilter(this.value)"></div>
      <span class="ent-sort-label">List radius</span>
      <input type="range" class="dist-range" min="20" max="500" step="10" value="${EM.radius}" oninput="emSet('radius', +this.value, true)"><span class="dist-val" id="em-v-radius">${EM.radius}m</span>
      <button class="btn primary sm" onclick="emLocateNearest()">Locate nearest</button>
    </div>
    <div class="mx-scroll" id="em-list"></div>`;

  function locateBar() {
    if (!EM.locate) return '';
    const it = list.find((x) => x.id === EM.locate);
    return `<div class="em-loc"><span class="em-loc-dot"></span><span>Showing the way to <b>${e(it ? it.label : EM.locate)}</b></span>
      <span class="mono em-loc-d">${it ? `${it.dist.toFixed(1)} m` : ''}</span>
      <button class="btn sm outline" onclick="emLocate(null)">Stop</button></div>`;
  }

  // play / pause / solo / edit for emitters you placed; on / off for the game's own
  function controls(x) {
    if (x.src === 'placed') {
      if (x.type === 'prop') return `<button class="pflag-edit" onclick="emEdit('${e(x.id)}')">Edit</button>`;
      const paused = S.overrides && S.overrides[x.id] === false;
      const solo = S.solo === x.id;
      return `<button class="em-ic${paused ? '' : x.playing ? ' on' : ''}" data-el-toggle="${e(x.id)}" title="${paused ? 'Resume (only for you)' : 'Pause (only for you)'}">${icon(paused || !x.playing ? 'play' : 'pause', 12)}</button>
        <button class="em-ic${solo ? ' on' : ''}" data-el-solo="${e(x.id)}" title="${solo ? 'Stop solo' : 'Solo: hear only this one'}">${icon('solo', 12)}</button>
        <button class="pflag-edit" onclick="emEdit('${e(x.id)}')">Edit</button>`;
    }
    const owned = ownerOf(x.label);
    return `<button class="em-ic${x.enabled ? ' on' : ''}" onclick="emStatic('${e(x.label)}', ${!x.enabled})" title="${x.enabled ? 'Turn this game emitter off (only now)' : 'Turn this game emitter on (only now)'}">${icon(x.enabled ? 'pause' : 'play', 12)}</button>
      ${x.override ? `<button class="em-ic" onclick="emStatic('${e(x.label)}', null)" title="Back to the game's default">↺</button>` : ''}
      <button class="pflag-edit${owned ? ' on' : ''}" onclick="emEditGame('${e(x.id)}')" title="${owned ? 'Edit your saved settings for this emitter' : 'Save on / off and radio station for this emitter (for everyone, exported with your MLO)'}">${owned ? 'Edit' : 'Take over'}</button>`;
  }

  // one row without its live part (distance / direction): that part is patched in place every poll,
  // so rows are only rebuilt when something you can see in them actually changed
  function rowHTML(x) {
    const [tname, col] = TYPE[x.type] || [x.type, '#7fa8d9'];
    return `<div class="em-row${x.enabled ? '' : ' off'}${EM.locate === x.id ? ' loc' : ''}" style="--tc:${col}" data-id="${e(x.id)}">
        <span class="em-type" title="${e(tname)}"></span>
        <div class="em-main">
          <div class="em-top"><span class="em-name">${e(x.label)}</span>${x.playing ? '<span class="em-play">Playing</span>' : ''}${x.enabled ? '' : '<span class="tag-changed" style="color:var(--fg-3)">Off</span>'}</div>
          <div class="em-sub"><span>${e(tname)}</span>${x.what ? `<span class="mono">${e(x.what)}</span>` : ''}</div>
        </div>
        <div class="em-where"><svg class="em-arrow" viewBox="0 0 20 20" width="16" height="16"><path d="M10 2l5 13-5-3-5 3z" fill="currentColor"/></svg><span class="em-dist"></span><span class="em-dz"></span></div>
        <div class="em-actions">
          ${controls(x)}
          <button class="pflag-edit${EM.locate === x.id ? ' on' : ''}" onclick="emLocate('${e(x.id)}')">${EM.locate === x.id ? 'Locating' : 'Locate'}</button>
          ${S.ui.allowTeleport !== false ? `<button class="pflag-edit" onclick="emGo('${e(x.id)}')">Go to</button>` : ''}
        </div>
      </div>`;
  }
  const angles = new Map();   // id -> last arrow angle, unwrapped so 359 -> 1 turns 2 degrees, not 358
  function patchWhere(node, x) {
    let a = -x.bearing;
    const prev = angles.get(x.id);
    if (prev !== undefined) { const d = ((a - prev) % 360 + 540) % 360 - 180; a = prev + d; }
    angles.set(x.id, a);
    const arrow = node.querySelector('.em-arrow');
    if (arrow) arrow.style.transform = `rotate(${a.toFixed(1)}deg)`;
    const dist = node.querySelector('.em-dist');
    const dt = `${x.dist.toFixed(1)} m`;
    if (dist && dist.textContent !== dt) dist.textContent = dt;
    const dz = node.querySelector('.em-dz');
    const zt = x.dz > 1.5 ? `▲ ${x.dz.toFixed(1)}` : x.dz < -1.5 ? `▼ ${(-x.dz).toFixed(1)}` : '';
    if (dz && dz.textContent !== zt) { dz.textContent = zt; dz.title = x.dz > 0 ? 'Above you' : 'Below you'; }
  }
  function visibleRows() {
    const q = filter.trim().toLowerCase();
    return list.filter((x) => !q || `${x.label} ${x.what} ${x.type}`.toLowerCase().includes(q));
  }
  function emptyHTML() {
    return `<div class="mx-empty">${total ? 'Nothing matches the filter.' : `<strong>No emitters within ${EM.radius} m.</strong><br>Raise the list radius, or place one from Library.`}</div>`;
  }
  // a placed "static" element that already controls this game emitter
  const ownerOf = (name) => (S.elements || []).find((el) => el.type === 'static' && el.static && String(el.static.name).toLowerCase() === String(name).toLowerCase());

  // refresh the list in place: rows that did not change are kept as they are (hover light, animations,
  // focus), only distance and direction are updated; rows move only when the order really changed
  function paint() {
    const box = document.getElementById('em-list');
    if (box) {
      const rows = visibleRows();
      if (!rows.length) {
        const h = emptyHTML();
        if (box._empty !== h) { box.innerHTML = h; box._empty = h; }
      } else {
        if (box._empty) { box.innerHTML = ''; box._empty = null; }
        const have = new Map([...box.querySelectorAll(':scope > .em-row')].map((n) => [n.dataset.id, n]));
        const tmp = document.createElement('div');
        rows.forEach((x, i) => {
          const html = rowHTML(x);
          let n = have.get(x.id);
          if (!n || n._sig !== html) {
            tmp.innerHTML = html;
            const fresh = tmp.firstElementChild;
            fresh._sig = html;
            if (n) { if (n.classList.contains('lit')) fresh.classList.add('lit'); fresh.style.cssText += n.style.cssText.match(/--m[xy][^;]*;/g)?.join('') || ''; n.replaceWith(fresh); }
            n = fresh;
          }
          have.delete(x.id);
          patchWhere(n, x);
          if (box.children[i] !== n) box.insertBefore(n, box.children[i] || null);
        });
        have.forEach((n) => n.remove());
      }
    }
    const lb = document.getElementById('em-locate');
    if (lb) {
      const it = EM.locate && list.find((x) => x.id === EM.locate);
      const key = EM.locate ? `${EM.locate}|${it ? it.label : ''}` : '';
      if (lb._key !== key) { lb.innerHTML = locateBar(); lb._key = key; }
      else if (it) { const d = lb.querySelector('.em-loc-d'); if (d) d.textContent = `${it.dist.toFixed(1)} m`; }
    }
    const sum = document.getElementById('em-sum');
    if (sum) sum.textContent = EM.on ? `nearest ${EM.max} within ${EM.distance} m` : 'off';
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const r = await nui('emit:near', { radius: EM.radius, limit: 150, placed: EM.placed, static: EM.static });
      list = Array.isArray(r && r.list) ? r.list : [];
      total = (r && r.total) || 0;
      if (S.tab === 'emitters' && S.visible) paint();
    } finally { busy = false; }
  }
  document.addEventListener('click', (ev) => {
    if (S.tab === 'emitters' && ev.target.closest && ev.target.closest('[data-el-toggle], [data-el-solo]')) setTimeout(poll, 150);
  });
  function startPoll() { stopPoll(); poll(); timer = setInterval(() => { if (S.visible && S.tab === 'emitters') poll(); }, 700); }
  function stopPoll() { clearInterval(timer); timer = 0; }

  let sendT = 0;
  window.emSet = (k, v, live) => {
    EM[k] = v;
    const out = document.getElementById(`em-v-${k}`);
    if (out) out.textContent = k === 'max' ? v : `${v}m`;
    clearTimeout(sendT);
    if (k === 'radius') { sendT = setTimeout(poll, 120); save(); return; }
    sendT = setTimeout(sendView, live ? 90 : 0);
    if (!live) render();
    else paint();
  };
  window.emFilter = (v) => { filter = v; paint(); };
  window.emLocate = (id) => {
    EM.locate = id && EM.locate !== id ? id : null;
    sendView();
    paint();
    if (EM.locate) toast('success', 'Showing the way', 'Follow the orange path on the floor.');
  };
  window.emLocateNearest = async () => {
    await poll();
    const it = list.find((x) => x.enabled) || list[0];
    if (!it) { toast('error', 'No emitters nearby', `Nothing within ${EM.radius} m. Raise the list radius.`); return; }
    EM.locate = it.id;
    sendView();
    paint();
    toast('success', `Nearest: ${it.label}`, `${it.dist.toFixed(1)} m away. Follow the orange path.`);
  };
  window.emEdit = (id) => {
    const el = (S.elements || []).find((x) => x.id === id);
    if (!el) { toast('error', 'Not found', 'This emitter is no longer placed.'); return; }
    setTab('placed');
    if (S.edit && S.edit.id !== id) nui('element:endLive', { id: S.edit.id });
    S.edit = JSON.parse(JSON.stringify(el));
    nui('element:focus', { id });
    render();
    setTimeout(() => { const det = document.getElementById('detail'); if (det) det.scrollIntoView({ block: 'start' }); }, 120);   // instant: a re-render mid-animation would cancel a smooth scroll
  };
  // Take over a game emitter: saved on / off + forced radio station, synced to everyone and exported.
  window.emEditGame = async (id) => {
    const x = list.find((it) => it.id === id);
    if (!x) return;
    const owned = ownerOf(x.label);
    if (owned) { window.emEdit(owned.id); return; }
    const el = {
      type: 'static', label: x.label, x: x.x, y: x.y, z: x.z, range: x.range || 12,
      group: (S.interior && S.interior.group) || undefined,   // exported with the MLO you are working on
      static: { name: x.label, enabled: x.enabled !== false, default: x.enabled !== false, vx: x.x, vy: x.y, vz: x.z },
    };
    const r = await nui('element:save', { element: el });
    if (!r || !r.ok || !r.element) { toast('error', 'Could not take it over', (r && r.error) || 'The server refused the change.'); return; }
    if (!(S.elements || []).some((it) => it.id === r.element.id)) S.elements.push(r.element);
    toast('success', 'Taken over', `${x.label} now follows your saved settings. Change them below.`);
    window.emEdit(r.element.id);
  };
  window.emStatic = async (name, on) => {
    const r = await nui('emit:static', on === null ? { name, reset: true } : { name, on });
    if (!r || r.ok !== true) { toast('error', 'Could not switch the emitter', r && r.missing ? 'Restart jdt so the game loads the latest files.' : name); return; }
    toast('success', on === null ? 'Back to default' : on ? 'Emitter on' : 'Emitter off', name);
    poll();
  };
  window.emGo = async (id) => {
    const r = await nui('emit:teleport', { id });
    if (!r || r.ok === false) toast('error', 'Could not teleport', 'Teleporting is turned off on this server or the emitter is gone.');
  };

  // a full panel render leaves the list empty: fill it in the same frame
  const baseRender = render;
  // eslint-disable-next-line no-global-assign
  render = function () { baseRender.apply(this, arguments); if (S.tab === 'emitters') paint(); };

  const baseSetTab = setTab;
  // eslint-disable-next-line no-global-assign
  setTab = function (tab) {
    baseSetTab(tab);
    if (tab === 'emitters') startPoll(); else stopPoll();
  };
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.action === 'close' || (m.action === 'panel' && m.data && m.data.visible === false)) stopPoll();
    if ((m.action === 'open' || m.action === 'panel') && S.tab === 'emitters') setTimeout(startPoll, 50);
  });
  // restore the in-world view the player left switched on
  if (EM.on) setTimeout(sendView, 800);

  if (window.JDT_PALETTE_EXTRA) window.JDT_PALETTE_EXTRA.push(() => [
    { group: 'Commands', label: 'Locate the nearest audio emitter', hint: '', icon: 'emitters', run: () => { setTab('emitters'); setTimeout(window.emLocateNearest, 80); } },
    { group: 'Commands', label: EM.on ? 'Hide emitters in the world' : 'Show emitters in the world', hint: '', icon: 'emitters', run: () => window.emSet('on', !EM.on) },
  ]);
})();
