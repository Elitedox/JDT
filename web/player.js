/* JDT | web/player.js - Utilities: Player (noclip, god mode), World (weather and time), Vehicles (spawner with maxed performance, repair).
   Everything here is HTML / JS: the vehicle catalog, search, class filter, recent spawns and the noclip HUD.
   Lua (client/playertools.lua) only runs the natives. The tab polls the game once a second while it is
   open (vehicle health); nothing runs otherwise. */
'use strict';

(function () {
  const KEY = 'jdt:player';
  const DEF = { seat: true, armour: true, tyres: true, replace: true, cls: 'All', recent: [], tps: [] };
  const load = () => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { return { ...DEF }; } };
  let PL = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(PL)); } catch (e) { /* storage unavailable */ } };
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let st = { noclip: false, god: false, speed: 8, key: '', vehicle: null, world: { on: false, weather: null, hour: 12, minute: 0, freeze: true } };
  let cars = [];             // [model, display name, maker, class]
  let query = '', timer = 0, busy = false;
  const MAX_ROWS = 150;
  const PERF_NAME = { 11: 'Engine', 12: 'Brakes', 13: 'Transmission', 15: 'Suspension' };
  const WEATHER = [['EXTRASUNNY', 'Extra sunny'], ['CLEAR', 'Clear'], ['NEUTRAL', 'Neutral'], ['CLOUDS', 'Clouds'], ['OVERCAST', 'Overcast'], ['CLEARING', 'Clearing'],
    ['SMOG', 'Smog'], ['FOGGY', 'Foggy'], ['RAIN', 'Rain'], ['THUNDER', 'Thunder'], ['SNOWLIGHT', 'Light snow'], ['SNOW', 'Snow'], ['BLIZZARD', 'Blizzard'], ['XMAS', 'Christmas'], ['HALLOWEEN', 'Halloween']];
  const TIMES = [['Dawn', 6, 0], ['Morning', 9, 0], ['Noon', 12, 0], ['Golden hour', 18, 30], ['Sunset', 20, 0], ['Midnight', 0, 0]];
  const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  let worldTimer = 0;

  fetch('../catalog/vehicles.json').then((r) => r.json()).then((list) => { cars = Array.isArray(list) ? list : []; if (S.tab === 'vehicles') paintList(); }).catch(() => {});

  // Utilities: three tabs (Player, World, Vehicles) in their own sidebar section, above Settings
  const PL_TABS = ['player', 'world', 'vehicles'];
  window.JDT_UTIL_TABS = PL_TABS;
  const isUtil = (tab = S.tab) => PL_TABS.includes(tab);
  ICON.player = '<circle cx="10" cy="6" r="3"/><path d="M4 17c.6-3.4 3-5.4 6-5.4s5.4 2 6 5.4"/>';
  ICON.world = '<circle cx="10" cy="10" r="3.4"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>';
  ICON.vehicles = '<path d="M3.5 12.5V10l1.6-4.2c.2-.5.7-.8 1.2-.8h7.4c.5 0 1 .3 1.2.8L16.5 10v2.5"/><path d="M2.5 10.2h15v3.6h-15z"/><circle cx="6" cy="14.6" r="1.4"/><circle cx="14" cy="14.6" r="1.4"/>';
  if (!NAV.some((g) => g.sec === 'ui_nav_util')) NAV.splice(NAV.length - 1, 0, { sec: 'ui_nav_util', tabs: PL_TABS.slice() });
  PL_TABS.forEach((t) => { if (!TABS.includes(t)) TABS.splice(TABS.indexOf('settings'), 0, t); });

  const sw = (id, on, fn) => `<label class="sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} onchange="${fn}"><span class="sw-track"><span class="sw-thumb"></span></span></label>`;
  const opt = (k, label) => `<button class="ov-chip${PL[k] ? ' on' : ''}" data-pl-opt="${k}" onclick="plOpt('${k}')">${label}</button>`;
  const classes = () => ['All', ...[...new Set(cars.map((c) => c[3]))].sort()];

  const OFF = '<div class="empty big"><b>Utilities are switched off</b><p>Set Config.Player.enabled = true in config.lua and restart jdt.</p></div>';
  VIEWS.player = () => (S.player === false ? OFF : `
    <div class="pl-tiles">
      <div class="pl-tile${st.noclip ? ' on' : ''}" id="pl-t-noclip">
        <div class="pl-tile-main">
          <div class="pl-tile-title">Noclip <kbd id="pl-key"${st.key ? '' : ' hidden'}>${e(st.key)}</kbd></div>
          <div class="pl-tile-sub">Free camera. Aim with the mouse, W flies where you look, Shift boosts, the mouse wheel sets the speed. A / D strafe, E / Q up and down.</div>
          <div class="pl-tile-meta" id="pl-speed">${st.noclip ? `${st.speed.toFixed(1)} m/s` : 'off'}</div>
        </div>
        ${sw('pl-noclip', st.noclip, 'plToggle(\'noclip\', this.checked)')}
      </div>
      <div class="pl-tile${st.god ? ' on' : ''}" id="pl-t-god">
        <div class="pl-tile-main">
          <div class="pl-tile-title">God mode</div>
          <div class="pl-tile-sub">No damage, no ragdoll, full health and armour. Stays on through respawns until you switch it off.</div>
          <div class="pl-tile-meta" id="pl-god-meta">${st.god ? 'on' : 'off'}</div>
        </div>
        ${sw('pl-god', st.god, 'plToggle(\'god\', this.checked)')}
      </div>
    </div>`);
  VIEWS.world = () => (S.player === false ? OFF : `
    <div class="pl-world pl-tp">
      <div class="pl-world-head"><span class="pl-sec">Teleport</span><span class="pl-world-state">x, y, z and an optional heading, in any format</span></div>
      <div class="pl-tp-row">
        <input id="pl-tp" class="field-input mono" type="text" spellcheck="false" autocomplete="off" placeholder="1769.4193, 2593.2776, 45.7680" onkeydown="if(event.key==='Enter')plTp(this.value)" oninput="plTpCheck(this.value)">
        <button class="btn primary sm" onclick="plTp(document.getElementById('pl-tp').value)">Teleport</button>
        <button class="btn outline sm" onclick="plMarker()" title="Teleport to the waypoint set on the map">To map marker${markerKey() ? ` <kbd>${e(markerKey())}</kbd>` : ''}</button>
      </div>
      <div class="pl-tp-hint" id="pl-tp-hint">Paste from anywhere: <span class="mono">vector3(…)</span>, <span class="mono">vector4(…)</span>, <span class="mono">x y z</span> or JSON all work.</div>
      <div class="pl-recent" id="pl-tps"></div>
    </div>
    <div class="pl-world">
      <div class="pl-world-head"><span class="pl-sec">Weather and time</span><span class="pl-world-state" id="pl-world-state"></span>
        <button class="btn ghost sm" id="pl-world-reset" onclick="plWorld({ reset: true })">Back to server weather and time</button></div>
      <div class="pl-weather" id="pl-weather">${WEATHER.map(([id, label]) => `<button class="pl-wx" data-wx="${id}">${label}</button>`).join('')}</div>
      <div class="pl-time">
        <span class="pl-clock mono" id="pl-clock">${hhmm(st.world.hour, st.world.minute)}</span>
        <input type="range" class="dist-range pl-time-range" id="pl-time" min="0" max="1439" step="5" value="${st.world.hour * 60 + st.world.minute}" oninput="plTime(+this.value)">
        <label class="pl-freeze">Freeze time ${sw('pl-freeze', st.world.freeze, 'plWorld({ freeze: this.checked })')}</label>
        <div class="pl-time-presets">${TIMES.map(([l, h, m]) => `<button class="ov-chip" onclick="plWorld({ hour: ${h}, minute: ${m} })">${l}</button>`).join('')}</div>
      </div>
      <div class="pl-world-note">Only you see it. Weather-sync scripts are held off while it is set.</div>
    </div>`);
  VIEWS.vehicles = () => (S.player === false ? OFF : `
    <div class="pl-veh" id="pl-veh"></div>
    <div class="pl-spawn">
      <div class="pl-spawn-head">
        <div class="ent-search-wrap"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="9" r="5.5"/><path d="M13.2 13.2L17 17"/></svg>
          <input id="pl-q" class="field-input" type="text" placeholder="Search ${cars.length || ''} vehicles, or type any model name (add-on cars too) and press Enter" spellcheck="false" autocomplete="off" value="${e(query)}" oninput="plSearch(this.value)" onkeydown="if(event.key==='Enter')plSpawn(this.value)"></div>
        <select id="pl-cls" class="field-input pl-cls" onchange="plClass(this.value)" title="Vehicle class">${classes().map((c) => `<option value="${e(c)}"${PL.cls === c ? ' selected' : ''}>${c === 'All' ? 'All classes' : e(c)}</option>`).join('')}</select>
        <button class="btn primary sm" onclick="plSpawn(document.getElementById('pl-q').value)">Spawn</button>
      </div>
      <div class="pl-opts">
        <span class="pl-opts-k">Spawn with</span>${opt('seat', 'Me in the driver seat')}${opt('armour', 'Max armour')}${opt('tyres', 'Bulletproof tyres')}${opt('replace', 'Replace my last spawn')}
        <span class="pl-opts-note">Engine, brakes, transmission, suspension and turbo are always maxed.</span>
      </div>
      <div class="pl-recent" id="pl-recent"></div>
      <div class="pl-list" id="pl-list"></div>
    </div>`);

  function vehHTML() {
    const v = st.vehicle;
    if (!v) return '<div class="pl-veh-empty">Not in a vehicle. Spawn one below, or get in one to repair or upgrade it.</div>';
    const bar = (k, n) => `<div class="pl-bar"><span class="pl-bar-k">${k}</span><span class="pl-bar-track"><i style="width:${Math.max(0, Math.min(100, n))}%" class="${n < 35 ? 'bad' : n < 70 ? 'warn' : ''}"></i></span><span class="pl-bar-v mono">${Math.max(0, n)}%</span></div>`;
    const mods = (v.mods || []).map((m) => `<span class="pl-mod${m.level >= m.max ? ' max' : ''}">${PERF_NAME[m.slot] || m.slot} <b class="mono">${m.level}/${m.max}</b></span>`).join('')
      + `<span class="pl-mod${v.turbo ? ' max' : ''}">Turbo <b class="mono">${v.turbo ? 'on' : 'off'}</b></span>`;
    return `<div class="pl-veh-card">
      <div class="pl-veh-id"><div class="pl-veh-name">${e(v.label)}</div><div class="pl-veh-sub mono">${e(v.name)} · ${e((v.plate || '').trim())}${v.spawned ? ' · spawned by you' : ''}</div></div>
      <div class="pl-veh-bars">${bar('Engine', v.engine)}${bar('Body', v.body)}</div>
      <div class="pl-veh-acts"><button class="btn outline sm" onclick="plRepair()">Repair and clean</button><button class="btn primary sm" onclick="plUpgrade()">Max performance</button></div>
      <div class="pl-mods">${mods}</div>
    </div>`;
  }

  function rowHTML(c) {
    return `<button class="pl-row" data-model="${e(c[0])}"><span class="pl-row-name">${e(c[1])}</span><span class="pl-row-model mono">${e(c[0])}</span><span class="pl-row-maker">${e(c[2])}</span><span class="pl-row-cls">${e(c[3])}</span></button>`;
  }

  function paintList() {
    const list = document.getElementById('pl-list');
    if (!list) return;
    const q = query.trim().toLowerCase();
    const hits = cars.filter((c) => (PL.cls === 'All' || c[3] === PL.cls) && (!q || c[0].includes(q) || c[1].toLowerCase().includes(q) || c[2].toLowerCase().includes(q)));
    const exact = q && !cars.some((c) => c[0] === q);
    list.innerHTML = (exact ? `<button class="pl-row pl-row-any" data-model="${e(q)}"><span class="pl-row-name">Spawn “${e(q)}”</span><span class="pl-row-model mono">any model name, add-on vehicles too</span><span></span><span class="pl-row-cls">Enter</span></button>` : '')
      + hits.slice(0, MAX_ROWS).map(rowHTML).join('')
      + (hits.length > MAX_ROWS ? `<div class="pl-more">${hits.length - MAX_ROWS} more, keep typing to narrow it down</div>` : '')
      + (!hits.length && !exact ? '<div class="pl-more">No vehicle matches</div>' : '');
    const sel = document.getElementById('pl-cls');
    if (sel && sel.options.length < 2 && cars.length) sel.innerHTML = classes().map((c) => `<option value="${e(c)}"${PL.cls === c ? ' selected' : ''}>${c === 'All' ? 'All classes' : e(c)}</option>`).join('');
    const rc = document.getElementById('pl-recent');
    if (rc) rc.innerHTML = PL.recent.length ? `<span class="pl-opts-k">Recent</span>${PL.recent.map((m) => { const c = cars.find((x) => x[0] === m); return `<button class="pl-recent-chip" data-model="${e(m)}">${e(c ? c[1] : m)}</button>`; }).join('')}` : '';
  }

  // pull 3 or 4 numbers out of whatever was pasted: "1, 2, 3", vector3(1, 2, 3), vec4(...), {"x":1,...}, "1 2 3 90"
  function parseCoords(text) {
    const n = String(text || '').replace(/vec(tor)?[234]?/gi, ' ').match(/-?\d+(?:\.\d+)?/g);
    if (!n || n.length < 3) return null;
    const [x, y, z, h] = n.map(Number);
    return { x, y, z, h: n.length >= 4 ? h : undefined };
  }
  const fmtTp = (c) => `${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}${c.h !== undefined ? `, ${Math.round(c.h)}°` : ''}`;
  const markerKey = () => ((S.keybinds || []).find((b) => b.id === 'marker') || {}).key || '';
  function paintTps() {
    const el = document.getElementById('pl-tps');
    if (el) el.innerHTML = PL.tps.length ? `<span class="pl-opts-k">Recent</span>${PL.tps.map((c, i) => `<button class="pl-recent-chip mono" data-tp="${i}">${fmtTp(c)}</button>`).join('')}` : '';
  }
  window.plTpCheck = (v) => {
    const h = document.getElementById('pl-tp-hint'); if (!h) return;
    const c = parseCoords(v);
    h.classList.toggle('ok', !!c); h.classList.toggle('bad', !!v.trim() && !c);
    h.innerHTML = !v.trim() ? 'Paste from anywhere: <span class="mono">vector3(…)</span>, <span class="mono">vector4(…)</span>, <span class="mono">x y z</span> or JSON all work.'
      : c ? `Goes to <span class="mono">${fmtTp(c)}</span>` : 'Needs at least x, y and z';
  };
  window.plTp = async (v) => {
    const c = typeof v === 'object' ? v : parseCoords(v);
    if (!c) { toast('warning', 'No coordinates', 'Type x, y and z, e.g. 1769.4193, 2593.2776, 45.7680'); return; }
    const r = await nui('pl:tp', c);
    if (!r || r.ok !== true) { toast('error', 'Could not teleport', (r && r.error) || 'Restart jdt so the game loads the latest files.'); return; }
    PL.tps = [c, ...PL.tps.filter((t) => fmtTp(t) !== fmtTp(c))].slice(0, 6); save(); paintTps();
    toast('success', 'Teleported', fmtTp(c));
  };
  window.plMarker = async () => {
    const r = await nui('pl:marker');
    if (!r || r.ok !== true) { toast('error', 'Could not teleport', (r && r.error) || 'Restart jdt so the game loads the latest files.'); return; }
    toast('success', 'Teleported to the marker', fmtTp(r));
  };

  function paintWorld() {
    paintTps();
    const w = st.world || {};
    document.querySelectorAll('#pl-weather [data-wx]').forEach((b) => b.classList.toggle('on', w.on && b.dataset.wx === w.weather));
    const range = document.getElementById('pl-time');
    if (range && document.activeElement !== range) range.value = w.hour * 60 + w.minute;
    const clock = document.getElementById('pl-clock');
    if (clock && document.activeElement !== range) clock.textContent = hhmm(w.hour, w.minute);
    const fz = document.getElementById('pl-freeze'); if (fz && fz.checked !== !!w.freeze) fz.checked = !!w.freeze;
    const ws = document.getElementById('pl-world-state');
    if (ws) ws.textContent = w.on ? `set by you · ${w.weather ? (WEATHER.find((x) => x[0] === w.weather) || [0, w.weather])[1] : 'server weather'} · ${hhmm(w.hour, w.minute)}${w.freeze ? ' frozen' : ''}` : 'following the server';
    const rs = document.getElementById('pl-world-reset'); if (rs) rs.disabled = !w.on;
  }

  function paint() {
    paintWorld();
    const v = document.getElementById('pl-veh');
    if (v) v.innerHTML = vehHTML();
    const sp = document.getElementById('pl-speed');
    if (sp) sp.textContent = st.noclip ? `${Number(st.speed).toFixed(1)} m/s` : 'off';
    const kb = document.getElementById('pl-key');
    if (kb && st.key) { kb.textContent = st.key; kb.hidden = false; }
    const gm = document.getElementById('pl-god-meta');
    if (gm) gm.textContent = st.god ? 'on' : 'off';
    [['noclip', 'pl-noclip', 'pl-t-noclip'], ['god', 'pl-god', 'pl-t-god']].forEach(([k, cb, tile]) => {
      const c = document.getElementById(cb); if (c && c.checked !== !!st[k]) c.checked = !!st[k];
      const t = document.getElementById(tile); if (t) t.classList.toggle('on', !!st[k]);
    });
  }

  async function poll() {
    if (busy) return;
    const r = await nui('pl:state');
    if (r && typeof r === 'object' && 'noclip' in r) { st = { ...st, ...r }; paint(); }
  }
  function startPoll() { stopPoll(); poll(); timer = setInterval(() => { if (S.visible && isUtil()) poll(); else stopPoll(); }, 1000); }
  function stopPoll() { clearInterval(timer); timer = 0; }

  window.plToggle = async (what, on) => {
    const r = await nui(what === 'noclip' ? 'pl:noclip' : 'pl:god', { on });
    if (r && 'noclip' in r) {
      st = { ...st, ...r }; paint();
      // the panel holds the mouse and keyboard: close it so you can fly straight away
      if (what === 'noclip' && r.noclip && S.visible && typeof closeUI === 'function') setTimeout(closeUI, 150);
    }
    else toast('error', 'Could not switch it', 'Restart jdt so the game loads the latest files.');
  };
  window.plOpt = (k) => { PL[k] = !PL[k]; save(); document.querySelectorAll(`[data-pl-opt="${k}"]`).forEach((b) => b.classList.toggle('on', PL[k])); };
  window.plSearch = (v) => { query = v; paintList(); };
  window.plClass = (c) => { PL.cls = c; save(); paintList(); };
  window.plSpawn = async (model) => {
    model = String(model || '').trim().toLowerCase();
    if (!model) { toast('warning', 'Pick a vehicle', 'Click one in the list or type a model name.'); return; }
    if (busy) return;
    busy = true;
    const r = await nui('pl:spawn', { model, seat: PL.seat, armour: PL.armour, tyres: PL.tyres, replace: PL.replace });
    busy = false;
    if (!r || r.ok !== true) { toast('error', 'Could not spawn it', (r && r.error) || 'Restart jdt so the game loads the latest files.'); return; }
    PL.recent = [model, ...PL.recent.filter((m) => m !== model)].slice(0, 8); save();
    st.vehicle = r.vehicle || st.vehicle;
    paint(); paintList();
    toast('success', `${(r.vehicle && r.vehicle.label) || model} spawned`, 'Every performance part is maxed.');
  };
  window.plRepair = async () => {
    const r = await nui('pl:repair');
    if (!r || r.ok !== true) { toast('error', 'Could not repair', (r && r.error) || ''); return; }
    st.vehicle = r.vehicle; paint(); toast('success', 'Repaired', 'Engine, body and tank fixed, washed and refuelled.');
  };
  window.plWorld = async (d) => {
    const r = await nui('pl:world', d);
    if (!r || !r.world) { toast('error', 'Could not change the world', 'Restart jdt so the game loads the latest files.'); return; }
    st.world = r.world; paintWorld();
  };
  // the slider shows the time while you drag and applies it a moment after you stop
  window.plTime = (v) => {
    const h = Math.floor(v / 60), m = v % 60;
    const clock = document.getElementById('pl-clock'); if (clock) clock.textContent = hhmm(h, m);
    clearTimeout(worldTimer);
    worldTimer = setTimeout(() => window.plWorld({ hour: h, minute: m }), 120);
  };
  window.plUpgrade = async () => {
    const r = await nui('pl:upgrade', { armour: PL.armour, tyres: PL.tyres });
    if (!r || r.ok !== true) { toast('error', 'Could not upgrade', (r && r.error) || ''); return; }
    st.vehicle = r.vehicle; paint(); toast('success', 'Performance maxed', 'Engine, brakes, transmission, suspension and turbo.');
  };

  // one delegated listener for the list and the recent chips
  document.addEventListener('click', (ev) => {
    const row = ev.target.closest('#pl-list .pl-row, #pl-recent .pl-recent-chip');
    if (row) { window.plSpawn(row.dataset.model); return; }
    const tp = ev.target.closest('#pl-tps [data-tp]');
    if (tp) { window.plTp(PL.tps[+tp.dataset.tp]); return; }
    const wx = ev.target.closest('#pl-weather [data-wx]');
    if (wx) window.plWorld({ weather: wx.dataset.wx });
  });

  // a full panel render: fill the dynamic parts in the same frame
  const baseRender = render;
  // eslint-disable-next-line no-global-assign
  render = function () {
    if (S.player === false) { const g = NAV.find((x) => x.sec === 'ui_nav_util'); if (g) { NAV.splice(NAV.indexOf(g), 1); PL_TABS.forEach((t) => { if (TABS.includes(t)) TABS.splice(TABS.indexOf(t), 1); }); if (isUtil()) S.tab = 'settings'; } }
    baseRender.apply(this, arguments);
    if (isUtil()) { paint(); if (S.tab === 'vehicles') paintList(); }
  };
  const baseSetTab = setTab;
  // eslint-disable-next-line no-global-assign
  setTab = function (tab) { baseSetTab(tab); if (isUtil(tab)) startPoll(); else stopPoll(); };

  // noclip HUD: shown over the game while flying, panel open or closed
  const hud = document.createElement('div');
  hud.id = 'noclip-hud';
  hud.hidden = true;
  document.body.appendChild(hud);
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.action === 'noclipHud') {
      const d = m.data || {};
      st.noclip = !!d.on;
      if (d.speed) st.speed = d.speed;
      hud.hidden = !d.on;
      if (d.on) hud.innerHTML = `<b>Noclip</b><span class="mono">${Number(d.speed).toFixed(1)} m/s</span><i>Mouse aim</i><i>W fly</i><i>Shift boost</i><i>Wheel speed</i><i>A D strafe · E Q up, down</i>`;
      if (isUtil()) paint();
    }
    if (m.action === 'close' || (m.action === 'panel' && m.data && m.data.visible === false)) stopPoll();
    if ((m.action === 'open' || m.action === 'panel') && isUtil()) setTimeout(startPoll, 50);
  });

  if (window.JDT_PALETTE_EXTRA) window.JDT_PALETTE_EXTRA.push(() => [
    { group: 'Commands', label: 'Noclip on / off', hint: st.key || '', icon: 'player', run: () => window.plToggle('noclip', !st.noclip) },
    { group: 'Commands', label: 'God mode on / off', hint: '', icon: 'player', run: () => window.plToggle('god', !st.god) },
    { group: 'Commands', label: 'Teleport to map marker', hint: markerKey(), icon: 'world', run: () => window.plMarker() },
    { group: 'Commands', label: 'Repair my vehicle', hint: '', icon: 'vehicles', run: () => window.plRepair() },
    { group: 'Commands', label: 'Spawn a vehicle', hint: '', icon: 'vehicles', run: () => { setTab('vehicles'); setTimeout(() => { const q = document.getElementById('pl-q'); if (q) q.focus(); }, 60); } },
  ]);
})();
