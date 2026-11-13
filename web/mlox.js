/* JDT | web/mlox.js - the MLO tabs (Interior, Portals, Entitysets, Timecycles, Locations, Graph,
   Entities) with their original look and behaviour, running inside the JDT window.
   All logic lives here (flags, timecycle names, sorting, filtering, storage, XML, graph layout);
   Lua (client/inspect.lua) only reads / writes the game. Loaded after app.js and reuses its helpers. */
'use strict';

(function () {
  const qid = (id) => document.getElementById(id);

  /* ================================================================ shared */

  // MLOX state (named MX so it never collides with the audio panel state S)
  let MX = {
    intId: 'OUTSIDE', nameHash: 0, roomCount: 0, portalCount: 0,
    roomHash: '0', currentRoomId: -1, currentRoomName: '',
    rooms: [], portals: [], playerPos: { x: 0, y: 0, z: 0, h: 0 }, sig: null,
  };

  const PORTAL_FLAGS = [
    { bit: 1, name: 'One-way' }, { bit: 2, name: 'Links to another MLO' }, { bit: 4, name: 'Mirror' }, { bit: 8, name: 'Ignore timecycle' },
    { bit: 16, name: 'Expensive mirror' }, { bit: 32, name: 'Low LOD only' }, { bit: 64, name: 'Hide when doors close' },
    { bit: 128, name: 'Mirror shows sunlight' }, { bit: 256, name: 'Mirror sees through portals' }, { bit: 512, name: 'Mirror floor' },
    { bit: 1024, name: 'Mirror shows exterior' }, { bit: 2048, name: 'Water surface' }, { bit: 4096, name: 'Water to horizon' },
    { bit: 8192, name: 'Light bleed' },
  ];
  const ROOM_FLAGS = [
    { bit: 1, name: 'Freeze vehicles' }, { bit: 2, name: 'Freeze peds' }, { bit: 4, name: 'No direct light' },
    { bit: 8, name: 'No exterior light' }, { bit: 16, name: 'Force freeze' }, { bit: 32, name: 'Fewer vehicles (33%)' },
    { bit: 64, name: 'Fewer peds (33%)' }, { bit: 128, name: 'Force direct light' }, { bit: 256, name: 'Hide exterior' },
    { bit: 512, name: 'Mirror may be visible' },
  ];
  // YMAP CEntityDef flags: only these bits are confirmed by the community (Dekurwinator / dexyfex research).
  const ENTITY_FLAGS = [
    { bit: 1, name: 'Allow full rotation' }, { bit: 4, name: 'No embedded collision' }, { bit: 8, name: 'Static prop' },
    { bit: 32, name: 'Static entity' }, { bit: 524288, name: 'Static base (low)' }, { bit: 1048576, name: 'Static base (high)' },
    { bit: 33554432, name: 'Interior proxy' }, { bit: 134217728, name: 'Reflection proxy' }, { bit: 536870912, name: 'Mirror proxy' },
  ];
  const ENTITY_FLAG_PRESETS = [
    { name: 'Static prop', value: 1572872 }, { name: 'Door / ladder', value: 1572864 },
    { name: 'Security gate', value: 1572866 }, { name: 'Emissive', value: 8 }, { name: 'Clear', value: 0 },
  ];

  const store = {
    get(key, fallback) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } },
  };
  const num32 = (v) => String(Number(v) >>> 0);   // hashes are shown as plain numbers, never hex
  const fmt = (n, d = 2) => (Number(n) || 0).toFixed(d);
  const isMlox = () => S.visible && MLOX_TABS.includes(S.tab);

  // Timecycle names (~1,300, base game + every DLC up to 2025) - catalog/timecycles.json, hashed once
  let tcList = [];
  let tcHashMap = new Map();
  function setTimecycles(list) {
    tcList = arr(list);
    tcHashMap = new Map(tcList.map((n) => [joaat(n), n]));
    MX.rooms.forEach((r) => { r.tcName = hashToName(r.tcHash); });
  }
  fetch('../catalog/timecycles.json').then((r) => r.json()).then((list) => {
    tcList = arr(list);
    tcHashMap = new Map(tcList.map((n) => [joaat(n), n]));
    MX.rooms.forEach((r) => { r.tcName = hashToName(r.tcHash); });
    _prevRoomsKey = null; _prevTCKey = null;
    if (isMlox()) renderAll();
  }).catch(() => {});
  function hashToName(hash) {
    if (!hash || hash === 0) return 'none';
    const h = hash >>> 0;
    return tcHashMap.get(h) || num32(h);
  }

  /* ------------------------------------------------- NUI bridge (MLOX names) */
  // MLOX callback names are kept for the UI code below and translated to JDT's Lua endpoints here.
  async function nuiPost(ev, d = {}) {
    switch (ev) {
      case 'close': closeUI(); return {};
      case 'setRoomFlag': return afterEdit(await nui('ins:roomFlag', { room: d.roomId, flag: d.flags >>> 0 }));
      case 'setRoomTimecycle':
      case 'clearRoomTimecycle': return afterEdit(await nui('ins:roomTc', { room: d.roomId, value: (d.value || 0) >>> 0 }));
      case 'setPortalFlag': return afterEdit(await nui('ins:portalFlag', { portal: d.portalId, flag: d.flags >>> 0 }));
      case 'setPortalRoomFrom': return afterEdit(await nui('ins:portalLink', { portal: d.portalId, from: d.roomId }));
      case 'setPortalRoomTo': return afterEdit(await nui('ins:portalLink', { portal: d.portalId, to: d.roomId }));
      case 'resetRoom': return afterEdit(await nui('ins:reset', { kind: 'room', index: d.roomId }));
      case 'resetPortal': return afterEdit(await nui('ins:reset', { kind: 'portal', index: d.portalId }));
      case 'resetAll': return afterEdit(await nui('ins:reset', { kind: 'all' }));
      case 'toggleEntities3D': return nui('ins:overlay', { entities: !!d.state });
      case 'refreshInterior': return nui('ins:refresh');
      case 'batchCheckSets': { const r = await nui('sets:check', { names: d.names || [] }); return obj(r && r.states); }
      case 'activateSet': return nui('sets:toggle', { name: d.val, on: true, names: [d.val] });
      case 'deactivateSet': return nui('sets:toggle', { name: d.val, on: false, names: [d.val] });
      case 'teleportTo': return nui('teleport', { x: d.x, y: d.y, z: d.z, h: d.h });
      default: return nui(ev, d);
    }
  }
  function afterEdit(r) {
    if (r && r.state) applyState(r.state);
    if (r && r.ok === false) toast('error', 'Not applied', 'The interior is not loaded or the index is out of range.');
    renderAll(true);
    return r || {};
  }

  /* ------------------------------------------------------ data from Lua */
  function applyState(st) {
    if (!st || st.id === undefined) return;
    const prevInt = MX.intId;
    if (!st.id) {
      MX = { ...MX, intId: 'OUTSIDE', nameHash: 0, roomCount: 0, portalCount: 0, rooms: [], portals: [], currentRoomId: -1, currentRoomName: '', sig: null };
    } else {
      const rooms = arr(st.rooms).map((r) => ({
        id: r.i, name: r.name, flag: r.flag >>> 0, oflag: r.oflag >>> 0,
        tcHash: r.tc >>> 0, tcName: hashToName(r.tc), originalTcHash: r.otc >>> 0, originalTcName: hashToName(r.otc),
        bbMin: { x: r.min[0], y: r.min[1], z: r.min[2] }, bbMax: { x: r.max[0], y: r.max[1], z: r.max[2] },
      }));
      const portals = arr(st.portals).map((p) => ({
        id: p.i, flags: p.flag >>> 0, roomFrom: p.from, roomTo: p.to, oflags: p.oflag >>> 0, ofrom: p.ofrom, oto: p.oto,
        corners: arr(p.corners).map((c) => ({ x: c[0], y: c[1], z: c[2] })), w: p.w,
      }));
      MX = {
        ...MX, intId: st.id, nameHash: st.nameHash >>> 0, roomCount: rooms.length, portalCount: portals.length,
        rooms, portals, sig: st.sig, currentRoomId: st.room,
        currentRoomName: (rooms.find((r) => r.id === st.room) || {}).name || '',
        roomHash: num32(st.key || 0),
      };
    }
    if (st.pos) MX.playerPos = st.pos;
    if (MX.intId !== prevInt) {
      lastScanResult = {};
      _graphStructKey = null; _graphLayout = null;
      if (MX.intId !== 'OUTSIDE' && S.tab === 'entitysets') fetchEntitySets();
    }
    if (S.visible && typeof renderRail === 'function') renderRail();   // smart badges follow the interior
  }

  async function loadState() { applyState(await nui('ins:state')); }

  let polling = false;
  async function poll() {
    if (!S.visible || polling) return;
    polling = true;
    try {
      const live = await nui('ins:live');
      if (!live || live.id === undefined) return;
      MX.playerPos = live.pos || MX.playerPos;
      if (live.ft > 0) { ftAvg = ftAvg ? ftAvg * 0.7 + live.ft * 0.3 : live.ft; ftHist.push(live.ft); if (ftHist.length > 60) ftHist.shift(); drawSpark(); }
      const curId = MX.intId === 'OUTSIDE' ? 0 : MX.intId;
      const roomChanged = live.room !== MX.currentRoomId;
      MX.currentRoomId = live.id ? live.room : -1;
      MX.currentRoomName = live.id ? (live.roomName || '') : '';
      MX.roomHash = num32(live.key || 0);
      if (live.id !== curId || (live.id && live.sig !== MX.sig)) {
        if (MLOX_TABS.includes(S.tab) || live.id !== curId) await loadState();
        renderAll(true);
      } else if (roomChanged) {
        renderAll(false);
      } else {
        renderSidebar();
        if (S.tab === 'locations') renderCoordsStatus();
      }
    } finally {
      polling = false;
    }
  }
  // live loop: only does work while the panel is visible (one light Lua call per tick)
  (function loop() {
    poll().finally(() => setTimeout(loop, clamp(Number(S.inspectCfg && S.inspectCfg.pollMs) || 500, 150, 5000)));
  })();

  /* ------------------------------------------------- sidebar + render */
  // instrument strip + status bar (live, patched in place)
  let ftAvg = 0;
  const ftHist = [];
  // frame-time sparkline in the status bar: 16.7 ms (60 fps) guide, spikes over 33 ms in red
  function drawSpark() {
    const c = qid('sb-spark');
    if (!c || !S.visible) return;
    const g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    if (ftHist.length < 2) return;
    const max = Math.max(40, ...ftHist);
    const y = (v) => H - 2 - (v / max) * (H - 4);
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(0, Math.round(y(16.7)) + .5); g.lineTo(W, Math.round(y(16.7)) + .5); g.stroke(); g.setLineDash([]);
    const step = W / 59, x0 = W - (ftHist.length - 1) * step;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff7a1a';
    g.beginPath();
    ftHist.forEach((v, i) => (i ? g.lineTo(x0 + i * step, y(v)) : g.moveTo(x0, y(v))));
    g.strokeStyle = accent; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    g.lineTo(W, H); g.lineTo(x0, H); g.closePath();
    const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, accent + '55'); grad.addColorStop(1, accent + '00');
    g.fillStyle = grad; g.fill();
    ftHist.forEach((v, i) => { if (v > 33) { g.fillStyle = '#ff5e62'; g.fillRect(x0 + i * step - 1.5, y(v) - 1.5, 3, 3); } });
  }
  function renderSidebar() {
    const set = (id, v) => { const el = qid(id); if (el && el.textContent !== v) el.textContent = v; };
    const inside = MX.intId !== 'OUTSIDE';
    set('sb-int', inside ? (intName(MX.nameHash) || num32(MX.nameHash)) + ` · ${MX.intId}` : 'outside');
    const dot = qid('sb-dot'); if (dot) dot.classList.toggle('on', inside);
    set('sb-room', inside ? (MX.currentRoomName ? `${shortRoom(MX.currentRoomName, roomNamePrefix(MX.rooms.map((r) => r.name)))} #${MX.currentRoomId}` : '—') : '—');
    const p = MX.playerPos || {};
    set('sb-x', fmt(p.x)); set('sb-y', fmt(p.y)); set('sb-z', fmt(p.z)); set('sb-h', fmt(p.h, 1));
    if (ftAvg > 0) set('sb-ft', `${ftAvg.toFixed(1)} ms · ${Math.round(1000 / ftAvg)} fps`);
    const ovEl = qid('sb-ov');
    if (ovEl) {
      const on = !!(window.JDT_OVERLAY && window.JDT_OVERLAY.get().portals);
      ovEl.classList.toggle('on', on);
      const v = ovEl.lastElementChild; const txt = on ? 'portals on' : 'off';
      if (v.textContent !== txt) v.textContent = txt;
    }
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#readout')) return;
    const p = MX.playerPos || {};
    copyStr(`vector4(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}, ${fmt(p.h, 1)})`);
    toast('success', 'Position copied', 'vector4 on the clipboard');
    const ro = qid('readout'); if (ro) { ro.classList.add('copied'); setTimeout(() => ro.classList.remove('copied'), 700); }
  });

  // diff keys - avoid DOM rebuilds when nothing changed
  var _prevRoomsKey = null, _prevPortalsKey = null, _prevTCKey = null;

  function renderAll(force) {
    renderSidebar();
    if (!S.visible) return;
    if (force) { _prevRoomsKey = null; _prevPortalsKey = null; _prevTCKey = null; _graphFullKey = null; }
    switch (S.tab) {
      case 'interior': renderInterior(); break;
      case 'mportals': renderPortals(); break;
      case 'timecycles': renderTCStatus(); if (tcMode === 'editor') { const tb = qid('tce-body'); if (tb && !tb.dataset.ready && !TCE.loading) { TCE.loading = true; tceInit().finally(() => { TCE.loading = false; }); } } else renderTCGrid(); break;
      case 'locations': renderCoordsStatus(); break;
      case 'graph': renderGraph(); break;
      case 'entities': renderEntities(); break;
      default: break;
    }
  }

  // full re-render of the tab skeleton (app.js render) is followed by filling it
  const baseRender = render;
  // eslint-disable-next-line no-global-assign
  render = function () {
    baseRender();
    const np = qid('nowplaying');
    if (np) np.hidden = (MLOX_TABS.includes(S.tab) || (window.JDT_UTIL_TABS || []).includes(S.tab)) && !S.previews.length;
    if (!MLOX_TABS.includes(S.tab)) return;
    _coordsBuilt = false;
    renderAll(true);
    if (S.tab === 'entitysets') renderEntitySets(currentDisplaySets);
    if (S.tab === 'locations') renderWaypoints();
    if (S.tab === 'mportals') ovSummary();
  };

  const baseSetTab = setTab;
  // eslint-disable-next-line no-global-assign
  setTab = function (tab) {
    closeAllDropdowns();
    hideGraphTooltip();
    baseSetTab(tab);
    if (!MLOX_TABS.includes(tab)) return;
    loadState().then(() => {
      if (S.tab !== tab) return;
      renderAll(true);
      if (tab === 'entitysets') fetchEntitySets();
      if (tab === 'entities') { if (!_entScanned || entLive) scanEntities(); entLiveLoop(); }
    });
  };

  // panel opened: fresh state for the MLOX tabs
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.action === 'panel' && m.data && m.data.visible !== false && m.data.opened) {
      loadState().then(() => { if (isMlox()) { render(); if (S.tab === 'entitysets') fetchEntitySets(); } });
    }
  });

  /* ============================================================= INTERIOR */

  var editingRoom = null;

  VIEWS.interior = () => `
    <div class="stat-bar">
      <div class="stat-chip"><div class="sc-label">Interior id</div><div class="sc-val" id="int-id">—</div></div>
      <div class="stat-chip"><div class="sc-label">Rooms</div><div class="sc-val" id="int-rooms">0</div></div>
      <div class="stat-chip"><div class="sc-label">Portals</div><div class="sc-val" id="int-portals">0</div></div>
      <div class="stat-chip"><div class="sc-label">You are in</div><div class="sc-val mono sm" id="int-hash" title="">—</div></div>
    </div>
    <div id="int-insights" class="insights"></div>
    <div class="mx-row">
      <div class="sec-label" style="flex:1">Rooms <span id="int-changed" class="tag-changed"></span></div>
      <button class="btn outline sm" onclick="nuiPost('refreshInterior',{})">Refresh</button>
      <button class="btn outline sm danger" id="int-reset-all" onclick="resetAllChanges()">Undo all changes</button>
    </div>
    <div class="mx-scroll" id="room-list"><div class="mx-empty">No interior detected</div></div>`;

  // Smart checks on the live interior: each finding says what is wrong and takes you to it.
  function insights() {
    const out = [];
    if (MX.intId === 'OUTSIDE' || !MX.rooms.length) return out;
    const ids = new Set(MX.rooms.map((r) => r.id));
    const broken = MX.portals.filter((p) => !ids.has(p.roomFrom) || !ids.has(p.roomTo));
    const linked = new Set();
    MX.portals.forEach((p) => { linked.add(p.roomFrom); linked.add(p.roomTo); });
    const lonely = MX.rooms.filter((r) => r.id !== 0 && !linked.has(r.id));
    const selfLoop = MX.portals.filter((p) => p.roomFrom === p.roomTo);
    const exits = MX.portals.filter((p) => p.roomFrom === 0 || p.roomTo === 0).length;
    if (broken.length) out.push({ lvl: 'bad', text: `${broken.length} portal${broken.length > 1 ? 's lead' : ' leads'} to a room that does not exist`, act: 'Show', run: () => { setTab('mportals'); setTimeout(() => window.highlightPortal(broken[0].id), 80); } });
    if (lonely.length) out.push({ lvl: 'warn', text: `${lonely.map((r) => shortRoom(r.name, roomNamePrefix(MX.rooms.map((x) => x.name)))).slice(0, 3).join(', ')}${lonely.length > 3 ? ` and ${lonely.length - 3} more` : ''} ${lonely.length > 1 ? 'have' : 'has'} no portal, so the game never draws ${lonely.length > 1 ? 'them' : 'it'} from another room`, act: 'Floor plan', run: () => setTab('graph') });
    if (selfLoop.length) out.push({ lvl: 'warn', text: `${selfLoop.length} portal${selfLoop.length > 1 ? 's connect a room' : ' connects a room'} to itself`, act: 'Show', run: () => { setTab('mportals'); setTimeout(() => window.highlightPortal(selfLoop[0].id), 80); } });
    if (!exits) out.push({ lvl: 'warn', text: 'No portal leads outside (to limbo): the outside world will not render from inside', act: 'Portals', run: () => setTab('mportals') });
    return out;
  }
  var _insightKey = '';
  function renderInsights() {
    const el = qid('int-insights');
    if (!el) return;
    const list = insights();
    const key = list.map((x) => x.text).join('|');
    if (key === _insightKey && el.childElementCount === list.length) return;
    _insightKey = key;
    el._runs = list.map((x) => x.run);
    el.innerHTML = list.length
      ? list.map((x, i) => `<div class="ins ins-${x.lvl}"><span class="ins-dot"></span><span class="ins-t">${esc(x.text)}</span><button class="pflag-edit" data-ins="${i}">${x.act}</button></div>`).join('')
      : (MX.intId !== 'OUTSIDE' ? '<div class="ins ins-ok"><span class="ins-dot"></span><span class="ins-t">Every room is connected and every portal leads somewhere real.</span></div>' : '');
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-ins]');
    const el = qid('int-insights');
    if (b && el && el._runs) el._runs[+b.dataset.ins]();
  });

  function renderInterior() {
    if (!qid('room-list')) return;
    renderInsights();
    qid('int-id').textContent = MX.intId;
    qid('int-rooms').textContent = MX.roomCount;
    qid('int-portals').textContent = MX.portalCount;
    const el = qid('int-hash');
    el.textContent = MX.currentRoomName || MX.roomHash || '—';
    el.title = MX.roomHash || '';
    const changes = MX.rooms.filter((r) => r.flag !== r.oflag || r.tcHash !== r.originalTcHash).length
      + MX.portals.filter((p) => p.flags !== p.oflags || p.roomFrom !== p.ofrom || p.roomTo !== p.oto).length;
    qid('int-changed').textContent = changes ? `${changes} changed` : '';
    qid('int-reset-all').hidden = !changes;

    const key = MX.rooms.length
      ? MX.rooms.map((r) => `${r.id}|${r.name}|${r.flag}|${r.oflag}|${r.tcHash}|${r.tcName}|${r.id === MX.currentRoomId ? 1 : 0}`).join(';')
      : '__empty__';
    if (key === _prevRoomsKey) return;
    _prevRoomsKey = key;

    const list = qid('room-list');
    if (!MX.rooms.length) { list.innerHTML = '<div class="mx-empty">No interior detected</div>'; return; }
    list.innerHTML = MX.rooms.map((r) => {
      const here = r.id === MX.currentRoomId;
      const changed = r.flag !== r.oflag || r.tcHash !== r.originalTcHash;
      const tcDisplay = (!r.tcHash || r.tcName === 'none') ? 'none' : (r.tcName || hashToName(r.tcHash));
      const flagNames = ROOM_FLAGS.filter((f) => r.flag & f.bit).map((f) => f.name).join(' · ') || 'No flags';
      const flagChips = ROOM_FLAGS.filter((f) => r.flag & f.bit).map((f) => `<span class="flag-pill">${f.name}</span>`).join('');
      return `<div class="room-card${here ? ' here' : ''}${changed ? ' changed' : ''}">
        <span class="room-badge">${r.id}</span>
        <div class="room-main">
          <div class="room-top"><span class="room-name">${esc(r.name)}</span>${here ? '<span class="room-here-tag">You are here</span>' : ''}${changed ? '<span class="tag-changed">Changed</span>' : ''}</div>
          <div class="room-row">${flagChips || '<span class="room-kv">No flags</span>'}<span class="room-kv">value <span>${r.flag}</span></span></div>
        </div>
        <div class="room-tc${tcDisplay === 'none' ? ' none' : ''}" title="Timecycle">${esc(tcDisplay === 'none' ? 'No timecycle' : tcDisplay)}</div>
        <button class="room-edit-btn" onclick="openRoomModal(${r.id})">Edit</button>
      </div>`;
    }).join('');
  }

  function openRoomModal(roomId) {
    const room = MX.rooms.find((r) => r.id === roomId);
    if (!room) return;
    editingRoom = { ...room };
    qid('room-modal-title').textContent = `Room #${roomId} — ${room.name}`;
    const flagsHTML = ROOM_FLAGS.map((f) => {
      const on = !!(room.flag & f.bit);
      return `<div class="flag-item${on ? ' on' : ''}" onclick="toggleRoomFlag(${f.bit},this)">
        <input type="checkbox" ${on ? 'checked' : ''} tabindex="-1" style="pointer-events:none">
        <span class="flag-name">${f.name}</span><span class="flag-bit">${f.bit}</span></div>`;
    }).join('');
    qid('room-modal-body').innerHTML = `
      <div>
        <div class="rm-sec">Room flags</div>
        <div class="flag-grid" id="room-flag-grid" style="padding:0;max-height:220px">${flagsHTML}</div>
        <div class="rm-flag-raw" id="rm-flag-raw">${room.flag >>> 0}</div>
      </div>
      <div>
        <div class="rm-sec">Timecycle</div>
        <div style="display:flex;gap:6px">
          <input id="rm-tc" class="field-input" type="text" list="rm-tc-list" value="${esc(room.tcHash ? room.tcName : '')}" placeholder="none — name, 0x hash or number" spellcheck="false" autocomplete="off">
          <button class="btn primary sm" onclick="applyRoomTC()">Apply</button>
        </div>
        <datalist id="rm-tc-list">${tcList.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
        ${room.originalTcHash !== room.tcHash || room.oflag !== room.flag ? `<div class="rm-flag-raw">Original: flags ${room.oflag} · TC ${esc(room.originalTcName)}</div>` : ''}
      </div>
      <div>
        <div class="rm-sec">Extents</div>
        <div class="extent-grid">
          <div class="extent-chip"><div class="ek">BB Min</div><div class="ev">${room.bbMin.x}, ${room.bbMin.y}, ${room.bbMin.z}</div></div>
          <div class="extent-chip"><div class="ek">BB Max</div><div class="ev">${room.bbMax.x}, ${room.bbMax.y}, ${room.bbMax.z}</div></div>
        </div>
      </div>`;
    qid('room-modal').classList.add('open');
  }
  function closeRoomModal() { qid('room-modal').classList.remove('open'); editingRoom = null; }
  function toggleRoomFlag(bit, el) {
    const cb = el.querySelector('input');
    cb.checked = !cb.checked;
    el.classList.toggle('on', cb.checked);
    if (editingRoom) {
      editingRoom.flag = (cb.checked ? (editingRoom.flag | bit) : (editingRoom.flag & ~bit)) >>> 0;
      const raw = qid('rm-flag-raw');
      if (raw) raw.textContent = String(editingRoom.flag >>> 0);
    }
  }
  function applyRoomFlags() {
    if (!editingRoom) return;
    nuiPost('setRoomFlag', { roomId: editingRoom.id, flags: editingRoom.flag });
    closeRoomModal();
  }
  function applyRoomTC() {
    if (!editingRoom) return;
    const h = parseTC(qid('rm-tc').value);
    if (h === null) return toast('warning', 'Unknown value', 'Type a timecycle name, a 0x hash or a number.');
    nuiPost('setRoomTimecycle', { roomId: editingRoom.id, value: h });
    closeRoomModal();
  }
  function resetRoomFlags() {
    if (!editingRoom) return;
    nuiPost('resetRoom', { roomId: editingRoom.id });
    closeRoomModal();
  }
  function resetAllChanges() {
    modal(`<h2>Reset all changes</h2><p class="muted">Put every room and portal of this interior back to the values the game had when JDT first read it?</p>
      <div class="row end"><button class="btn ghost" data-close-modal>Cancel</button><button class="btn primary danger" data-modal-ok>Reset</button></div>`,
    async () => { const r = await nuiPost('resetAll'); toast('success', `${(r && r.changed) || 0} values restored`); });
  }
  function parseTC(raw) {
    const s = String(raw || '').trim();
    if (!s || s.toLowerCase() === 'none') return s ? 0 : null;
    if (/^0x[0-9a-f]{1,8}$/i.test(s)) return parseInt(s, 16) >>> 0;
    if (/^\d+$/.test(s)) return Number(s) >>> 0;
    return joaat(s);
  }

  /* ============================================================== PORTALS */

  var editingPortal = null;
  var openDropdownId = null;
  var drawEntities3D = false;

  /* Portal overlay settings - persisted per player, sent to Lua (debounced) */
  const OV_DEFAULT = {
    portals: false, maxPortals: 5, distance: 15, labelDistance: 15,
    outline: true, fill: true, diagonals: false, fillAlpha: 80, fade: true, onlyRoom: false,
    thickness: 1, glow: true, labels: true, textScale: 1,
    fields: { id: true, rooms: true, ids: true, flags: true, flagNames: true, entities: false, distance: false },
    colorMode: 'type',
    colors: { normal: '#7fa8d9', oneway: '#ffd166', mirror: '#4fd1c5', link: '#58c98b', broken: '#ff5e62', selected: '#ff7a1a' },
  };
  const OV_FIELDS = [['id', 'Portal ID'], ['rooms', 'Room names'], ['ids', 'Room IDs'], ['flags', 'Flags value'], ['flagNames', 'Flag names'], ['entities', 'Attached entities'], ['distance', 'Distance']];
  const OV_COLORS = [['normal', 'Normal'], ['oneway', 'One-way'], ['mirror', 'Mirror'], ['link', 'MLO link'], ['broken', 'Broken'], ['selected', 'Highlighted']];
  const SWATCHES = ['#ff7a1a', '#ffad6b', '#ffd166', '#f2f2f2', '#58c98b', '#4fd1c5', '#7fa8d9', '#5b8def', '#b18cff', '#e46a8c', '#ff5e62', '#8a8b94'];
  const legacy = store.get('jdt:mx:draw3D', null);
  var ov = (() => {
    const saved = obj(store.get('jdt:mx:overlay', {}));
    // v2: the room box outline became opt-in (GTA's room boxes are bigger than the room and cut through walls)
    delete saved.roomBounds; delete saved.roomLabel; delete saved.corners;   // removed features
    const o = { ...OV_DEFAULT, ...saved, fields: { ...OV_DEFAULT.fields, ...obj(saved.fields) }, colors: { ...OV_DEFAULT.colors, ...obj(saved.colors) } };
    if (legacy !== null && saved.portals === undefined) o.portals = !!legacy;
    return o;
  })();
  var ovSettingsOpen = !!store.get('jdt:mx:ovOpen', false);
  var highlightedPortal = null;
  const hexRgb = (h) => { const n = parseInt(String(h).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const ovCol = (k) => (k === 'selected' && String(ov.colors.selected).toLowerCase() === OV_DEFAULT.colors.selected ? 'var(--accent)' : ov.colors[k]);
  function ovPayload() {
    const colors = {};
    Object.entries(ov.colors).forEach(([k, v]) => { colors[k] = hexRgb(v); });
    // the highlighted portal follows the panel's accent unless a colour was picked for it
    if (String(ov.colors.selected).toLowerCase() === OV_DEFAULT.colors.selected) colors.selected = hexRgb(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || OV_DEFAULT.colors.selected);
    return { ...ov, colors };
  }
  let ovTimer = null;
  function sendOverlay(now) {
    store.set('jdt:mx:overlay', { ...ov, v: 2 });
    if (window.JDT_LABELS) window.JDT_LABELS.refresh();
    clearTimeout(ovTimer);
    if (now) return nui('ins:overlay', ovPayload());
    ovTimer = setTimeout(() => nui('ins:overlay', ovPayload()), 90);
  }

  const sw = (id, on, handler) => `<label class="sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} onchange="${handler}"><span class="sw-track"><span class="sw-thumb"></span></span></label>`;
  const ovSlider = (key, label, min, max, step, unit = '') => `
    <div class="ov-row"><span class="ov-k">${label}</span>
      <input type="range" class="dist-range" min="${min}" max="${max}" step="${step}" value="${ov[key]}" oninput="setOv('${key}', this.value, this)">
      <span class="dist-val ov-v" id="ov-v-${key}">${ov[key]}${unit}</span></div>`;
  const ovSwitch = (key, label) => `<div class="ov-row"><span class="ov-k">${label}</span>${sw('ov-' + key, ov[key], `setOv('${key}', this.checked)`)}</div>`;

  function ovSettingsHTML() {
    return `<div class="ov-panel">
      <div class="ov-col">
        <div class="ov-sec">Visibility</div>
        ${ovSlider('maxPortals', 'Max portals', 1, 40, 1)}
        ${ovSlider('distance', 'Draw distance', 5, 150, 5, 'm')}
        ${ovSwitch('onlyRoom', 'Only my room’s portals')}
        ${ovSwitch('fade', 'Fade with distance')}
        <div class="ov-sec">Style</div>
        ${ovSwitch('outline', 'Outline')}
        ${ovSlider('thickness', 'Outline thickness', 1, 4, 1)}
        ${ovSwitch('glow', 'Inner glow')}
        ${ovSwitch('diagonals', 'Diagonals (X)')}
        ${ovSwitch('fill', 'Fill')}
        ${ovSlider('fillAlpha', 'Fill opacity', 0, 160, 5)}
      </div>
      <div class="ov-col">
        <div class="ov-sec">Labels</div>
        ${ovSwitch('labels', 'Portal labels')}
        ${ovSlider('labelDistance', 'Label distance', 1, 60, 1, 'm')}
        ${ovSlider('textScale', 'Text size', 0.6, 1.6, 0.1, '×')}
        <div class="ov-fields">${OV_FIELDS.map(([k, l]) => `<button class="ov-chip${ov.fields[k] ? ' on' : ''}" onclick="toggleOvField('${k}')">${l}</button>`).join('')}</div>
        <div class="ov-sec">Colors
          <span class="ov-seg"><button class="${ov.colorMode === 'type' ? 'on' : ''}" onclick="setOv('colorMode','type')">By type</button><button class="${ov.colorMode === 'single' ? 'on' : ''}" onclick="setOv('colorMode','single')">Single</button></span>
        </div>
        ${OV_COLORS.filter(([k]) => ov.colorMode === 'type' || k === 'normal' || k === 'selected').map(([k, l]) => `
          <div class="ov-color"><span class="ov-k"><i class="ov-dot" style="background:${ovCol(k)}"></i>${l}</span>
            <span class="ov-swatches">${SWATCHES.map((c) => `<button class="ov-sw${ov.colors[k] === c ? ' on' : ''}" style="background:${c}" onclick="setOvColor('${k}','${c}')" aria-label="${c}"></button>`).join('')}</span></div>`).join('')}
        <div class="ov-foot"><button class="btn outline sm" onclick="resetOverlay()">Reset to defaults</button></div>
      </div>
    </div>`;
  }

  VIEWS.mportals = () => `
    <div class="toggle-row">
      <span class="trow-label">Show portals in the world <span class="mx-count" id="ov-summary"></span></span>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="ov-gear${ovSettingsOpen ? ' on' : ''}" onclick="toggleOvSettings()" title="Overlay settings">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/></svg> Settings
        </button>
        ${sw('chk-3d', ov.portals, 'toggle3DOverlay(this.checked)')}
      </div>
    </div>
    <div class="ov-wrap${ovSettingsOpen ? ' open' : ''}" id="ov-wrap">${ovSettingsHTML()}</div>
    <div class="mx-row"><div class="sec-label" style="flex:1">Portals <span class="mx-count" id="portal-count"></span></div>
      <div class="ov-legend">${OV_COLORS.filter(([k]) => ov.colorMode === 'type' || k === 'normal' || k === 'selected').map(([k, l]) => `<span><i style="background:${ovCol(k)}"></i>${l}</span>`).join('')}</div></div>
    <div class="mx-scroll" id="portal-list"><div class="mx-empty">No interior detected</div></div>`;

  // one overlay for the whole tool: the audio Occlusion tab drives the same renderer through this
  window.JDT_OVERLAY = {
    get: () => ov,
    resend() { if (ov.portals || highlightedPortal !== null) sendOverlay(); },
    set(patch) { Object.assign(ov, patch); sendOverlay(true); if (S.tab === 'mportals') refreshOvPanel(); },
    highlight(idx) { highlightedPortal = (idx === null || idx === undefined || idx === false) ? null : idx; _prevPortalsKey = null; },
  };

  function ovSummary() {
    const el = qid('ov-summary');
    if (el) el.textContent = ov.portals ? `nearest ${ov.maxPortals} within ${ov.distance} m` : 'off';
  }
  function toggle3DOverlay(state) { ov.portals = !!state; ovSummary(); sendOverlay(true); }
  function toggleOvSettings() {
    ovSettingsOpen = !ovSettingsOpen;
    store.set('jdt:mx:ovOpen', ovSettingsOpen);
    const w = qid('ov-wrap'); if (w) w.classList.toggle('open', ovSettingsOpen);
    document.querySelector('.ov-gear')?.classList.toggle('on', ovSettingsOpen);
  }
  function setOv(key, value, el) {
    if (typeof OV_DEFAULT[key] === 'number') {
      const v = parseFloat(value);
      ov[key] = key === 'textScale' ? Math.round(v * 10) / 10 : Math.round(v);
      const lbl = qid('ov-v-' + key);
      if (lbl) lbl.textContent = ov[key] + (key === 'distance' || key === 'labelDistance' ? 'm' : key === 'textScale' ? '×' : '');
      ovSummary();
      sendOverlay();
      return;
    }
    ov[key] = value;
    sendOverlay();
    if (key === 'colorMode') refreshOvPanel();
    else ovSummary();
  }
  function toggleOvField(k) { ov.fields[k] = !ov.fields[k]; sendOverlay(); refreshOvPanel(); }
  function setOvColor(k, c) { ov.colors[k] = c; sendOverlay(); refreshOvPanel(); }
  function resetOverlay() {
    const on = ov.portals;
    ov = { ...OV_DEFAULT, portals: on, fields: { ...OV_DEFAULT.fields }, colors: { ...OV_DEFAULT.colors } };
    sendOverlay(true);
    refreshOvPanel();
  }
  function refreshOvPanel() {
    const w = qid('ov-wrap');
    if (w) w.innerHTML = ovSettingsHTML();
    const lg = document.querySelector('.ov-legend');
    if (lg) lg.innerHTML = OV_COLORS.filter(([k]) => ov.colorMode === 'type' || k === 'normal' || k === 'selected').map(([k, l]) => `<span><i style="background:${ovCol(k)}"></i>${l}</span>`).join('');
    ovSummary();
  }
  function highlightPortal(id) {
    highlightedPortal = highlightedPortal === id ? null : id;
    nui('ins:overlay', { selected: highlightedPortal === null ? false : id });
    _prevPortalsKey = null;
    renderPortals();
  }
  function portalTypeColor(p, broken) {
    if (highlightedPortal === p.id) return ovCol('selected');
    if (ov.colorMode !== 'type') return ov.colors.normal;
    if (broken) return ov.colors.broken;
    if (p.flags & 4) return ov.colors.mirror;
    if (p.flags & 1) return ov.colors.oneway;
    if (p.flags & 2) return ov.colors.link;
    return ov.colors.normal;
  }

  function roomLabel(id) {
    const r = MX.rooms.find((x) => x.id === id);
    return r ? `${id}: ${r.name}` : String(id);
  }
  function buildRoomDropdown(portalId, dir, currentRoom) {
    const uid = `dd-p${portalId}-${dir}`;
    const items = MX.rooms.map((r) =>
      `<div class="rdd-item${r.id === currentRoom ? ' rdd-active' : ''}" onclick="selectPortalRoom(event,'${uid}',${portalId},'${dir}',${r.id})">${r.id}: ${esc(r.name)}</div>`).join('');
    return `<div class="rdd" id="${uid}">
      <div class="rdd-trigger" onclick="toggleDropdown(event,'${uid}')" title="Click to change room">
        <span class="rdd-val">${esc(roomLabel(currentRoom))}</span><span class="rdd-arrow">▾</span>
      </div>
      <div class="rdd-menu" id="${uid}-menu">${items || `<div class="rdd-item rdd-active">${currentRoom}</div>`}</div>
    </div>`;
  }
  // The open menu is drawn in one floating layer outside the window and its scrolling lists,
  // so no row, scroll container or transformed parent can clip, cover or shift it.
  function floatLayer() {
    let f = document.getElementById('rdd-float');
    if (!f) {
      f = document.createElement('div');
      f.id = 'rdd-float';
      f.className = 'rdd-menu';
      (document.getElementById('app') || document.body).appendChild(f);
    }
    return f;
  }
  function toggleDropdown(e, uid) {
    e.stopPropagation();
    const isOpen = openDropdownId === uid;
    closeAllDropdowns();
    if (isOpen) return;
    const dd = qid(uid), menu = qid(`${uid}-menu`);
    if (!dd || !menu) return;
    dd.classList.add('rdd-open');
    openDropdownId = uid;
    ddOpenedAt = performance.now();
    const f = floatLayer();
    f.innerHTML = menu.innerHTML;
    f.classList.add('open');
    const rect = dd.getBoundingClientRect();
    const h = Math.min(220, f.scrollHeight || 160), w = Math.max(170, rect.width);
    const shell = qid('shell');
    const box = shell ? shell.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const up = (box.bottom - rect.bottom) < h + 10 && rect.top - box.top > h + 10;
    f.style.minWidth = `${w}px`;
    f.style.left = `${Math.max(box.left + 4, Math.min(rect.left, box.right - w - 8))}px`;
    f.style.top = `${up ? rect.top - h - 3 : rect.bottom + 3}px`;
    f.classList.toggle('up', up);
    const act = f.querySelector('.rdd-active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function closeAllDropdowns() {
    const wasOpen = openDropdownId !== null;
    document.querySelectorAll('.rdd.rdd-open').forEach((el) => el.classList.remove('rdd-open'));
    const f = document.getElementById('rdd-float');
    if (f) f.classList.remove('open');
    openDropdownId = null;
    if (wasOpen && portalsPending) setTimeout(renderPortals, 0);
  }
  function selectPortalRoom(e, uid, portalId, dir, roomId) {
    e.stopPropagation();
    closeAllDropdowns();
    roomId = parseInt(roomId, 10);
    const portal = MX.portals.find((p) => p.id === portalId);
    if (!portal) return;
    if (dir === 'From') { portal.roomFrom = roomId; nuiPost('setPortalRoomFrom', { portalId, roomId }); }
    else { portal.roomTo = roomId; nuiPost('setPortalRoomTo', { portalId, roomId }); }
    _prevPortalsKey = null;
    renderPortals();
  }
  document.addEventListener('click', () => closeAllDropdowns());
  let ddOpenedAt = 0;
  document.addEventListener('scroll', (e) => { if (openDropdownId && performance.now() - ddOpenedAt > 450 && !(e.target.closest && e.target.closest('.rdd-menu'))) closeAllDropdowns(); }, true);

  let portalsPending = false;
  function renderPortals() {
    const list = qid('portal-list');
    if (!list) return;
    // never rebuild the list under an open room picker; catch up when it closes
    if (openDropdownId) { portalsPending = true; return; }
    portalsPending = false;
    const key = MX.portals.length ? MX.portals.map((p) => `${p.id}|${p.flags}|${p.roomFrom}|${p.roomTo}|${p.oflags}`).join(';') + '§' + MX.rooms.length + '§' + highlightedPortal + '§' + JSON.stringify(ov.colors) + ov.colorMode : '__empty__';
    if (key === _prevPortalsKey) return;
    const pc = qid('portal-count'); if (pc) pc.textContent = MX.portals.length || '';
    closeAllDropdowns();
    _prevPortalsKey = key;
    if (!MX.portals.length) { list.innerHTML = `<div class="mx-empty">${MX.intId === 'OUTSIDE' ? 'No interior detected' : 'This interior has no portals'}</div>`; return; }
    list.innerHTML = MX.portals.map((p) => {
      const active = PORTAL_FLAGS.filter((f) => p.flags & f.bit);
      const flagNames = active.length ? active.map((f) => f.name).join(', ') : 'No flags';
      const changed = p.flags !== p.oflags || p.roomFrom !== p.ofrom || p.roomTo !== p.oto;
      const broken = !MX.rooms.some((r) => r.id === p.roomFrom) || !MX.rooms.some((r) => r.id === p.roomTo);
      return `<div class="portal-card${changed ? ' changed' : ''}${highlightedPortal === p.id ? ' hl' : ''}" style="--pc:${portalTypeColor(p, broken)}">
        <span class="portal-id">${p.id}</span>
        <div class="portal-room-pickers">${buildRoomDropdown(p.id, 'From', p.roomFrom)}<span class="portal-pick-arrow">${p.flags & 1 ? '→' : '⇄'}</span>${buildRoomDropdown(p.id, 'To', p.roomTo)}</div>
        <div class="portal-flags">
          <span class="pflag-val${p.flags ? ' set' : ''}" title="Flag value">${p.flags >>> 0}</span>
          <span class="pflag-names${active.length ? '' : ' none'}" title="${esc(flagNames)}">${esc(flagNames)}</span>
          ${changed ? '<span class="tag-changed">Changed</span>' : ''}${broken ? '<span class="tag-changed" style="color:var(--bad)">Broken link</span>' : ''}
        </div>
        <div class="portal-actions">
          ${S.ui.allowTeleport !== false && p.w ? `<button class="pflag-edit" onclick="gotoPortal(${p.id})">Go to</button>` : ''}
          <button class="pflag-edit${highlightedPortal === p.id ? ' on' : ''}" onclick="highlightPortal(${p.id})">${highlightedPortal === p.id ? 'Highlighted' : 'Highlight'}</button>
          <button class="pflag-edit" onclick="openFlagModal(${p.id},${p.flags >>> 0})">Flags</button>
        </div>
      </div>`;
    }).join('');
  }
  function gotoPortal(id) {
    const p = MX.portals.find((x) => x.id === id);
    if (p && p.w) nuiPost('teleportTo', { x: p.w[0], y: p.w[1], z: p.w[2] });
  }
  function openFlagModal(portalId, flags) {
    editingPortal = { id: portalId, flags: flags >>> 0 };
    qid('flag-modal-title').textContent = `Portal #${portalId} — Flags`;
    qid('flag-grid').innerHTML = PORTAL_FLAGS.map((f) => {
      const on = !!(flags & f.bit);
      return `<div class="flag-item${on ? ' on' : ''}" onclick="togglePortalFlag(${f.bit},this)">
        <input type="checkbox" ${on ? 'checked' : ''} tabindex="-1" style="pointer-events:none">
        <span class="flag-name">${f.name}</span><span class="flag-bit">${f.bit}</span></div>`;
    }).join('');
    updatePortalFlagRaw();
    qid('flag-modal').classList.add('open');
  }
  function closeFlagModal() { qid('flag-modal').classList.remove('open'); editingPortal = null; }
  function togglePortalFlag(bit, el) {
    const cb = el.querySelector('input');
    cb.checked = !cb.checked;
    el.classList.toggle('on', cb.checked);
    if (editingPortal) editingPortal.flags = (cb.checked ? (editingPortal.flags | bit) : (editingPortal.flags & ~bit)) >>> 0;
    updatePortalFlagRaw();
  }
  function updatePortalFlagRaw() {
    if (!editingPortal) return;
    const dec = editingPortal.flags >>> 0;
    qid('flag-raw-val').textContent = String(dec);
  }
  function applyPortalFlags() {
    if (!editingPortal) return;
    nuiPost('setPortalFlag', { portalId: editingPortal.id, flags: editingPortal.flags });
    closeFlagModal();
  }
  function resetPortalFlags() {
    if (!editingPortal) return;
    nuiPost('resetPortal', { portalId: editingPortal.id });
    closeFlagModal();
  }

  /* =========================================================== ENTITY SETS */
  /* Sets come from three places:
     - the MLO's own .ytyp, read by the server (server/ytyp.js) - every set of a custom MLO, named when
       the name appears anywhere in your resources or GTA's list; an unnamed one shows its hash and takes
       a typed name (checked against the hash)
     - for GTA's own interiors (their .ytyp is inside the game archives) every known GTA set name is tested in the interior: what exists, on or off, is listed (client: Inspect.gtaSets)
     - names you add yourself (remembered per interior)
     Tint: each active set can be tinted (SetInteriorEntitySetTintIndex); the tint bar does what the
     classic tint scripts do with a set called "tint". The game cannot report a tint back, so the last
     one applied is remembered per interior. */

  var lastScanResult = {};       // name -> active
  var currentDisplaySets = [];
  var esFound = null;            // { key, found, resource, file, sets: [{ hash, name }] } for this interior
  var esBusy = false;

  const setsKey = () => `jdt:sets:${MX.nameHash >>> 0}`;
  const tintKey = () => `jdt:tints:${MX.nameHash >>> 0}`;
  const getUserSets = () => arr(store.get(setsKey(), []));
  const saveUserSets = (list) => store.set(setsKey(), list);
  const getTints = () => store.get(tintKey(), {}) || {};
  var esTintTarget = ['set', 'room', 'interior'].includes(store.get('jdt:tint-target', 'set')) ? store.get('jdt:tint-target', 'set') : 'set';
  var esObjTinted = 0;
  const esTintHelp = () => esTintTarget === 'set'
    ? 'Turns a set on and tints it, like the classic tint scripts. Most MLOs name it <span class="mono">tint</span>.'
    : `Tints the ${esTintTarget === 'room' ? 'objects in the room you stand in' : 'objects of the whole interior'} that have tints (sofas, cabinets, bars…). The rest keep their look.`;
  const hiddenKey = () => `jdt:sets-hidden:${MX.nameHash >>> 0}`;   // found sets the player deleted from the list
  const getHidden = () => arr(store.get(hiddenKey(), []));
  const saveHidden = (list) => store.set(hiddenKey(), list);
  const joaat = (str) => {
    let h = 0;
    str = String(str).toLowerCase();
    for (let i = 0; i < str.length; i++) { h = (h + str.charCodeAt(i)) >>> 0; h = (h + ((h << 10) >>> 0)) >>> 0; h = (h ^ (h >>> 6)) >>> 0; }
    h = (h + ((h << 3) >>> 0)) >>> 0; h = (h ^ (h >>> 11)) >>> 0; h = (h + ((h << 15) >>> 0)) >>> 0;
    return h >>> 0;
  };
  const hex = (h) => '0x' + (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const cleanName = (v) => String(v || '').replace(/[^\w.-]/g, '').slice(0, 64);

  VIEWS.entitysets = () => `
    <div class="es-source" id="es-source"><span class="es-src-dot"></span><span>Looking for this interior's entity sets…</span></div>
    <div class="es-tintbar" data-target="${esTintTarget}">
      <div class="es-tint-main"><b>Interior tint</b><span id="es-tint-help">${esTintHelp()}</span></div>
      <div class="ov-seg es-tint-target" role="tablist" title="What to tint">
        ${[['set', 'Entity set'], ['room', 'Objects in my room'], ['interior', 'All objects']].map(([k, l]) => `<button data-es-target="${k}" class="${esTintTarget === k ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <input id="es-tint-set" class="field-input mono es-tint-set" type="text" value="tint" spellcheck="false" autocomplete="off" title="Entity set to tint">
      <div class="es-step"><button onclick="esTintStep(-1)">−</button><input id="es-tint-val" class="mono" type="number" min="0" max="255" value="${Number(getTints().tint ?? 0)}" onkeydown="if(event.key==='Enter')esTintApply()"><button onclick="esTintStep(1)">+</button></div>
      <button class="btn primary sm" onclick="esTintApply()">Apply tint</button>
      <button class="btn outline sm es-obj-undo" id="es-obj-undo" onclick="esObjUndo()" title="Every object JDT tinted goes back to its own tint"${esObjTinted ? '' : ' hidden'}>Undo object tints</button>
    </div>
    <input id="ent-input" class="field-input es-input" type="text" placeholder="Add a set by name, Enter to add (several: separate with spaces or commas)"
      spellcheck="false" autocomplete="off" onkeydown="if(event.key==='Enter') addEntitySet()">
    <div class="mx-row">
      <div class="sec-label" style="flex:1">Entity sets <span class="mx-count" id="es-count"></span></div>
      <button class="btn outline sm" id="es-unhide" onclick="esUnhide()" hidden></button>
      <button class="btn outline sm" onclick="esScanGta()" title="Look for this interior's entity sets again">Scan again</button>
      <button class="btn outline sm" onclick="nuiPost('refreshInterior',{})">Refresh interior</button>
      <button class="btn outline sm" onclick="setAllEntitySets(true)">All on</button>
      <button class="btn outline sm" onclick="setAllEntitySets(false)">All off</button>
    </div>
    <div class="mx-scroll" id="entityset-list"><div class="mx-empty">Switch to this tab to load sets</div></div>`;

  function paintSource() {
    const el = qid('es-source');
    if (!el) return;
    const f = esFound;
    let cls = '', html;
    if (MX.intId === 'OUTSIDE') { cls = 'off'; html = 'Not in an interior'; }
    else if (!f || f.key !== (MX.nameHash >>> 0)) html = 'Reading the MLO\'s files for its entity sets…';
    else if (f.error) { cls = 'warn'; html = 'Could not read the MLO files (restart jdt so the server loads server/ytyp.js)'; }
    else if (f.vanilla && !f.sets.length) { cls = 'off'; html = `GTA interior: none of the ${f.tested || ''} known GTA set names exists here. Add a name above if you know one.`; }
    else if (f.vanilla && !f.reliable) { cls = 'warn'; html = `GTA interior: this game build cannot test sets that are off, so these are the sets that are on plus the names known for this interior (${f.sets.length})`; }
    else if (f.vanilla) { cls = 'ok'; html = `GTA interior: <b>${f.sets.length}</b> entity set${f.sets.length === 1 ? '' : 's'} found by testing ${f.tested} GTA set names here`; }
    else if (!f.found) { cls = 'off'; html = 'No .ytyp found for this interior: add set names above.'; }
    else if (!f.sets.length) { cls = 'off'; html = `This MLO has no entity sets <span class="mono">${esc(f.resource)}/${esc(f.file)}</span>`; }
    else {
      const unnamed = f.sets.filter((x) => !x.name).length;
      cls = 'ok';
      html = `${f.sets.length} set${f.sets.length === 1 ? '' : 's'} found in <span class="mono">${esc(f.resource)}/${esc(f.file)}</span>${unnamed ? ` · <b>${unnamed} without a known name</b>: type it on the card` : ''}`;
    }
    el.className = `es-source ${cls}`;
    el.innerHTML = `<span class="es-src-dot"></span><span>${html}</span>`;
  }

  async function discover() {
    const key = MX.nameHash >>> 0;
    if (esFound && esFound.key === key) return;
    if (esBusy) return;
    esBusy = true;
    paintSource();
    const r = await nui('sets:discover');
    esBusy = false;
    esFound = { key, found: false, sets: [], ...(r && typeof r === 'object' ? r : { error: true }), ...(r ? {} : { error: true }) };
    esFound.sets = arr(esFound.sets);
    // a GTA interior: no .ytyp to read, so test GTA's set names in it (client: Inspect.gtaSets)
    if (!esFound.found && !esFound.error && !esFound.outside) {
      const g = await nui('sets:gta', { names: getUserSets() });
      if (g && g.ok) {
        esFound = { ...esFound, found: true, vanilla: true, reliable: g.reliable !== false, tested: g.tested,
          sets: arr(g.sets).map((x) => ({ hash: joaat(x.name), name: x.name, known: !!x.known })) };
      }
    }
    // names typed earlier for unnamed sets
    const mine = new Map(getUserSets().map((n) => [joaat(n), n]));
    esFound.sets.forEach((x) => { if (!x.name && mine.has(x.hash >>> 0)) x.name = mine.get(x.hash >>> 0); });
  }

  async function fetchEntitySets() {
    const list = qid('entityset-list');
    if (!list) return;
    if (MX.intId === 'OUTSIDE') { paintSource(); list.innerHTML = '<div class="mx-empty">No interior detected</div>'; return; }
    await discover();
    paintSource();
    const hidden = new Set(getHidden());
    const auto = esFound && esFound.found ? esFound.sets.filter((x) => x.name && !hidden.has(x.name)).map((x) => x.name) : [];
    const names = [...new Set([...auto, ...getUserSets()])];
    const uh = qid('es-unhide');
    if (uh) { uh.hidden = !hidden.size; uh.textContent = `Show deleted (${hidden.size})`; uh.title = [...hidden].join(', '); }
    if (!list.children.length || list.firstElementChild.classList.contains('mx-empty')) list.innerHTML = '<div class="mx-empty">Checking…</div>';
    const raw = names.length ? await nuiPost('batchCheckSets', { names }) : {};
    lastScanResult = raw || {};
    names.forEach((n) => { if (lastScanResult[n] === undefined) lastScanResult[n] = false; });
    currentDisplaySets = names;
    renderEntitySets(currentDisplaySets);
  }
  function updateSetCount() {
    const c = qid('es-count');
    if (c) c.textContent = currentDisplaySets.length ? `${currentDisplaySets.filter((n) => lastScanResult[n]).length} / ${currentDisplaySets.length} on` : '';
  }
  function renderEntitySets(sets) {
    const list = qid('entityset-list');
    if (!list) return;
    const fromYtyp = new Set(esFound && esFound.found ? esFound.sets.filter((x) => x.name).map((x) => x.name) : []);
    const unnamed = esFound && esFound.found ? esFound.sets.filter((x) => !x.name) : [];
    const tints = getTints();
    if (!sets.length && !unnamed.length) {
      list.innerHTML = `<div class="mx-empty">No sets yet.<br><span style="font-size:10px;color:var(--text3)">Sets are found by themselves when there are any; you can also type a set name above.</span></div>`;
      updateSetCount();
      return;
    }
    list.innerHTML = sets.map((name) => {
      const on = lastScanResult[name] === true;
      const n = esc(name);
      const t = tints[name];
      return `<div class="es-card ${on ? 'es-active' : 'es-inactive'}" data-es="${n}">
        <div class="es-indicator ${on ? 'es-ind-on' : 'es-ind-off'}"></div>
        <span class="es-name">${n}</span>
        <span class="es-src">${fromYtyp.has(name) ? (esFound.vanilla ? 'GTA' : '.ytyp') : 'added'}</span>
        <div class="es-step es-step-sm${on ? '' : ' off'}" title="${on ? 'Tint of this set' : 'Turn the set on to tint it'}">
          <button data-es-tint="-1">−</button><input class="mono" type="number" min="0" max="255" placeholder="–" value="${t ?? ''}" data-es-tintval><button data-es-tint="1">+</button>
        </div>
        <button class="es-btn es-tint-clear" data-es-tintclear title="Delete this tint (back to the default look)"${t == null ? ' disabled' : ''}>Clear tint</button>
        <div class="es-actions">
          ${on ? `<button class="es-btn es-btn-deactivate" onclick="doDeactivate('${n}')">Turn off</button>`
               : `<button class="es-btn es-btn-activate" onclick="doActivate('${n}')">Turn on</button>`}
          <button class="es-btn es-btn-remove" title="Delete: turns it off, clears its tint and takes it off the list" onclick="removeEntitySet('${n}')">✕</button>
        </div>
      </div>`;
    }).join('') + unnamed.map((x) => `<div class="es-card es-unknown" data-es-hash="${x.hash >>> 0}">
        <div class="es-indicator es-ind-off"></div>
        <span class="es-name">Unnamed set <span class="es-hash">${hex(x.hash)}</span></span>
        <input class="field-input mono es-name-in" type="text" placeholder="type its name" spellcheck="false" autocomplete="off" data-es-guess>
        <span class="es-src">.ytyp</span>
      </div>`).join('');
    updateSetCount();
  }

  // tint: per card (delegated) and the tint bar
  async function applyTint(name, tint) {
    name = cleanName(name);
    tint = Math.max(0, Math.min(255, Math.round(Number(tint))));
    if (!name || !Number.isFinite(tint)) return false;
    const r = await nui('sets:tint', { name, tint });
    if (!r || !r.ok) { toast('error', 'Tint not applied', MX.intId === 'OUTSIDE' ? 'Stand inside the interior.' : 'Restart jdt so the game loads the latest files.'); return false; }
    const t = getTints(); t[name] = tint; store.set(tintKey(), t);
    lastScanResult[name] = true;
    const cb = [...document.querySelectorAll('[data-es]')].find((c) => c.dataset.es === name);
    const clr = cb && cb.querySelector('[data-es-tintclear]'); if (clr) clr.disabled = false;
    return true;
  }
  window.esTintStep = (d) => { const i = qid('es-tint-val'); if (!i) return; i.value = Math.max(0, Math.min(255, (Number(i.value) || 0) + d)); };   // just the number: Apply tint applies it
  window.esTintApply = async () => {
    if (esTintTarget !== 'set') {
      const v = Number((qid('es-tint-val') || {}).value);
      const r = await nui('objs:tint', { tint: Math.max(0, Math.min(255, Math.round(v || 0))), scope: esTintTarget });
      if (!r || !r.ok) { toast('error', 'Tint not applied', (r && r.error) || 'Restart jdt so the game loads the latest files.'); return; }
      esObjTinted = r.tinted || r.count || 0;
      const u = qid('es-obj-undo'); if (u) u.hidden = !esObjTinted;
      toast('success', `Tint ${Math.round(v || 0)}`, `on ${r.count} object${r.count === 1 ? '' : 's'} ${esTintTarget === 'room' ? 'in this room' : 'in this interior'} (objects without tints keep their look)`);
      return;
    }
    const set = cleanName((qid('es-tint-set') || {}).value || 'tint') || 'tint';
    const v = Number((qid('es-tint-val') || {}).value);
    if (await applyTint(set, v)) {
      if (!getUserSets().includes(set) && !(esFound && esFound.sets.some((x) => x.name === set))) saveUserSets([...getUserSets(), set]);
      toast('success', `Tint ${Math.round(v)}`, `on ${set}`);
      fetchEntitySets();
    }
  };
  window.esObjUndo = async () => {
    const r = await nui('objs:tint', { tint: -1 });
    esObjTinted = 0;
    const u = qid('es-obj-undo'); if (u) u.hidden = true;
    if (r && r.ok) toast('success', 'Object tints undone', `${r.count} object${r.count === 1 ? '' : 's'} back to their own tint`);
  };
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-es-target]');
    if (!b) return;
    esTintTarget = b.dataset.esTarget;
    store.set('jdt:tint-target', esTintTarget);
    const bar = b.closest('.es-tintbar'); bar.dataset.target = esTintTarget;
    bar.querySelectorAll('[data-es-target]').forEach((x) => x.classList.toggle('on', x === b));
    const h = qid('es-tint-help'); if (h) h.innerHTML = esTintHelp();
  });
  let tintTimer = 0;
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-es-tint]');
    if (!b) return;
    const card = b.closest('[data-es]'); const inp = card && card.querySelector('[data-es-tintval]');
    if (!inp || card.querySelector('.es-step.off')) return;
    inp.value = Math.max(0, Math.min(255, (Number(inp.value) || 0) + Number(b.dataset.esTint)));
    clearTimeout(tintTimer); tintTimer = setTimeout(() => applyTint(card.dataset.es, inp.value), 150);
  });
  document.addEventListener('change', (ev) => {
    const inp = ev.target.closest('[data-es-tintval]');
    if (inp && inp.value !== '') applyTint(inp.closest('[data-es]').dataset.es, inp.value);
  });
  // naming an unnamed set: accepted the moment the typed name hashes to the set's hash
  document.addEventListener('input', (ev) => {
    const inp = ev.target.closest('[data-es-guess]');
    if (!inp) return;
    const card = inp.closest('[data-es-hash]');
    const name = cleanName(inp.value);
    const hit = name && joaat(name) === Number(card.dataset.esHash);
    inp.classList.toggle('bad', !!name && !hit);
    if (!hit) return;
    const x = esFound.sets.find((s2) => (s2.hash >>> 0) === Number(card.dataset.esHash));
    if (x) x.name = name;
    saveUserSets([...new Set([...getUserSets(), name])]);
    toast('success', 'Name matches', `${name} is ${hex(joaat(name))}`);
    fetchEntitySets();
  });

  // look again (after a resource restart, or when an MLO changed)
  window.esScanGta = () => { esFound = null; fetchEntitySets(); };

  // delete a set: off in the game, tint gone, off the list (a set the MLO itself has stays hidden until "Show deleted")
  async function removeEntitySet(name) {
    if (lastScanResult[name]) await nuiPost('deactivateSet', { val: name });
    const t = getTints(); if (name in t) { delete t[name]; store.set(tintKey(), t); }
    saveUserSets(getUserSets().filter((n) => n !== name));
    const found = esFound && esFound.found && esFound.sets.some((x) => x.name === name);
    if (found && !getHidden().includes(name)) saveHidden([...getHidden(), name]);
    delete lastScanResult[name];
    currentDisplaySets = currentDisplaySets.filter((n) => n !== name);
    renderEntitySets(currentDisplaySets);
    toast('success', 'Entity set deleted', name);
    if (found) fetchEntitySets();
  }
  window.esUnhide = () => { const n = getHidden().length; saveHidden([]); fetchEntitySets(); toast('success', 'Deleted sets are back', `${n} set${n === 1 ? '' : 's'}`); };
  // delete a tint: the set goes back to its default look (tint 0) and no tint is kept for it
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-es-tintclear]');
    if (!b) return;
    const name = b.closest('[data-es]').dataset.es;
    const t = getTints(); delete t[name]; store.set(tintKey(), t);
    if (lastScanResult[name]) await nui('sets:tint', { name, tint: 0 });
    renderEntitySets(currentDisplaySets);
    toast('success', 'Tint deleted', name);
  });
  function addEntitySet() {
    const input = qid('ent-input');
    if (!input || MX.intId === 'OUTSIDE') return;
    // set names are identifiers: strip anything that could break markup / handlers
    const names = String(input.value || '').split(/[\s,;]+/).map(cleanName).filter(Boolean);
    if (!names.length) return;
    const arr2 = getUserSets();
    names.forEach((v) => { if (!arr2.includes(v)) arr2.push(v); });
    saveUserSets(arr2);
    saveHidden(getHidden().filter((n) => !names.includes(n)));
    input.value = '';
    fetchEntitySets();
  }
  async function doActivate(name) { await nuiPost('activateSet', { val: name }); lastScanResult[name] = true; renderEntitySets(currentDisplaySets); }
  async function doDeactivate(name) { await nuiPost('deactivateSet', { val: name }); lastScanResult[name] = false; renderEntitySets(currentDisplaySets); }
  async function setAllEntitySets(on) {
    for (const n of currentDisplaySets) await nuiPost(on ? 'activateSet' : 'deactivateSet', { val: n });
    fetchEntitySets();
  }

  /* ============================================================ TIMECYCLES */

  var tcFilter = '';

  VIEWS.timecycles = () => `
    <div class="tc-banner">
      <div class="tc-banner-left"><div class="tc-banner-label">Current room</div><div class="tc-banner-room" id="tc-cur-room">—</div></div>
      <div class="tc-banner-mid"><div class="tc-banner-label">Active timecycle</div><div class="tc-banner-val" id="tc-cur-val">none</div></div>
      <div style="display:flex;flex-direction:column;gap:5px;align-self:center">
        <button class="btn outline sm danger" onclick="resetCurrentTC()">Reset timecycle</button>
      </div>
    </div>
    <div class="mx-row tc-modes">
      <div class="ov-seg">
        <button data-tc-mode="library" class="${tcMode === 'library' ? 'on' : ''}">Library</button>
        <button data-tc-mode="editor" class="${tcMode === 'editor' ? 'on' : ''}">Editor</button>
      </div>
      <span class="insp-note">${tcMode === 'editor' ? 'Change a timecycle live, then export it as XML' : 'Pick a timecycle for the room you are in'}</span>
    </div>
    ${tcMode === 'editor' ? tceSkeleton() : tcLibrarySkeleton()}`;

  const tcLibrarySkeleton = () => `
    <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
      <input id="tc-custom-input" class="field-input" style="flex:1" type="text" placeholder="Any timecycle name or 0x hash, applied to the room you are in"
        spellcheck="false" autocomplete="off" onkeydown="if(event.key==='Enter') applyCustomHash()">
      <button class="btn primary sm" onclick="applyCustomHash()">Apply</button>
    </div>
    <div style="position:relative;display:flex;gap:6px;align-items:center;flex-shrink:0">
      <input id="tc-search" class="field-input" style="flex:1" type="text" placeholder="Filter timecycles…" spellcheck="false" autocomplete="off"
        value="${esc(tcFilter)}" oninput="filterTC()">
      <span id="tc-count" style="font-size:9px;color:var(--text3);white-space:nowrap"></span>
    </div>
    <div class="sec-label">Timecycle library <span class="insp-note">click one to apply it to the room you are in</span></div>
    <div class="mx-scroll" id="tc-grid"><div class="mx-empty">Loading…</div></div>`;

  /* ---- live editor: the variables of one timecycle, changed in the running game ---- */
  var tcMode = store.get('jdt:tc-mode', 'library') === 'editor' ? 'editor' : 'library';
  const TCE = { info: null, name: store.get('jdt:tce-name', '') || '', data: null, filter: '', only: false, strength: 1, loading: false,
    view: store.get('jdt:tce-view', 'all') === 'set' ? 'set' : 'all' };

  const tceSkeleton = () => `
    <div class="tce-bar">
      <input id="tce-name" class="field-input mono" type="text" list="tce-names" placeholder="Timecycle to edit" spellcheck="false" autocomplete="off"
        value="${esc(TCE.name)}" onkeydown="if(event.key==='Enter') tceLoad()">
      <datalist id="tce-names">${tcList.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
      <button class="btn primary sm" onclick="tceLoad()">Open</button>
      <button class="btn outline sm" onclick="tceLoadRoom()" title="Open the timecycle of the room you are standing in">My room's</button>
      <button class="btn outline sm" onclick="tceNew()" title="Make a copy under a new name (or an empty timecycle), so the original stays as it is">New / copy…</button>
    </div>
    <div id="tce-body" class="tce-body"><div class="mx-empty">Loading…</div></div>`;

  const tceNum = (v) => { const n = Number(v) || 0; return String(+n.toFixed(4)); };
  // slider range per variable: a fixed range for its kind, widened once to fit the game's own values.
  // It is worked out the first time a variable is shown and then kept, so dragging to the end never grows it.
  const TCE_KINDS = [
    [/freq/, 0, 1000],
    [/(^|_)col(our|or)?(_|$)|_col_[rgb]|(^|_)[rgb]$/, 0, 1],
    [/exposure|(^|_)ev(_|$)/, -5, 5],
    [/coeff|lens_dist|aberration|(^|_)shift/, -1, 1],
    [/(multiplier|_mult)$/, 0, 10],
    [/far_clip|clip|(^|_)dof_|_start$|_end$|range|dist|height|offset|falloff|_fall$|fog_start/, -1, 1000],
    [/desat|noise$|vignetting_(intensity|contrast)|alpha|opacity|blend|cutoff|wrap|thresh|amount/, 0, 1],
    [/ssao/, 0, 10],
    [/tweak/, 0, 20],
    [/filmic_[a-f]$|filmic_w$/, 0, 10],
    [/size|radius|length/, 0, 10],
    [/speed/, 0, 5],
    [/mult|inten|bloom|strength|scale|hdr|density|exp|lod/, 0, 10],
  ];
  const tceNice = (x) => { if (x <= 0) return 0; const e = Math.pow(10, Math.floor(Math.log10(x))); const f = x / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; };
  TCE.ranges = {};
  function tceFit(lo, hi, vals) {
    const pos = Math.max(0, ...vals), neg = Math.min(0, ...vals);
    if (pos > hi) hi = tceNice(pos * 1.25);
    if (neg < lo) lo = -tceNice(-neg);
    const span = hi - lo;
    const step = Math.min(0.001 * Math.max(1, Math.pow(10, Math.floor(Math.log10(span / 2)))), 1);
    return { min: lo, max: hi, step };
  }
  function tceRange(v) {
    const key = (TCE.data ? TCE.data.name : '') + '|' + v.n;
    if (TCE.ranges[key]) return TCE.ranges[key];
    const kind = TCE_KINDS.find(([re]) => re.test(v.n.toLowerCase()));
    const def = ((TCE.info && TCE.info.vars) || []).find((x) => x.n === v.n);
    const vals = [v.a, v.b, v.oa, v.ob, def && def.d].filter((x) => Number.isFinite(x));
    const r = tceFit(kind ? kind[1] : 0, kind ? kind[2] : 1, vals);
    TCE.ranges[key] = r;
    return r;
  }
  // a typed value outside the slider widens that one slider so the value fits
  function tceWiden(v, vals) {
    const key = (TCE.data ? TCE.data.name : '') + '|' + v.n;
    const r = TCE.ranges[key] || tceRange(v);
    if (vals.every((x) => x >= r.min && x <= r.max)) return;
    TCE.ranges[key] = tceFit(r.min, r.max, vals);
  }
  function tceRowHTML(v) {
    if (v.removedRow) {
      return `<div class="tce-row removed" data-tce="${esc(v.n)}">
        <div class="tce-name"><b>${esc(v.n)}</b><span>removed, was ${tceNum(v.oa)} ${tceNum(v.ob)}</span></div><span></span><span></span><span></span>
        <button class="es-btn" data-tce-reset title="Put it back">↺</button><span></span></div>`;
    }
    const changed = !v.unset && (v.added || v.a !== v.oa || v.b !== v.ob);
    const r = tceRange(v);
    const was = v.gone ? `removed here, was ${tceNum(v.gone.oa)} ${tceNum(v.gone.ob)}` : v.unset ? 'not in this timecycle · game default' : v.added ? 'added here' : `was ${tceNum(v.oa)} ${tceNum(v.ob)}`;
    return `<div class="tce-row${changed ? ' changed' : ''}${v.unset ? ' unset' : ''}" data-tce="${esc(v.n)}" data-linked="${v.a === v.b ? 1 : 0}">
      <div class="tce-name" title="${esc(v.n)}${v.i !== undefined ? ' · variable #' + v.i : ''}"><b>${esc(v.n)}</b><span>${changed || v.unset ? was : ''}</span></div>
      <input class="tce-slider" type="range" min="${r.min}" max="${r.max}" step="${r.step}" value="${v.a}" data-tce-s title="${v.a === v.b ? 'Drag to change both values' : 'Drag to change value 1 (value 2 is different, so it stays)'}">
      <input class="tce-val mono" type="number" step="${r.step}" value="${tceNum(v.a)}" data-tce-a title="Value 1">
      <input class="tce-val mono" type="number" step="${r.step}" value="${tceNum(v.b)}" data-tce-b title="Value 2">
      <button class="es-btn" data-tce-reset title="${v.gone ? 'Put it back' : 'Back to what it was'}"${changed || v.gone ? '' : ' disabled'}>↺</button>
      <button class="es-btn es-btn-remove" data-tce-del title="Remove this variable from the timecycle"${v.unset ? ' disabled' : ''}>✕</button>
    </div>`;
  }
  // every row the list can show, in the game's order ("All variables" adds the ones this timecycle doesn't set)
  function tcePool(d, info) {
    const order = new Map((info.vars || []).map((x, n) => [x.n, n]));
    const have = new Set(d.vars.map((v) => v.n));
    const removed = new Map((d.removed || []).map((r) => [r.n, r]));
    const free = (info.vars || []).filter((x) => !have.has(x.n));
    const pool = TCE.view === 'all'
      ? [...d.vars, ...free.map((x) => ({ n: x.n, a: x.d, b: x.d, oa: x.d, ob: x.d, unset: true, gone: removed.get(x.n) || null }))]
      : d.vars.slice();
    pool.forEach((v) => { if (order.has(v.n)) v.i = order.get(v.n); });
    pool.sort((x, y) => (x.i ?? 1e9) - (y.i ?? 1e9) || x.n.localeCompare(y.n));
    return { pool, free };
  }
  // Only the rows on screen exist (plus a few above and below). Every row has the same height, so the list keeps
  // its full length and the scrollbar is true, while opening the panel never builds hundreds of sliders.
  const TCE_H = 46, TCE_EXTRA = 6;
  function tceWindow(force) {
    const l = qid('tce-list'), win = qid('tce-win');
    if (!l || !win || !TCE.rows) return;
    const n = TCE.rows.length;
    const from = Math.max(0, Math.floor(l.scrollTop / TCE_H) - TCE_EXTRA);
    const to = Math.min(n, Math.ceil((l.scrollTop + (l.clientHeight || 400)) / TCE_H) + TCE_EXTRA);
    if (!force && from === TCE.from && to === TCE.to) return;
    // a field being typed in or a slider being dragged stays as it is until it is let go
    const a = document.activeElement;
    if (!force && a && win.contains(a) && a.tagName === 'INPUT' && from <= TCE.to && to >= TCE.from) {
      const i = TCE.rows.findIndex((x) => x.n === a.closest('.tce-row').dataset.tce);
      if (i >= from && i < to) return;
    }
    TCE.from = from; TCE.to = to;
    win.style.transform = `translateY(${from * TCE_H}px)`;
    win.innerHTML = TCE.rows.slice(from, to).map(tceRowHTML).join('');
  }
  // the name suggestions of "Add a variable" are filled when the field is first used
  document.addEventListener('focusin', (ev) => {
    if (ev.target.id !== 'tce-add') return;
    const dl = qid('tce-vars');
    if (dl && !dl.children.length) dl.innerHTML = (TCE.free || []).map((x) => `<option value="${esc(x.n)}"></option>`).join('');
  });
  function tceRender(keep) {
    const body = qid('tce-body');
    if (!body) return;
    body.dataset.ready = '1';
    const info = TCE.info;
    if (!info) { body.innerHTML = '<div class="mx-empty">Loading…</div>'; delete body.dataset.ready; return; }
    if (!info.supported) { body.innerHTML = '<div class="mx-empty">This FiveM build has no timecycle editing. Update the FiveM client to use the editor.</div>'; return; }
    const d = TCE.data;
    if (!d || !d.ok) {
      body.innerHTML = `<div class="mx-empty">${d && d.error ? esc(d.error) + '. ' : ''}Type a timecycle name and press Open, or use <b>My room's</b> while standing in a room.</div>`;
      return;
    }
    const q = TCE.filter.toLowerCase();
    const { pool, free } = tcePool(d, info);
    const rows = pool.filter((v) => (!q || v.n.toLowerCase().includes(q)) && (!TCE.only || v.gone || (!v.unset && (v.added || v.a !== v.oa || v.b !== v.ob))));
    const previewing = TCE.preview === d.name;
    const gone = TCE.view === 'all' ? [] : (d.removed || []).filter((v) => !q || v.n.toLowerCase().includes(q));
    const top = keep ? (qid('tce-list') ? qid('tce-list').scrollTop : TCE.top || 0) : 0;
    TCE.rows = rows.concat(gone.map((v) => ({ ...v, removedRow: true }))); TCE.free = free;
    const names = qid('tce-names');
    if (names && names.children.length !== tcList.length) names.innerHTML = tcList.map((n) => `<option value="${esc(n)}"></option>`).join('');
    body.innerHTML = `
      <div class="tce-head">
        <div class="tce-title"><b class="mono">${esc(d.name)}</b>
          <span>${d.vars.length} variable${d.vars.length === 1 ? '' : 's'}${d.changed ? ` · <em>${d.changed} changed</em>` : ''}${d.created ? ' · made in JDT' : ''}</span></div>
        <div class="tce-actions">
          <label class="tce-prev${previewing ? ' on' : ''}" title="Force this timecycle on your screen, wherever you are">
            <input type="checkbox" id="tce-prev"${previewing ? ' checked' : ''}> Show on screen</label>
          <input id="tce-strength" type="range" min="0" max="2" step="0.05" value="${TCE.strength}" title="Strength on screen"${previewing ? '' : ' disabled'}>
          <button class="btn outline sm" onclick="tceApplyRoom()" title="Use this timecycle for the room you are standing in">Apply to my room</button>
          <button class="btn outline sm" onclick="tceResetAll()"${d.changed ? '' : ' disabled'}>Undo all</button>
          <button class="btn primary sm" onclick="tceExport()">Export XML</button>
          ${d.created ? '<button class="btn outline sm danger" onclick="tceDelete()">Delete</button>' : ''}
        </div>
      </div>
      <div class="tce-tools">
        <input id="tce-filter" class="field-input" type="text" placeholder="Filter variables…" spellcheck="false" autocomplete="off" value="${esc(TCE.filter)}">
        <div class="ov-seg tce-view">
          <button data-tce-view="all" class="${TCE.view === 'all' ? 'on' : ''}" title="Every variable the game has; the ones not in this timecycle show the game default and are added when you change them">All variables (${(info.vars || []).length || d.vars.length})</button>
          <button data-tce-view="set" class="${TCE.view === 'set' ? 'on' : ''}">In this timecycle (${d.vars.length})</button>
        </div>
        <label class="tce-only"><input type="checkbox" id="tce-only"${TCE.only ? ' checked' : ''}> Changed only</label>
        <span style="flex:1"></span>
        <input id="tce-add" class="field-input mono" type="text" list="tce-vars" placeholder="Add a variable…" spellcheck="false" autocomplete="off">
        <datalist id="tce-vars"></datalist>
        <button class="btn outline sm" onclick="tceAdd()">Add</button>
      </div>
      <div class="tce-cols"><span>Variable</span><span></span><span>Value 1</span><span>Value 2</span><span></span><span></span></div>
      <div class="mx-scroll tce-list" id="tce-list">${TCE.rows.length
        ? `<div class="tce-pad" style="height:${TCE.rows.length * TCE_H}px"><div class="tce-win" id="tce-win"></div></div>`
        : `<div class="mx-empty">${d.vars.length ? 'No variable matches' : 'This timecycle has no variables yet. Add one above.'}</div>`}
      </div>`;
    const l = qid('tce-list');
    if (l) {
      if (top) l.scrollTop = top;
      TCE.top = l.scrollTop;
      l.addEventListener('scroll', () => { if (l.isConnected) { TCE.top = l.scrollTop; tceWindow(); } }, { passive: true });
    }
    tceWindow(true);
  }
  // after one value changed: redraw that row and the counts only
  function tceRefreshRow(name) {
    const d = TCE.data, info = TCE.info;
    if (!d || !d.ok || !info || TCE.only || !TCE.rows) return tceRender(true);
    const v = tcePool(d, info).pool.find((x) => x.n === name);
    const i = TCE.rows.findIndex((x) => x.n === name);
    if (!v || i < 0) return tceRender(true);
    TCE.rows[i] = v;
    const row = [...document.querySelectorAll('#tce-win .tce-row')].find((r) => r.dataset.tce === name);
    if (row) row.outerHTML = tceRowHTML(v);
    const head = document.querySelector('.tce-title span');
    if (head) head.innerHTML = `${d.vars.length} variable${d.vars.length === 1 ? '' : 's'}${d.changed ? ` · <em>${d.changed} changed</em>` : ''}${d.created ? ' · made in JDT' : ''}`;
    const undo = [...document.querySelectorAll('.tce-actions .btn')].find((b) => b.textContent === 'Undo all');
    if (undo) undo.disabled = !d.changed;
    const setBtn = document.querySelector('[data-tce-view="set"]');
    if (setBtn) setBtn.textContent = `In this timecycle (${d.vars.length})`;
  }
  async function tceInit() {
    if (!TCE.info) {
      const info = await nui('tc:info', {});
      TCE.info = info && typeof info.supported === 'boolean' ? info : { supported: false, list: [], vars: [] };
      TCE.preview = TCE.info.preview ? TCE.info.preview.name : null;
      if (TCE.info.preview) TCE.strength = TCE.info.preview.strength;
      // timecycles the server streams are not in the catalog: the game's own list has them
      const extra = arr(TCE.info.list).filter((n) => !tcHashMap.has(joaat(n)));
      if (extra.length) { setTimecycles([...tcList, ...extra].sort((a, b) => a.localeCompare(b))); _prevTCKey = null; }
    }
    if (TCE.name && TCE.info.supported && TCE.tried !== TCE.name) await tceOpen(TCE.name, true);
    else tceRender(true);
  }
  async function tceOpen(name, quiet) {
    name = String(name || '').trim();
    if (!name) { if (!quiet) toast('warning', 'No timecycle', 'Type a timecycle name first.'); tceRender(); return; }
    TCE.tried = name;
    const d = await nui('tc:get', { name });
    TCE.data = d && typeof d === 'object' ? d : { ok: false, error: 'Restart jdt so the game loads the latest files' };
    if (TCE.data.ok) { TCE.name = TCE.data.name; store.set('jdt:tce-name', TCE.name); const i = qid('tce-name'); if (i) i.value = TCE.name; }
    else if (!quiet && TCE.data.error) toast('error', 'Timecycle not opened', TCE.data.error);
    tceRender();
  }
  window.tceLoad = () => tceOpen(qid('tce-name') ? qid('tce-name').value : '');
  window.tceLoadRoom = () => {
    const room = currentRoom();
    if (!room) return toast('warning', 'Not in a room', 'Walk into a room of the interior first.');
    if (!room.tcHash || room.tcName === 'none') return toast('warning', 'No timecycle', `${room.name} has no timecycle. Pick one in Library first.`);
    const name = room.tcName || hashToName(room.tcHash);
    if (/^(0x|\d+$)/i.test(name)) return toast('warning', 'Unknown timecycle', 'This room uses a timecycle JDT has no name for. Type its name to open it.');
    tceOpen(name);
  };
  window.tceNew = () => {
    const src = TCE.data && TCE.data.ok ? TCE.data.name : '';
    modal(`<h2>${src ? `Copy ${esc(src)}` : 'New timecycle'}</h2>
      <p class="muted small">${src ? `A copy of <b>${esc(src)}</b> under a new name. The original stays as it is.` : 'An empty timecycle. Add variables to it in the editor.'}</p>
      <input id="tce-new-name" class="field-input mono" type="text" maxlength="64" spellcheck="false" autocomplete="off" value="${esc(src ? src + '_custom' : 'my_timecycle')}">
      ${src ? '<label class="tce-only" style="margin-top:10px"><input type="checkbox" id="tce-new-copy" checked> Copy its variables</label>' : ''}
      <div class="row end"><button class="btn ghost" data-close-modal>Cancel</button><button class="btn primary" data-modal-ok>Create</button></div>`,
    async (card) => {
      const name = ($('#tce-new-name', card).value || '').trim();
      const box = $('#tce-new-copy', card);
      const r = await nui('tc:clone', { name, source: box && box.checked ? src : null });
      if (!r || !r.ok) return toast('error', 'Not created', (r && r.error) || 'Restart jdt so the game loads the latest files');
      if (!tcHashMap.has(joaat(r.name))) { setTimecycles([...tcList, r.name].sort((a, b) => a.localeCompare(b))); _prevTCKey = null; }
      toast('success', 'Timecycle created', r.name);
      tceOpen(r.name);
    });
  };
  window.tceDelete = async () => {
    const d = TCE.data; if (!d || !d.ok) return;
    const r = await nui('tc:delete', { name: d.name });
    if (!r || !r.ok) return toast('error', 'Not deleted', (r && r.error) || '');
    if (TCE.preview === d.name) TCE.preview = null;
    toast('success', 'Timecycle deleted', d.name);
    TCE.data = null; TCE.name = ''; store.set('jdt:tce-name', '');
    const i = qid('tce-name'); if (i) i.value = '';
    tceRender();
  };
  window.tceApplyRoom = () => { if (TCE.data && TCE.data.ok) applyTCName(TCE.data.name); };
  window.tceResetAll = async () => {
    const d = TCE.data; if (!d || !d.ok) return;
    const r = await nui('tc:reset', { name: d.name });
    if (r && r.ok) { TCE.data = r; tceRender(); toast('success', 'Changes undone', d.name); }
  };
  window.tceAdd = async () => {
    const d = TCE.data, inp = qid('tce-add'); if (!d || !d.ok || !inp) return;
    const name = inp.value.trim();
    const known = (TCE.info.vars || []).find((x) => x.n.toLowerCase() === name.toLowerCase());
    if (!known) return toast('warning', 'Unknown variable', 'Pick one from the list: start typing to search.');
    if (d.vars.some((v) => v.n === known.n)) return toast('warning', 'Already there', known.n);
    await nui('tc:set', { name: d.name, var: known.n, a: known.d, b: known.d });
    TCE.filter = ''; TCE.only = false;
    await tceOpen(d.name, true);
    const at = (TCE.rows || []).findIndex((x) => x.n === known.n), l = qid('tce-list');
    if (at >= 0 && l) {
      if (at * TCE_H < l.scrollTop || (at + 1) * TCE_H > l.scrollTop + l.clientHeight) l.scrollTop = Math.max(0, at * TCE_H - l.clientHeight / 2);
      tceWindow(true);
      const row = [...document.querySelectorAll('#tce-win .tce-row')].find((x) => x.dataset.tce === known.n);
      if (row) row.classList.add('flash');
    }
  };
  // timecycle XML, ready for a resource (data_file 'TIMECYCLEMOD_FILE')
  function tceXML(d) {
    const f = (n) => (Number(n) || 0).toFixed(3);
    return `<?xml version="1.0" encoding="UTF-8"?>
<timecycle_modifier_data version="1.000000">
  <modifier name="${d.name}" numMods="${d.vars.length}" userFlags="0">
${d.vars.map((v) => `    <${v.n}>${f(v.a)} ${f(v.b)}</${v.n}>`).join('\n')}
  </modifier>
</timecycle_modifier_data>
`;
  }
  window.tceExport = async () => {
    const d = TCE.data; if (!d || !d.ok) return;
    const r = await nui('tc:export', { name: d.name });
    const xml = (r && r.xml) || tceXML(d);
    const saved = r && r.ok;
    if (saved) toast('success', 'Timecycle file written', r.file);
    else toast('warning', 'File not written', (r && r.error) || 'Restart jdt so the game loads the latest files');
    const gta = !d.created;
    modal(`<h2>${esc(d.name)} exported</h2>
      ${saved ? `<p class="muted small">Written on the server: <span class="mono">jdt/${esc(r.file)}</span> (${r.count} variables).<br>
        JDT loads every file in that folder: run <span class="mono">refresh</span> and <span class="mono">ensure jdt</span> and everyone gets this timecycle, also after a server restart.</p>`
    : '<p class="muted small">The file could not be written on the server, so here is the XML to save yourself.</p>'}
      ${gta ? `<p class="muted small"><b>${esc(d.name)}</b> is one of the game's own timecycles. A file with the same name may not replace it on every game build: to be sure, use <b>New / copy</b>, export the copy and apply that to your rooms.</p>` : ''}
      <p class="muted small">To ship it in another resource, copy the file there and add these lines to that resource's <span class="mono">fxmanifest.lua</span>:</p>
      <pre class="tce-xml mono">files { 'timecycle_mods_${esc(d.name)}.xml' }\ndata_file 'TIMECYCLEMOD_FILE' 'timecycle_mods_${esc(d.name)}.xml'</pre>
      <textarea id="tce-xml" class="mono" rows="10" readonly spellcheck="false">${esc(xml)}</textarea>
      <div class="row end"><button class="btn ghost" data-close-modal>Close</button><button class="btn primary" data-tce-copy>Copy XML</button></div>`);
  };
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('[data-tce-copy]')) return;
    const ta = qid('tce-xml'); if (!ta) return;
    copyStr(ta.value);
    toast('success', 'XML copied', 'Paste it into the file');
  });

  // value edits: the game gets them while you drag, the row re-reads when you let go
  let tceTimer = 0;
  const tceSend = (name, v, a, b) => { clearTimeout(tceTimer); tceTimer = setTimeout(() => nui('tc:set', { name, var: v, a, b }), 25); };
  document.addEventListener('input', (ev) => {
    const row = ev.target.closest && ev.target.closest('#tce-list .tce-row');
    const d = TCE.data;
    if (row && d && d.ok) {
      const A = row.querySelector('[data-tce-a]'), B = row.querySelector('[data-tce-b]'), S2 = row.querySelector('[data-tce-s]');
      if (!A) return;
      if (ev.target === S2) { const linked = row.dataset.linked !== '0'; A.value = tceNum(S2.value); if (linked) B.value = A.value; }
      const a = Number(A.value), b = Number(B.value);
      if (!Number.isFinite(a) || !Number.isFinite(b) || A.value === '' || B.value === '') return;
      if (ev.target === A || ev.target === B) {
        const vv = d.vars.find((x) => x.n === row.dataset.tce) || { n: row.dataset.tce, a, b };
        if (vv) { tceWiden(vv, [a, b]); const r = TCE.ranges[d.name + '|' + vv.n]; S2.min = r.min; S2.max = r.max; S2.step = r.step; A.step = B.step = r.step; }
      }
      if (ev.target === A) S2.value = a;
      const v = d.vars.find((x) => x.n === row.dataset.tce);
      if (v) { v.a = a; v.b = b; row.classList.toggle('changed', v.added || v.a !== v.oa || v.b !== v.ob); }
      const wr = (TCE.rows || []).find((x) => x.n === row.dataset.tce);
      if (wr && wr !== v) { wr.a = a; wr.b = b; }
      tceSend(d.name, row.dataset.tce, a, b);
      return;
    }
    if (ev.target.id === 'tce-filter') { TCE.filter = ev.target.value.trim(); tceRenderKeepFocus('tce-filter'); }
    if (ev.target.id === 'tce-strength' && TCE.preview) { TCE.strength = Number(ev.target.value) || 0; nui('tc:preview', { name: TCE.preview, strength: TCE.strength }); }
  });
  function tceRenderKeepFocus(id) {
    const el = qid(id), pos = el ? el.selectionStart : 0;
    tceRender();
    const n = qid(id); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* not a text field */ } }
  }
  document.addEventListener('change', async (ev) => {
    const d = TCE.data;
    if (ev.target.id === 'tce-only') { TCE.only = ev.target.checked; tceRender(); return; }
    if (ev.target.id === 'tce-prev' && d && d.ok) {
      const r = await nui('tc:preview', { on: ev.target.checked, name: d.name, strength: TCE.strength });
      TCE.preview = r && r.on ? d.name : null;
      tceRender();
      return;
    }
    // a value field or slider was let go: refresh the row's "was" note and the changed count
    if (ev.target.closest && ev.target.closest('#tce-list .tce-row') && d && d.ok) {
      clearTimeout(tceTimer);
      const row = ev.target.closest('.tce-row');
      const v = d.vars.find((x) => x.n === row.dataset.tce);
      if (v) await nui('tc:set', { name: d.name, var: v.n, a: v.a, b: v.b });
      else {
        // a variable this timecycle didn't have: changing it adds it
        const a = Number(row.querySelector('[data-tce-a]').value), b = Number(row.querySelector('[data-tce-b]').value);
        if (Number.isFinite(a) && Number.isFinite(b)) await nui('tc:set', { name: d.name, var: row.dataset.tce, a, b });
      }
      const fresh = await nui('tc:get', { name: d.name });
      if (fresh && fresh.ok) { TCE.data = fresh; tceRefreshRow(row.dataset.tce); }
    }
  });
  document.addEventListener('click', async (ev) => {
    const tv = ev.target.closest('[data-tce-view]');
    if (tv) { TCE.view = tv.dataset.tceView; store.set('jdt:tce-view', TCE.view); tceRender(); return; }
    const m = ev.target.closest('[data-tc-mode]');
    if (m) {
      if (m.dataset.tcMode === tcMode) return;
      tcMode = m.dataset.tcMode; store.set('jdt:tc-mode', tcMode);
      _prevTCKey = null;
      render();
      return;
    }
    const row = ev.target.closest('#tce-list .tce-row');
    const d = TCE.data;
    if (!row || !d || !d.ok) return;
    const top = qid('tce-list').scrollTop;
    let r = null;
    if (ev.target.closest('[data-tce-del]')) r = await nui('tc:remove', { name: d.name, var: row.dataset.tce });
    else if (ev.target.closest('[data-tce-reset]')) r = await nui('tc:reset', { name: d.name, var: row.dataset.tce });
    if (r && r.ok) { TCE.data = r; tceRender(true); }
  });

  function currentRoom() { return MX.rooms.find((r) => r.id === MX.currentRoomId); }
  function renderTCStatus() {
    const room = currentRoom();
    const nameEl = qid('tc-cur-room'), valEl = qid('tc-cur-val');
    if (!nameEl || !valEl) return;
    if (room) {
      nameEl.textContent = room.name;
      valEl.textContent = (!room.tcHash || room.tcName === 'none') ? 'none' : (room.tcName || hashToName(room.tcHash));
    } else {
      nameEl.textContent = MX.intId === 'OUTSIDE' ? 'Outside' : '—';
      valEl.textContent = '—';
    }
  }
  function renderTCGrid() {
    const grid = qid('tc-grid');
    if (!grid) return;
    const q = tcFilter.toLowerCase();
    const filtered = tcList.filter((n) => !q || n.toLowerCase().includes(q));
    const room = currentRoom();
    const activeName = room ? (room.tcName || hashToName(room.tcHash)) : '';
    const key = `${q}|${activeName}|${tcList.length}`;
    if (key === _prevTCKey) return;
    _prevTCKey = key;
    const cnt = qid('tc-count');
    if (cnt) cnt.textContent = filtered.length !== tcList.length ? `${filtered.length} / ${tcList.length}` : `${tcList.length} entries`;
    if (!tcList.length) { grid.innerHTML = '<div class="mx-empty">Loading…</div>'; return; }
    if (!filtered.length) { grid.innerHTML = '<div class="mx-empty">No matches</div>'; return; }
    grid.innerHTML = filtered.map((name) =>
      `<button class="tc-chip${activeName === name ? ' active' : ''}" data-tc="${esc(name)}">${esc(name)}</button>`).join('');
  }
  // one delegated listener instead of 1,200 inline handlers
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('#tc-grid .tc-chip');
    if (chip) applyTCName(chip.dataset.tc);
  });
  let tcTimer = null;
  function filterTC() {
    tcFilter = (qid('tc-search') && qid('tc-search').value.trim()) || '';
    clearTimeout(tcTimer);
    tcTimer = setTimeout(() => { _prevTCKey = null; renderTCGrid(); }, 90);
  }
  function applyTCName(name) {
    const room = currentRoom();
    if (!room) return toast('warning', 'Not in a room', 'Walk into a room of the interior first.');
    nuiPost('setRoomTimecycle', { roomId: room.id, value: joaat(name) });
  }
  async function resetCurrentTC() {
    const room = currentRoom();
    if (!room) return;
    // the values changed in the Editor go back too: of the timecycle the room shows now and of the one it started with
    const names = new Set();
    [room.tcName || hashToName(room.tcHash), hashToName(room.originalTcHash)].forEach((n) => { if (n && n !== 'none' && !/^(0x|\d+$)/i.test(n)) names.add(n); });
    let undone = 0;
    for (const n of names) {
      const before = TCE.data && TCE.data.ok && TCE.data.name === n ? TCE.data.changed : null;
      let r = null;
      try { r = await nui('tc:reset', { name: n }); } catch (e) { /* the room still goes back below */ }
      if (r && r.ok) {
        if (before) undone += before;
        if (TCE.data && TCE.data.ok && TCE.data.name === n) { TCE.data = r; if (tcMode === 'editor') tceRender(true); }
      }
    }
    nuiPost('clearRoomTimecycle', { roomId: room.id, value: room.originalTcHash || 0 });
    toast('success', 'Timecycle reset', undone ? `${room.name}: its timecycle and ${undone} changed value${undone === 1 ? '' : 's'} are back` : `${room.name} is back to its own timecycle`);
  }
  function applyCustomHash() {
    const input = qid('tc-custom-input');
    const room = currentRoom();
    if (!input || !room) return;
    const h = parseTC(input.value);
    if (h === null) return;
    nuiPost('setRoomTimecycle', { roomId: room.id, value: h });
  }

  /* ============================================================= LOCATIONS */

  const WP_KEY = 'jdt:waypoints';
  var waypoints = loadWaypoints();
  var _coordsBuilt = false;

  function cleanWp(w) {
    if (!w || typeof w !== 'object') return null;
    const x = Number(w.x), y = Number(w.y), z = Number(w.z), h = Number(w.h) || 0;
    if (![x, y, z].every(Number.isFinite) || Math.abs(x) > 20000 || Math.abs(y) > 20000 || z < -500 || z > 3000) return null;
    return {
      id: String(w.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6))).slice(0, 32),
      name: String(w.name || 'Location').replace(/[\u0000-\u001f]/g, '').slice(0, 48) || 'Location',
      x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), h: +(((h % 360) + 360) % 360).toFixed(1),
      roomName: String(w.roomName || w.room || '').slice(0, 64), intId: w.intId ?? w.interior ?? '', ts: Number(w.ts) || Date.now(),
    };
  }
  function loadWaypoints() { return arr(store.get(WP_KEY, [])).map(cleanWp).filter(Boolean); }
  function persistWaypoints() { store.set(WP_KEY, waypoints.slice(0, 300)); }

  VIEWS.locations = () => `
    <div id="coords-live" class="coords-live-wrap"><div class="coords-live-row"><span style="color:var(--text3);font-size:11px">Waiting for position data…</span></div></div>
    <div class="wp-save-row">
      <input id="wp-name-input" class="field-input" type="text" placeholder="Name this spot (optional)" spellcheck="false" autocomplete="off" maxlength="48"
        onkeydown="if(event.key==='Enter') saveWaypoint()">
      <button class="btn primary sm" style="flex-shrink:0" onclick="saveWaypoint()">Save location</button>
    </div>
    <div class="mx-row wp-head" data-mode="${wpMode}">
      <div class="ov-seg wp-mode">
        <button data-wp-mode="saved" class="${wpMode === 'saved' ? 'on' : ''}">Saved <span id="wp-count"></span></button>
        <button data-wp-mode="gta" class="${wpMode === 'gta' ? 'on' : ''}">GTA interiors <span id="gi-count"></span></button>
      </div>
      <div style="flex:1"></div>
      <input id="wp-filter" class="field-input" style="width:190px;padding:5px 9px;font-size:11px" placeholder="${wpMode === 'gta' ? 'Search interiors…' : 'Filter…'}" oninput="renderWaypoints()" spellcheck="false">
      <button class="btn outline sm wp-saved-only" onclick="exportWaypoints()">Export</button>
      <button class="btn outline sm wp-saved-only" onclick="importWaypoints()">Import</button>
    </div>
    <div class="mx-scroll" id="wp-list"></div>`;

  function saveWaypoint() {
    const nameInput = qid('wp-name-input');
    const raw = nameInput && nameInput.value.trim();
    const p = MX.playerPos;
    if (!p || (p.x === 0 && p.y === 0 && p.z === 0)) return;
    const w = cleanWp({
      name: raw || `Location ${waypoints.length + 1}`, x: p.x, y: p.y, z: p.z, h: p.h,
      intId: MX.intId, roomName: MX.currentRoomName || '', ts: Date.now(),
    });
    if (!w) return;
    waypoints.unshift(w);
    persistWaypoints();
    if (nameInput) nameInput.value = '';
    renderWaypoints();
  }
  function deleteWaypoint(id) { waypoints = waypoints.filter((w) => w.id !== id); persistWaypoints(); renderWaypoints(); }
  /* ---- GTA's own interiors (catalog/vanilla_interiors.json): IPLs loaded on the way in ---- */
  var wpMode = store.get('jdt:wp-mode', 'saved') === 'gta' ? 'gta' : 'saved';
  var gtaInteriors = [];
  const giShut = new Set(arr(store.get('jdt:gi-shut', [])));   // groups folded by the player
  fetch('../catalog/vanilla_interiors.json').then((r) => r.json()).then((l) => {
    gtaInteriors = Array.isArray(l) ? l.map((e, i) => ({ ...e, i })) : [];
    if (S.tab === 'locations') renderWaypoints();
  }).catch(() => {});

  function renderGtaInteriors(list) {
    const q = ((qid('wp-filter') && qid('wp-filter').value) || '').trim().toLowerCase();
    const shown = gtaInteriors.filter((e) => !q || `${e.name} ${e.cat}`.toLowerCase().includes(q));
    if (!shown.length) { list.innerHTML = `<div class="mx-empty">${gtaInteriors.length ? 'No interior matches' : 'Loading GTA interiors…'}</div>`; return; }
    const tp = S.ui.allowTeleport !== false;
    // one group per category: its header sticks only while its own rows are in view, so headers never pile up
    const groups = [];
    shown.forEach((e) => { const g = groups[groups.length - 1]; if (g && g.cat === e.cat) g.rows.push(e); else groups.push({ cat: e.cat, rows: [e] }); });
    // click a group's title to fold it; a search opens them all
    list.innerHTML = groups.map((g) => `<div class="gi-group${q || !giShut.has(g.cat) ? ' open' : ''}" data-gi-cat="${esc(g.cat)}"><button class="gi-cat">${esc(g.cat)} <span>${g.rows.length}</span></button>${g.rows.map((e) => {
      const ipl = e.ipls ? e.ipls.length : 0;
      return `<div class="gi-row" data-gi="${e.i}">
        <div class="gi-main"><b>${esc(e.name)}</b>${ipl || e.note ? `<span>${[ipl ? `Loads ${ipl} IPL${ipl === 1 ? '' : 's'}` : '', e.note ? esc(e.note) : ''].filter(Boolean).join(', ')}</span>` : ''}</div>
        <span class="gi-xyz mono">${fmt(e.x)}, ${fmt(e.y)}, ${fmt(e.z)}</span>
        <div class="wp-actions">
          ${tp ? `<button class="wp-btn wp-btn-tp" data-gi-go title="Load it and teleport there">Teleport</button>` : ''}
          <button class="wp-btn" data-gi-save title="Add to your saved locations">Save</button>
          <button class="wp-btn wp-btn-copy" data-gi-copy>Copy</button>
        </div>
      </div>`;
    }).join('')}</div>`).join('');
  }
  document.addEventListener('click', async (ev) => {
    const m = ev.target.closest('[data-wp-mode]');
    if (m) {
      wpMode = m.dataset.wpMode; store.set('jdt:wp-mode', wpMode);
      const head = m.closest('.wp-head'); head.dataset.mode = wpMode;
      head.querySelectorAll('[data-wp-mode]').forEach((b) => b.classList.toggle('on', b === m));
      const f = qid('wp-filter'); if (f) { f.value = ''; f.placeholder = wpMode === 'gta' ? 'Search interiors…' : 'Filter…'; }
      renderWaypoints();
      return;
    }
    const head = ev.target.closest('.gi-cat');
    if (head) {
      const g = head.parentElement, c = g.dataset.giCat;
      const open = !g.classList.contains('open');
      g.classList.toggle('open', open);
      if (open) giShut.delete(c); else giShut.add(c);
      store.set('jdt:gi-shut', [...giShut]);
      return;
    }
    const row = ev.target.closest('[data-gi]');
    if (!row) return;
    const e = gtaInteriors[Number(row.dataset.gi)];
    if (!e) return;
    if (ev.target.closest('[data-gi-copy]')) { copyCoords(fmt(e.x), fmt(e.y), fmt(e.z), 0, ev.target.closest('button'), 'vec3'); return; }
    if (ev.target.closest('[data-gi-save]')) {
      const w = cleanWp({ name: e.name, x: e.x, y: e.y, z: e.z, h: 0, intId: '', roomName: e.cat, ts: Date.now() });
      if (w) { waypoints.unshift(w); persistWaypoints(); toast('success', 'Location saved', e.name); }
      return;
    }
    const go = ev.target.closest('[data-gi-go]');
    if (go) {
      if (go.disabled) return;
      go.disabled = true; go.textContent = 'Loading…'; row.classList.add('wp-teleporting');
      const r = await nui('interior:goto', { x: e.x, y: e.y, z: e.z, h: 0, ipls: e.ipls || [] });
      go.disabled = false; go.textContent = 'Teleport'; row.classList.remove('wp-teleporting');
      if (!r || !r.ok) toast('error', 'Teleport failed', (r && r.error) || 'Restart jdt so the game loads the latest files.');
      else toast('success', e.name, r.loaded ? `Loaded ${r.loaded} IPL${r.loaded === 1 ? '' : 's'}` : (r.interior ? 'Interior ready' : 'Teleported'));
    }
  });

  function teleportTo(id) {
    const wp = waypoints.find((w) => w.id === id);
    if (!wp) return;
    const card = document.querySelector(`.wp-card[data-id="${CSS.escape(id)}"]`);
    if (card) { card.classList.add('wp-teleporting'); setTimeout(() => card.classList.remove('wp-teleporting'), 600); }
    nuiPost('teleportTo', { x: wp.x, y: wp.y, z: wp.z, h: wp.h });
  }
  function copyStr(txt, btnEl, label) {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (btnEl) {
        const orig = label || btnEl.textContent;
        btnEl.textContent = '✓';
        clearTimeout(btnEl._copyTimer);
        btnEl._copyTimer = setTimeout(() => { btnEl.textContent = orig; }, 1300);
      }
    } catch (e) { /* silent */ }
  }
  function copyCoords(x, y, z, h, btnEl, fmtKind) {
    const f = fmtKind || 'xyz';
    const txt = f === 'vec4' ? `vector4(${x}, ${y}, ${z}, ${h})` : f === 'vec3' ? `vector3(${x}, ${y}, ${z})` : `${x}, ${y}, ${z}`;
    copyStr(txt, btnEl);
  }
  function startRename(id, el) {
    const wp = waypoints.find((w) => w.id === id);
    if (!wp) return;
    const input = document.createElement('input');
    input.type = 'text'; input.value = wp.name; input.className = 'wp-rename-input'; input.spellcheck = false; input.maxLength = 48;
    el.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = () => { if (done) return; done = true; const v = input.value.trim(); if (v) { wp.name = v; persistWaypoints(); } renderWaypoints(); };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done = true; renderWaypoints(); }
    });
  }
  function renderCoordsStatus() {
    const p = MX.playerPos;
    const el = qid('coords-live');
    if (!p || !el) return;
    const roomCtx = MX.currentRoomName || (MX.intId === 'OUTSIDE' ? 'Outside' : '—');
    if (!_coordsBuilt || !qid('clive-x')) {
      el.innerHTML = `
        <div class="coords-live-row">
          <div class="coords-axis-group">
            <span class="cag-pair"><span class="cag-axis">X</span><span class="cag-val" id="clive-x">${fmt(p.x)}</span></span>
            <span class="cag-pair"><span class="cag-axis">Y</span><span class="cag-val" id="clive-y">${fmt(p.y)}</span></span>
            <span class="cag-pair"><span class="cag-axis">Z</span><span class="cag-val" id="clive-z">${fmt(p.z)}</span></span>
            <span class="cag-pair"><span class="cag-axis">H</span><span class="cag-val" id="clive-h">${fmt(p.h, 1)}</span></span>
          </div>
          <div style="display:flex;gap:5px;align-items:center">
            <button class="coords-copy-btn" onclick="copyLive('xyz',this)">Copy</button>
            <button class="coords-copy-btn" onclick="copyLive('vec3',this)">vec3</button>
            <button class="coords-copy-btn" onclick="copyLive('vec4',this)">vec4</button>
            <span class="coords-ctx-pill" id="coords-ctx-pill">${esc(roomCtx)}</span>
          </div>
        </div>`;
      _coordsBuilt = true;
      return;
    }
    qid('clive-x').textContent = fmt(p.x);
    qid('clive-y').textContent = fmt(p.y);
    qid('clive-z').textContent = fmt(p.z);
    qid('clive-h').textContent = fmt(p.h, 1);
    const pill = qid('coords-ctx-pill');
    if (pill) pill.textContent = roomCtx;
  }
  function copyLive(kind, btn) {
    const p = MX.playerPos;
    copyCoords(fmt(p.x), fmt(p.y), fmt(p.z), fmt(p.h, 1), btn, kind);
  }
  function renderWaypoints() {
    const list = qid('wp-list');
    if (!list) return;
    const wc = qid('wp-count');
    if (wc) wc.textContent = waypoints.length ? `${waypoints.length}` : '';
    const gc = qid('gi-count');
    if (gc) gc.textContent = gtaInteriors.length ? `${gtaInteriors.length}` : '';
    if (wpMode === 'gta') return renderGtaInteriors(list);
    const q = ((qid('wp-filter') && qid('wp-filter').value) || '').trim().toLowerCase();
    const shown = waypoints.filter((w) => !q || w.name.toLowerCase().includes(q) || w.roomName.toLowerCase().includes(q));
    if (!shown.length) {
      list.innerHTML = waypoints.length ? '<div class="mx-empty">No matches</div>'
        : `<div class="mx-empty"><strong>No saved locations yet.</strong><br>Walk to a spot and press <strong>Save location</strong>. They stay saved between sessions.</div>`;
      return;
    }
    list.innerHTML = shown.map((wp) => {
      const roomLabelTxt = wp.roomName || (wp.intId === 'OUTSIDE' || !wp.intId ? 'Outside' : '—');
      const d = new Date(wp.ts);
      const time = d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
      const id = esc(wp.id);
      return `<div class="wp-card" data-id="${id}">
        <div class="wp-card-top">
          <span class="wp-name" ondblclick="startRename('${id}',this)" title="Double-click to rename">${esc(wp.name)}</span>
          <div class="wp-meta"><span class="wp-ctx">${esc(roomLabelTxt)}</span><span class="wp-time">${esc(time)}</span></div>
        </div>
        <div class="wp-card-bot">
          <div class="wp-coords-row">
            <span class="wc-pair"><span class="wc-axis">X</span><span class="wc-val">${wp.x}</span></span>
            <span class="wc-pair"><span class="wc-axis">Y</span><span class="wc-val">${wp.y}</span></span>
            <span class="wc-pair"><span class="wc-axis">Z</span><span class="wc-val">${wp.z}</span></span>
            <span class="wc-pair"><span class="wc-axis">H</span><span class="wc-val">${wp.h}</span></span>
          </div>
          <div class="wp-actions">
            ${S.ui.allowTeleport !== false ? `<button class="wp-btn wp-btn-tp" onclick="teleportTo('${id}')">Teleport</button>` : ''}
            <button class="wp-btn wp-btn-copy" onclick="copyCoords('${wp.x}','${wp.y}','${wp.z}','${wp.h}',this,'vec4')">Copy</button>
            <button class="wp-btn wp-btn-del" onclick="deleteWaypoint('${id}')">✕</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }
  function exportWaypoints() {
    modal(`<h2>Export locations</h2><textarea id="export-text" class="mono" rows="16" readonly spellcheck="false">${esc(JSON.stringify(waypoints, null, 2))}</textarea>
      <div class="row end"><button class="btn ghost" data-close-modal>Close</button><button class="btn primary" data-copy-export>Copy</button></div>`);
  }
  function importWaypoints() {
    modal(`<h2>Import locations</h2><p class="muted small">Paste a JSON list exported from JDT.</p>
      <textarea id="wp-import-text" class="mono" rows="12" spellcheck="false"></textarea>
      <div class="row end"><button class="btn ghost" data-close-modal>Cancel</button><button class="btn primary" data-modal-ok>Import</button></div>`,
    (card) => {
      let data;
      try { data = JSON.parse($('#wp-import-text', card).value || '[]'); } catch (e) { return toast('error', 'That is not valid JSON'); }
      const ids = new Set(waypoints.map((w) => w.id));
      const add = arr(data).map(cleanWp).filter((w) => w && !ids.has(w.id));
      waypoints = [...add, ...waypoints];
      persistWaypoints();
      toast('success', `${add.length} locations imported`);
      renderWaypoints();
    });
  }

  /* ================================================================= GRAPH */
  /* Room graph: force or floor-plan layout, wheel zoom around the cursor, drag to pan, drag nodes to
     pin them, hover to trace a room's portals, click an edge to edit that portal's flags. */

  /* Floor plan
     Rooms snap into a grid, placed where their doorways are in the building (portal corners are exact;
     GTA's room boxes are often missing or wrong, so they are only a fallback). One room or two hundred:
     every room gets its own cell, nothing overlaps, and the view fits itself to whatever is there.
     One plain line per pair of connected rooms (a number when they share several portals, yellow when
     one-way, no arrowheads). Limbo is not drawn: a room that leads outside gets a green "exit" tab,
     a room with stairs to another floor a "↕" badge, broken portals a red one. */
  const GW = 640, GH = 400;
  const CW = 104, CH = 66, BW = 78, BH = 40;          // grid cell and room box (layout units)
  var _graphLayout = null, _graphStructKey = null, _graphFullKey = null;
  var _gView = { x: 0, y: 0, k: 1 };
  var _gHover = null;
  var _gFloors = null;      // frames, one per level (only when there is more than one)
  var _gInfo = null;        // per room: exits / stairs / broken / mirrors (portal lists)
  const G_COL = { edge: '#8fb3dc', oneway: '#ffd166', bad: '#ff5e62', exit: '#58c98b', stairs: '#b18cff', node: '#1d1d1b', nodeLine: '#3c3c37', ink: '#e4e2d9', sub: '#8a887f' };

  VIEWS.graph = () => `
    <div class="graph-head">
      <div class="graph-legend">
        <span class="gleg-item"><span class="gleg-dot" style="background:var(--accent);border-color:var(--accent)"></span>You are here</span>
        <span class="gleg-item"><span class="gleg-line" style="background:${G_COL.edge}"></span>Connected</span>
        <span class="gleg-item"><span class="gleg-line" style="background:${G_COL.oneway}"></span>One-way</span>
        <span class="gleg-item"><span class="gleg-line" style="background:${G_COL.exit}"></span>Exit to limbo</span>
        <span class="gleg-item"><span class="gleg-badge" style="color:${G_COL.stairs}">↕</span>Other floor</span>
        <span class="gleg-item"><span class="gleg-badge" style="color:${G_COL.bad}">!</span>Broken</span>
        <span class="gleg-item"><span class="gleg-dot" style="border-style:dashed;border-color:${G_COL.bad}"></span>No portals</span>
      </div>
      <div id="graph-stats" class="graph-stats-bar" style="margin-left:auto"></div>
    </div>
    <div class="graph-wrap" id="graph-wrap">
      <div class="graph-tools">
        <button onclick="graphZoom(1.25)" title="Zoom in">+</button>
        <button onclick="graphZoom(0.8)" title="Zoom out">−</button>
        <button onclick="graphResetLayout()" title="Reset layout: unpin every room you moved"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.5v3h3"/></svg></button>
        <button onclick="graphFit()" title="Fit to view"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg></button>
      </div>
      <svg id="graph-svg" width="100%" height="100%" viewBox="0 0 ${GW} ${GH}" preserveAspectRatio="xMidYMid meet"></svg>
      <div class="graph-zoom" id="graph-zoom">100%</div>
      <div id="graph-tooltip" class="graph-tooltip"></div>
      <div id="edge-tip" class="edge-tip" hidden></div>
    </div>`;

  function analyzeGraph(rooms, portals) {
    const roomIds = new Set(rooms.map((r) => r.id));
    const connected = new Set();
    portals.forEach((p) => { connected.add(p.roomFrom); connected.add(p.roomTo); });
    const orphans = new Set(rooms.filter((r) => !connected.has(r.id)).map((r) => r.id));
    const broken = new Set(), selfLoop = new Set();
    portals.forEach((p) => {
      if (!roomIds.has(p.roomFrom) || !roomIds.has(p.roomTo)) broken.add(p.id);
      if (p.roomFrom === p.roomTo) selfLoop.add(p.id);
    });
    return { orphans, broken, selfLoop };
  }

  // Which floor is each room on? Most reliable signal first:
  //  1. a floor token in the name (V_Michael_G_Kitchen, ..._1_Bedroom, B_, L2_, upper ...)
  //  2. the height of the room's portals (doors sit on the floor they lead from)
  //  3. the bottom of the room's box
  const FLOOR_TOKEN = /^(b\d?|basement|lg|g|gf|ground|ug|uf|upper|top|roof|[lf]?\d{1,2})(?=[_\- ]|$)/i;
  function floorLevel(tok) {
    const t = tok.toLowerCase();
    if (t === 'basement' || t === 'lg') return -1;
    if (/^b\d?$/.test(t)) return -(+(t.slice(1) || 1));
    if (t === 'g' || t === 'gf' || t === 'ground') return 0;
    if (t === 'ug' || t === 'uf' || t === 'upper') return 1;
    if (t === 'top' || t === 'roof') return 9;
    return +t.replace(/^[lf]/, '');
  }
  const LEVEL_NAME = (n) => (n === 0 ? 'Ground floor' : n < 0 ? (n === -1 ? 'Basement' : `Basement ${-n}`) : n === 9 ? 'Top floor' : `Floor ${n}`);
  function floorGroups(real, portals) {
    const median = (v) => { const q = [...v].sort((x, y) => x - y); return q.length ? q[Math.floor(q.length / 2)] : null; };
    const pz = {};
    portals.forEach((p) => {
      const cs = p.corners || [];
      if (!cs.length) return;
      const z = cs.reduce((t, c) => t + c.z, 0) / cs.length;
      [p.roomFrom, p.roomTo].forEach((r) => { (pz[r] = pz[r] || []).push(z); });
    });
    const heightOf = (e) => (pz[e.r.id] ? median(pz[e.r.id]) : Math.min(e.r.bbMin.z, e.r.bbMax.z));
    // 1. names
    const prefix = roomNamePrefix(real.map((e) => e.r.name));
    const tagged = real.map((e) => { const m = shortRoom(e.r.name, prefix).match(FLOOR_TOKEN); return { e, lv: m ? floorLevel(m[1]) : null }; });
    const levels = [...new Set(tagged.filter((x) => x.lv !== null).map((x) => x.lv))];
    if (levels.length >= 2 && tagged.filter((x) => x.lv !== null).length >= real.length * 0.7) {
      const groups = new Map(levels.sort((x, y) => x - y).map((lv) => [lv, { list: [], label: LEVEL_NAME(lv), hs: [] }]));
      tagged.forEach((x) => { if (x.lv !== null) { groups.get(x.lv).list.push(x.e); groups.get(x.lv).hs.push(heightOf(x.e)); } });
      const gl = [...groups.values()];
      gl.forEach((g) => { g.z = median(g.hs); g.named = true; });
      // rooms without a token join the floor with the closest height
      tagged.filter((x) => x.lv === null).forEach((x) => {
        const h = heightOf(x.e);
        gl.reduce((best, g) => (Math.abs(g.z - h) < Math.abs(best.z - h) ? g : best)).list.push(x.e);
      });
      return gl;
    }
    // 2./3. heights: split where consecutive rooms are more than 2.2 m apart
    const byH = real.map((e) => ({ e, h: heightOf(e) })).sort((x, y) => x.h - y.h);
    const out = [];
    byH.forEach((x) => {
      const last = out[out.length - 1];
      if (last && x.h - last.top <= 2.2) { last.list.push(x.e); last.top = x.h; } else out.push({ list: [x.e], z: x.h, top: x.h });
    });
    out.forEach((f, i) => { f.label = out.length > 1 ? `Level ${i + 1}` : ''; });
    return out;
  }


  // where a room is: the average of its portals' centres, else the centre of its GTA box, else unknown
  function roomAnchors(rooms, portals) {
    const acc = {};
    portals.forEach((p) => {
      const cs = p.corners || [];
      if (cs.length < 3 || p.roomFrom === p.roomTo) return;
      const x = cs.reduce((t, c) => t + c.x, 0) / cs.length, y = cs.reduce((t, c) => t + c.y, 0) / cs.length;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      [p.roomFrom, p.roomTo].forEach((r) => { const a = (acc[r] = acc[r] || { x: 0, y: 0, n: 0 }); a.x += x; a.y += y; a.n++; });
    });
    const out = new Map();
    rooms.forEach((r) => {
      const a = acc[r.id];
      if (a) { out.set(r.id, { x: a.x / a.n, y: a.y / a.n }); return; }
      const b0 = r.bbMin, b1 = r.bbMax;
      if (b0 && b1 && [b0.x, b0.y, b1.x, b1.y].every(Number.isFinite) && Math.abs(b1.x - b0.x) + Math.abs(b1.y - b0.y) > 0.05) {
        out.set(r.id, { x: (b0.x + b1.x) / 2, y: (b0.y + b1.y) / 2 });
      }
    });
    return out;
  }

  // Snap one floor's rooms to grid cells: each room takes the free cell nearest to where it really is
  // (best-connected rooms choose first), rooms without a position go next to the rooms they connect to,
  // then empty rows and columns are dropped. Returns { id -> [col, row] }, cols, rows.
  function gridFloor(list, anchors, adj) {
    const n = list.length;
    if (n === 1) return { cells: new Map([[list[0].id, [0, 0]]]), cols: 1, rows: 1 };
    const known = list.filter((r) => anchors.has(r.id));
    let x0 = 0, x1 = 1, y0 = 0, y1 = 1;
    if (known.length) {
      x0 = Math.min(...known.map((r) => anchors.get(r.id).x)); x1 = Math.max(...known.map((r) => anchors.get(r.id).x));
      y0 = Math.min(...known.map((r) => anchors.get(r.id).y)); y1 = Math.max(...known.map((r) => anchors.get(r.id).y));
    }
    const w = Math.max(x1 - x0, 0.5), h = Math.max(y1 - y0, 0.5);
    const aspect = Math.max(0.5, Math.min(3, ((w / h) * (CH / CW)) * 1.0 + 0.4));
    let cols = Math.max(1, Math.round(Math.sqrt(n * aspect))), rows = Math.max(1, Math.ceil(n / cols));
    if (n > 2) { cols += 1; rows += 1; }                          // some slack, so rooms can keep their shape
    const ideal = (r) => { const a = anchors.get(r.id); return [(a.x - x0) / w * (cols - 1), (y1 - a.y) / h * (rows - 1)]; };
    const taken = new Map(), cells = new Map();
    const take = (r, gx, gy) => {
      let best = null, bd = Infinity;
      for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
        if (taken.has(cx + ',' + cy)) continue;
        const d = (cx - gx) ** 2 + (cy - gy) ** 2 * 1.15;
        if (d < bd) { bd = d; best = [cx, cy]; }
      }
      if (!best) { best = [cols, 0]; cols++; }                   // never happens with the slack, but stay safe
      taken.set(best[0] + ',' + best[1], r.id); cells.set(r.id, best);
    };
    const deg = (r) => (adj.get(r.id) || new Set()).size;
    known.slice().sort((a, b) => deg(b) - deg(a) || a.id - b.id).forEach((r) => { const [gx, gy] = ideal(r); take(r, gx, gy); });
    list.filter((r) => !anchors.has(r.id)).sort((a, b) => deg(b) - deg(a) || a.id - b.id).forEach((r) => {
      const nb = [...(adj.get(r.id) || [])].map((id) => cells.get(id)).filter(Boolean);
      const gx = nb.length ? nb.reduce((t, c) => t + c[0], 0) / nb.length : (cols - 1) / 2;
      const gy = nb.length ? nb.reduce((t, c) => t + c[1], 0) / nb.length : (rows - 1) / 2;
      take(r, gx, gy);
    });
    // drop empty columns / rows
    const usedC = [...new Set([...cells.values()].map((c) => c[0]))].sort((a, b) => a - b);
    const usedR = [...new Set([...cells.values()].map((c) => c[1]))].sort((a, b) => a - b);
    cells.forEach((c, id) => cells.set(id, [usedC.indexOf(c[0]), usedR.indexOf(c[1])]));
    return { cells, cols: usedC.length, rows: usedR.length };
  }

  function planLayout(rooms, portals) {
    const real = rooms.filter((r) => r.id !== 0);                 // limbo (0) is the outside, not a room on the plan
    const ids = new Set(real.map((r) => r.id));
    const adj = new Map(real.map((r) => [r.id, new Set()]));
    portals.forEach((p) => { if (ids.has(p.roomFrom) && ids.has(p.roomTo) && p.roomFrom !== p.roomTo) { adj.get(p.roomFrom).add(p.roomTo); adj.get(p.roomTo).add(p.roomFrom); } });
    const anchors = roomAnchors(real, portals);
    _gFloors = null;
    if (!real.length) return rooms.some((r) => r.id === 0) ? [{ id: 0, floor: -1, limbo: true, x: 0, y: 0 }] : [];
    // floors (name tokens, then heights); rooms without any height info join the first floor
    let floors = floorGroups(real.map((r) => ({ r, b: anchors.get(r.id) || { cx: 0, cy: 0 } })), portals).map((f) => ({ ...f, list: f.list.map((e) => e.r) }));
    if (floors.length > 6) floors = [{ list: real, label: '' }];
    const nodes = [];
    let ox = 0;
    const frames = [];
    floors.forEach((f, fi) => {
      const g = gridFloor(f.list, anchors, adj);
      f.list.forEach((r) => {
        const [c, rw] = g.cells.get(r.id);
        nodes.push({ id: r.id, floor: fi, x: ox + c * CW + CW / 2, y: rw * CH + CH / 2 });
      });
      frames.push({ x: ox - 10, y: -26, w: g.cols * CW + 20, h: g.rows * CH + 36, label: f.label || `Level ${fi + 1}`, z: f.named ? NaN : f.z });
      ox += g.cols * CW + 40;
    });
    if (floors.length > 1) _gFloors = frames;
    // limbo (the outside) sits centred below every floor; exits run to it
    if (rooms.some((r) => r.id === 0)) {
      const xs = nodes.map((n) => n.x), bottom = Math.max(...nodes.map((n) => n.y), 0);
      nodes.push({ id: 0, floor: -1, limbo: true, x: xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0, y: bottom + CH * 1.35 });
    }
    return nodes;
  }

  // per room: exits to limbo, stairs to other floors, broken portals, mirrors - and the aggregated links
  function planInfo(rooms, portals, layout) {
    const nodeMap = new Map(layout.map((n) => [n.id, n]));
    const ids = new Set(rooms.map((r) => r.id));
    const info = new Map(rooms.map((r) => [r.id, { exits: [], stairs: [], broken: [], mirrors: [] }]));
    const links = new Map();
    portals.forEach((p) => {
      const a = p.roomFrom, b = p.roomTo;
      const bad = !ids.has(a) || !ids.has(b);
      if (bad) { [a, b].forEach((r) => { if (info.has(r)) info.get(r).broken.push(p); }); return; }
      if (a === b) { info.get(a).mirrors.push(p); return; }
      if (a === 0 || b === 0) {
        const r = a === 0 ? b : a;
        if (info.has(r)) info.get(r).exits.push(p);
        info.get(0).exits.push(p);
        if (nodeMap.has(0) && nodeMap.has(r)) {
          const key = '0:' + r;
          const l = links.get(key) || { a: 0, b: r, exit: true, list: [] };
          l.list.push(p); links.set(key, l);
        }
        return;
      }
      const A = nodeMap.get(a), B = nodeMap.get(b);
      if (!A || !B) return;
      if (A.floor !== B.floor) { info.get(a).stairs.push(p); info.get(b).stairs.push(p); return; }
      const key = Math.min(a, b) + ':' + Math.max(a, b);
      const l = links.get(key) || { a: Math.min(a, b), b: Math.max(a, b), list: [] };
      l.list.push(p); links.set(key, l);
    });
    return { info, links: [...links.values()] };
  }

  const f1 = (n) => n.toFixed(1);
  function graphDefs() {
    return `<defs><pattern id="gGrid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="rgba(255,255,255,.035)" stroke-width="1"/></pattern></defs>`;
  }

  function buildGraphSVG(rooms, portals, layout, analysis) {
    const nodeMap = new Map(layout.map((nd) => [nd.id, nd]));
    const { orphans } = analysis;
    const curId = MX.currentRoomId;
    const gPrefix = roomNamePrefix(rooms.map((r) => r.name));
    const { info, links } = planInfo(rooms, portals, layout);
    _gInfo = info;
    let edgesSVG = '';
    // limbo grows with the number of rooms that lead outside; their lines land side by side on its top edge
    const L0 = nodeMap.get(0);
    const exitLinks = links.filter((l) => l.exit).sort((p, q) => nodeMap.get(p.b).x - nodeMap.get(q.b).x);
    const xs = layout.filter((n) => !n.limbo).map((n) => n.x);
    const span = xs.length ? Math.max(...xs) - Math.min(...xs) + BW : BW;
    const limboW = Math.max(BW + 20, Math.min(exitLinks.length * 26 + 30, span * 0.8));
    const landing = new Map(exitLinks.map((l, i) => [l, exitLinks.length === 1 ? 0 : -limboW / 2 + 14 + i * ((limboW - 28) / (exitLinks.length - 1))]));
    links.forEach((l) => {
      const A0 = nodeMap.get(l.a), B = nodeMap.get(l.b);
      const A = l.exit && L0 ? { x: L0.x + landing.get(l), y: L0.y - BH / 2 } : A0;
      const oneWay = !l.exit && l.list.every((p) => p.flags & 1);
      const col = l.exit ? G_COL.exit : oneWay ? G_COL.oneway : G_COL.edge;
      const d = `M${f1(A.x)},${f1(A.y)} L${f1(B.x)},${f1(B.y)}`;
      const t = l.exit ? 0.72 : 0.5;
      const mx = A.x + (B.x - A.x) * (1 - t), my = A.y + (B.y - A.y) * (1 - t);
      const count = l.list.length > 1 ? `<g class="g-count" transform="translate(${f1(mx)},${f1(my)})"><rect x="-8" y="-7" width="16" height="14" style="stroke:${col}"/><text text-anchor="middle" dominant-baseline="central" y="0.5" fill="${col}">${l.list.length}</text></g>` : '';
      edgesSVG += `<g class="g-edge${oneWay ? ' ow' : ''}${l.exit ? ' exit' : ''}" data-a="${l.a}" data-b="${l.b}" data-portals="${l.list.map((p) => p.id).join(',')}"><path class="hit" d="${d}"/><path class="vis" d="${d}" style="stroke:${col}"/>${count}</g>`;
    });
    let nodesSVG = '';
    rooms.forEach((r) => {
      const nd = nodeMap.get(r.id);
      if (!nd) return;
      const inf = info.get(r.id) || { exits: [], stairs: [], broken: [], mirrors: [] };
      const isCur = r.id === curId, isOrphan = orphans.has(r.id);
      const fill = isCur ? 'var(--accent)' : G_COL.node;
      const stroke = isCur ? 'var(--accent-2)' : isOrphan ? G_COL.bad : G_COL.nodeLine;
      const dash = isOrphan && !isCur ? ' stroke-dasharray="4 3"' : '';
      const tc = isCur ? '#1a1308' : G_COL.ink, sub = isCur ? 'rgba(26,19,8,.7)' : G_COL.sub;
      let raw = shortRoom(r.name || `room_${r.id}`, gPrefix).replace(/^room_/i, '');
      if (_gFloors) raw = raw.replace(FLOOR_TOKEN, '').replace(/^[_\- ]+/, '') || raw;   // the frame already names the floor
      const label = esc(raw.length > 13 ? raw.slice(0, 12) + '…' : raw);
      const hx = BW / 2, hy = BH / 2;
      // exit tab on the top edge, badges on the bottom edge
      if (nd.limbo) {
        nodesSVG += `<g class="graph-node limbo${isCur ? ' cur' : ''}" data-room="0" transform="translate(${f1(nd.x)},${f1(nd.y)})">
          <rect class="g-box" x="${f1(-limboW / 2)}" y="${-hy}" width="${f1(limboW)}" height="${BH}" style="fill:${isCur ? 'var(--accent)' : '#141a16'};stroke:${G_COL.exit}" stroke-width="1.4" stroke-dasharray="5 3"/>
          <text y="-4" text-anchor="middle" dominant-baseline="middle" font-size="10.5" font-weight="600" font-family="Archivo,sans-serif" fill="${isCur ? '#1a1308' : G_COL.exit}" pointer-events="none">limbo · outside</text>
          <text y="9" text-anchor="middle" dominant-baseline="middle" font-size="8" font-family="IBM Plex Mono,monospace" fill="${sub}" pointer-events="none">#0 · ${inf.exits.length} exit${inf.exits.length === 1 ? '' : 's'}</text>
        </g>`;
        return;
      }
      const badges = [];
      if (inf.stairs.length) badges.push([G_COL.stairs, '↕' + (inf.stairs.length > 1 ? inf.stairs.length : '')]);
      if (inf.broken.length) badges.push([G_COL.bad, '!' + (inf.broken.length > 1 ? inf.broken.length : '')]);
      const badgeSVG = badges.map(([c, t], i) => `<g class="g-badge" transform="translate(${hx - 14 - i * 28},${hy})"><rect x="-12" y="-8" width="24" height="16" style="stroke:${c}"/><text text-anchor="middle" dominant-baseline="central" fill="${c}">${t}</text></g>`).join('');
      nodesSVG += `<g class="graph-node${nd.pinned ? ' pinned' : ''}${isCur ? ' cur' : ''}" data-room="${r.id}" transform="translate(${f1(nd.x)},${f1(nd.y)})">
        ${isCur ? `<rect class="g-ring" x="${-hx - 5}" y="${-hy - 5}" width="${BW + 10}" height="${BH + 10}" fill="none" style="stroke:var(--accent)" stroke-opacity=".35" stroke-width="1"/>` : ''}
        <rect class="g-box" x="${-hx}" y="${-hy}" width="${BW}" height="${BH}" style="fill:${fill};stroke:${stroke}" stroke-width="1.4"${dash}/>
        <text y="-4" text-anchor="middle" dominant-baseline="middle" font-size="10.5" font-weight="600" font-family="Archivo,sans-serif" fill="${tc}" pointer-events="none">${label}</text>
        <text y="9" text-anchor="middle" dominant-baseline="middle" font-size="8" font-family="IBM Plex Mono,monospace" fill="${sub}" pointer-events="none">#${r.id}</text>
        ${badgeSVG}
        ${nd.pinned ? `<rect x="${hx - 7}" y="${-hy + 3}" width="4" height="4" style="fill:var(--accent)" pointer-events="none"/>` : ''}
      </g>`;
    });
    const floorsSVG = _gFloors ? _gFloors.map((f) => `<rect class="g-floor" x="${f1(f.x)}" y="${f1(f.y)}" width="${f1(f.w)}" height="${f1(f.h)}"/><text class="g-floor-t" x="${f1(f.x + 8)}" y="${f1(f.y + 13)}">${esc(f.label)}${Number.isFinite(f.z) ? `<tspan dx="6">z ${f.z.toFixed(1)}</tspan>` : ''}</text>`).join('') : '';
    return `${graphDefs()}<rect x="-40000" y="-40000" width="80000" height="80000" fill="url(#gGrid)" class="g-bg"/>
      <g id="g-view" transform="translate(${f1(_gView.x)},${f1(_gView.y)}) scale(${_gView.k.toFixed(3)})">${floorsSVG}<g class="g-edges">${edgesSVG}</g><g class="g-nodes">${nodesSVG}</g></g>`;
  }

  function updateGraphStats(rooms, portals, analysis) {
    const bar = qid('graph-stats');
    if (!bar) return;
    const { orphans, broken, selfLoop } = analysis;
    const oneWay = portals.filter((p) => p.flags & 1).length;
    bar.innerHTML = [
      `<span class="gstat-chip"><span class="gstat-val">${rooms.length}</span> rooms</span>`,
      `<span class="gstat-chip"><span class="gstat-val">${portals.length}</span> portals</span>`,
      oneWay ? `<span class="gstat-chip"><span class="gstat-val">${oneWay}</span> one-way</span>` : '',
      orphans.size ? `<span class="gstat-chip gstat-warn"><span class="gstat-val">${orphans.size}</span> without portals</span>` : '',
      broken.size ? `<span class="gstat-chip gstat-err"><span class="gstat-val">${broken.size}</span> broken</span>` : '',
      selfLoop.size ? `<span class="gstat-chip"><span class="gstat-val">${selfLoop.size}</span> self-loop${selfLoop.size > 1 ? 's' : ''}</span>` : '',
      roomNamePrefix(rooms.map((r) => r.name)) ? `<span class="gstat-chip" title="Shared start of every room name, hidden in the labels">names start with <span class="gstat-val">${esc(roomNamePrefix(rooms.map((r) => r.name)))}</span></span>` : '',
    ].filter(Boolean).join('');
  }

  var _graphTipRoom = null;
  function hideGraphTooltip() {
    const tt = qid('graph-tooltip');
    if (tt) tt.classList.remove('visible');
    _graphTipRoom = null;
  }
  function graphNodeClick(roomId) {
    const tt = qid('graph-tooltip');
    if (!tt) return;
    if (_graphTipRoom === roomId && tt.classList.contains('visible')) { hideGraphTooltip(); return; }
    const room = MX.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const ins = MX.portals.filter((p) => p.roomTo === roomId).length;
    const outs = MX.portals.filter((p) => p.roomFrom === roomId).length;
    const nd = _graphLayout && _graphLayout.find((n) => n.id === roomId);
    tt.innerHTML = `
      <button class="gtt-close" onclick="event.stopPropagation();hideGraphTooltip()" title="Close">✕</button>
      <div class="gtt-name">${esc(room.name)}</div>
      <div class="gtt-row"><span class="gtt-k">Room id</span><span class="gtt-v">#${room.id}</span></div>
      <div class="gtt-row"><span class="gtt-k">Flags</span><span class="gtt-v">${esc(ROOM_FLAGS.filter((f) => room.flag & f.bit).map((f) => f.name).join(', ') || 'None')}</span></div>
      <div class="gtt-row"><span class="gtt-k">Portals in / out</span><span class="gtt-v">${ins} / ${outs}</span></div>
      ${room.tcName && room.tcName !== 'none' ? `<div class="gtt-row"><span class="gtt-k">Timecycle</span><span class="gtt-v">${esc(room.tcName)}</span></div>` : ''}
      ${(() => {
        const inf = _gInfo && _gInfo.get(roomId);
        if (!inf) return '';
        const btns = (list) => list.map((p) => `<button class="gtt-pbtn" onclick="event.stopPropagation();openFlagModal(${p.id},${p.flags >>> 0})">#${p.id}</button>`).join('');
        return [['Exits to outside', inf.exits], ['Stairs / other floor', inf.stairs], ['Broken portals', inf.broken], ['Mirrors', inf.mirrors]]
          .filter(([, l]) => l.length).map(([k, l]) => `<div class="gtt-row gtt-plist"><span class="gtt-k">${k}</span><span class="gtt-v">${btns(l)}</span></div>`).join('');
      })()}
      ${!ins && !outs ? '<div class="gtt-warn">No portal leads into this room</div>' : ''}
      <div style="display:flex;gap:5px;margin-top:10px">
        <button class="pflag-edit" onclick="event.stopPropagation();openRoomModal(${room.id})">Edit flags</button>
        ${nd && nd.pinned ? `<button class="pflag-edit" onclick="event.stopPropagation();graphUnpin(${room.id})">Unpin</button>` : ''}
      </div>`;
    _graphTipRoom = roomId;
    tt.classList.add('visible');
  }
  // pinned rooms are remembered per interior and per view (Graph / Plan)
  const pinKey = () => `jdt:graph:pins:${MX.nameHash >>> 0}:${MX.roomCount}:plan3`;
  function savePins() {
    if (!_graphLayout) return;
    const pins = {};
    _graphLayout.forEach((n) => { if (n.pinned) pins[n.id] = [Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10]; });
    store.set(pinKey(), pins);
  }
  function graphResetLayout() {
    store.set(pinKey(), {});
    _graphLayout = null; _graphFullKey = null; _graphStructKey = null;
    hideGraphTooltip();
    renderGraph();
    graphFit();
    toast('success', 'Layout reset', 'Every room is back where JDT puts it.');
  }
  function graphUnpin(roomId) {
    const nd = _graphLayout && _graphLayout.find((n) => n.id === roomId);
    if (!nd) return;
    const fresh = planLayout(MX.rooms, MX.portals).find((n) => n.id === roomId);
    if (fresh) { nd.x = fresh.x; nd.y = fresh.y; }
    nd.pinned = false;
    savePins();
    hideGraphTooltip();
    redrawGraph();
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('#graph-wrap') || e.target.closest('.modal-wrap')) return;   // the graph handles its own clicks
    hideGraphTooltip();
  });

  function setGraphView() {
    const g = document.getElementById('g-view');
    if (g) g.setAttribute('transform', `translate(${f1(_gView.x)},${f1(_gView.y)}) scale(${_gView.k.toFixed(3)})`);
    const z = qid('graph-zoom');
    if (z) z.textContent = `${Math.round(_gView.k * 100)}%`;
  }
  function graphZoom(f, cx = GW / 2, cy = GH / 2) {
    const k = Math.max(0.12, Math.min(4, _gView.k * f));
    const r = k / _gView.k;
    _gView.x = cx - (cx - _gView.x) * r;
    _gView.y = cy - (cy - _gView.y) * r;
    _gView.k = k;
    setGraphView();
  }
  // fit every room (and floor frame) into the view: one room is shown at a comfortable size, two hundred shrink to fit
  function graphFit() {
    const L = _graphLayout || [];
    if (!L.length) { _gView = { x: 0, y: 0, k: 1 }; setGraphView(); return; }
    let x0 = Math.min(...L.map((n) => n.x)) - BW / 2 - 8, x1 = Math.max(...L.map((n) => n.x)) + BW / 2 + 8;
    let y0 = Math.min(...L.map((n) => n.y)) - BH / 2 - 14, y1 = Math.max(...L.map((n) => n.y)) + BH / 2 + 10;
    (_gFloors || []).forEach((f) => { x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y); x1 = Math.max(x1, f.x + f.w); y1 = Math.max(y1, f.y + f.h); });
    const pad = 22;
    const k = Math.max(0.12, Math.min(1.45, (GW - pad * 2) / (x1 - x0), (GH - pad * 2) / (y1 - y0)));
    _gView = { k, x: GW / 2 - ((x0 + x1) / 2) * k, y: GH / 2 - ((y0 + y1) / 2) * k };
    setGraphView();
  }

  // client point -> graph coordinates (before / after the pan-zoom transform)
  function svgPoint(svg, ev) {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  function setHover(roomId) {
    if (_gHover === roomId) return;
    _gHover = roomId;
    const svg = qid('graph-svg');
    if (!svg) return;
    svg.classList.toggle('g-dim', roomId !== null);
    svg.querySelectorAll('.nb').forEach((el) => el.classList.remove('nb'));
    if (roomId === null) return;
    svg.querySelectorAll('.g-edge').forEach((e) => {
      const a = +e.dataset.a, b = +e.dataset.b;
      if (a === roomId || b === roomId) {
        e.classList.add('nb');
        svg.querySelectorAll(`.graph-node[data-room="${a}"], .graph-node[data-room="${b}"]`).forEach((n) => n.classList.add('nb'));
      }
    });
    const self = svg.querySelector(`.graph-node[data-room="${roomId}"]`);
    if (self) self.classList.add('nb');
  }

  // the portals behind one line: hover shows them, a click on a shared line lists them to pick one
  function edgeTipHTML(edge, pick) {
    const rn = (id) => { const r = MX.rooms.find((x) => x.id === id); return r ? esc(shortRoom(r.name, roomNamePrefix(MX.rooms.map((q) => q.name)))) : `#${id}?`; };
    const ids = edge.dataset.portals.split(',').map(Number);
    const rows = ids.map((id) => MX.portals.find((x) => x.id === id)).filter(Boolean).map((pr) => {
      const names = PORTAL_FLAGS.filter((f) => pr.flags & f.bit).map((f) => f.name).join(', ');
      const inner = `<b>#${pr.id}</b>${rn(pr.roomFrom)} – ${rn(pr.roomTo)}${names ? `<span class="et-flags">${esc(names)}</span>` : ''}`;
      return pick ? `<button class="et-row" onclick="event.stopPropagation();openFlagModal(${pr.id},${pr.flags >>> 0});this.closest('.edge-tip').hidden=true;this.closest('.edge-tip').classList.remove('pinned')">${inner}</button>` : `<div class="et-row">${inner}</div>`;
    });
    return (pick ? '<div class="et-head">Pick a portal to edit</div>' : (ids.length > 1 ? `<div class="et-head">${ids.length} portals · click to pick one</div>` : '')) + rows.join('');
  }

  function wireGraph(svg) {
    if (svg._wired) return;
    svg._wired = true;
    const wrap = qid('graph-wrap');
    let drag = null;   // { kind: 'pan' | 'node', start, orig, id, moved }

    svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = svgPoint(svg, ev);
      graphZoom(ev.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
    }, { passive: false });

    svg.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const node = ev.target.closest('.graph-node');
      const p = svgPoint(svg, ev);
      if (node) {
        const id = +node.dataset.room;
        const nd = _graphLayout && _graphLayout.find((n) => n.id === id);
        if (!nd) return;
        drag = { kind: 'node', start: p, orig: { x: nd.x, y: nd.y }, id, nd, el: node, moved: false };
      } else if (!ev.target.closest('.g-edge')) {
        drag = { kind: 'pan', start: p, orig: { x: _gView.x, y: _gView.y }, moved: false };
      } else return;
      svg.setPointerCapture(ev.pointerId);
    });

    svg.addEventListener('pointermove', (ev) => {
      const p = svgPoint(svg, ev);
      if (drag) {
        const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        if (!drag.moved) { drag.moved = true; hideGraphTooltip(); setHover(null); if (wrap) wrap.classList.add('panning'); }
        if (drag.kind === 'pan') {
          _gView.x = drag.orig.x + dx; _gView.y = drag.orig.y + dy;
          setGraphView();
        } else {
          drag.nd.x = drag.orig.x + dx / _gView.k; drag.nd.y = drag.orig.y + dy / _gView.k;
          drag.nd.pinned = true;
          drag.el.classList.add('dragging');
          if (!drag.raf) drag.raf = requestAnimationFrame(() => { if (drag) drag.raf = 0; redrawGraph(); });
        }
        return;
      }
      const node = ev.target.closest('.graph-node');
      setHover(node ? +node.dataset.room : null);
      const edge = ev.target.closest('.g-edge');
      const tip = qid('edge-tip');
      if (tip) {
        if (tip.classList.contains('pinned')) { /* a clicked list stays put */ }
        else if (edge && wrap) {
          tip.innerHTML = edgeTipHTML(edge, false);
          const wr = wrap.getBoundingClientRect();
          tip.style.left = `${Math.min(ev.clientX - wr.left + 12, wr.width - tip.offsetWidth - 8)}px`;
          tip.style.top = `${ev.clientY - wr.top + 14}px`;
          tip.hidden = false;
        } else tip.hidden = true;
      }
    });

    const end = (ev) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (wrap) wrap.classList.remove('panning');
      if (d.raf) cancelAnimationFrame(d.raf);
      if (d.kind === 'node') {
        if (d.moved) { redrawGraph(); savePins(); }
        else graphNodeClick(d.id);
      } else if (!d.moved) hideGraphTooltip();   // a plain click on empty space closes the room card
      try { svg.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', () => { if (!drag) { setHover(null); const tip = qid('edge-tip'); if (tip && !tip.classList.contains('pinned')) tip.hidden = true; } });
    svg.addEventListener('click', (ev) => {
      const tip = qid('edge-tip');
      const edge = ev.target.closest('.g-edge');
      if (tip) tip.classList.remove('pinned');
      if (!edge) { if (tip) tip.hidden = true; return; }
      const ids = edge.dataset.portals.split(',').map(Number);
      if (ids.length === 1) { const pr = MX.portals.find((x) => x.id === ids[0]); if (pr) openFlagModal(pr.id, pr.flags >>> 0); return; }
      // several portals between the same two rooms: a small list to pick the one to edit
      if (!tip || !wrap) return;
      tip.innerHTML = edgeTipHTML(edge, true);
      tip.classList.add('pinned');
      const wr = wrap.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = `${Math.max(8, Math.min(ev.clientX - wr.left + 12, wr.width - tip.offsetWidth - 8))}px`;
      tip.style.top = `${Math.min(ev.clientY - wr.top + 14, wr.height - tip.offsetHeight - 8)}px`;
    });
    svg.addEventListener('dblclick', (ev) => { if (!ev.target.closest('.graph-node, .g-edge')) graphFit(); });
  }

  var _graphAnalysis = null;
  function redrawGraph() {
    const svg = qid('graph-svg');
    if (!svg || !_graphLayout) return;
    const hover = _gHover;
    svg.innerHTML = buildGraphSVG(MX.rooms, MX.portals, _graphLayout, _graphAnalysis || analyzeGraph(MX.rooms, MX.portals));
    _gHover = null;
    if (hover !== null) setHover(hover);
    setGraphView();
  }

  function renderGraph() {
    let fitNext = false;
    const svg = qid('graph-svg');
    if (!svg) return;
    wireGraph(svg);
    const rooms = MX.rooms, portals = MX.portals;
    const structKey = MX.intId + '§' + rooms.map((r) => `${r.id}:${r.name}:${r.bbMin.x},${r.bbMin.y},${r.bbMax.x},${r.bbMax.y}`).join('|') + '§' + portals.map((p) => `${p.id}:${p.flags}:${p.roomFrom}:${p.roomTo}`).join('|');
    const fullKey = structKey + '§' + MX.currentRoomId;
    if (fullKey === _graphFullKey && svg.childNodes.length) return;
    _graphFullKey = fullKey;
    if (!rooms.length) {
      svg.innerHTML = `${graphDefs()}<rect x="0" y="0" width="${GW}" height="${GH}" fill="url(#gGrid)"/><text x="${GW / 2}" y="${GH / 2}" text-anchor="middle" dominant-baseline="middle" font-size="13" font-family="Archivo,sans-serif" fill="#71727c">Walk into an interior to see how its rooms connect</text>`;
      _graphLayout = null;
      updateGraphStats([], [], { orphans: new Set(), broken: new Set(), selfLoop: new Set() });
      return;
    }
    if (structKey !== _graphStructKey || !_graphLayout) {
      // keep the positions of pinned rooms across structural changes (a portal relinked, a flag edited)
      const pinned = new Map((_graphLayout || []).filter((n) => n.pinned).map((n) => [n.id, n]));
      _graphStructKey = structKey;
      _graphLayout = planLayout(rooms, portals);
      const saved = obj(store.get(pinKey(), {}));
      _graphLayout.forEach((n) => {
        const p = pinned.get(n.id), sv = saved[n.id];
        if (p) { n.x = p.x; n.y = p.y; n.pinned = true; }
        else if (Array.isArray(sv)) { n.x = sv[0]; n.y = sv[1]; n.pinned = true; }
      });
      if (!pinned.size) fitNext = true;
    }
    _graphAnalysis = analyzeGraph(rooms, portals);
    redrawGraph();
    updateGraphStats(rooms, portals, _graphAnalysis);
    if (fitNext) graphFit(); else setGraphView();
  }

  /* ============================================================== ENTITIES */

  var entityList = [];
  var entFilter = 'all', entSearch = '', entSort = 'dist', entMode = 'interior', entRadius = 40;
  var _entScanned = false, selectedEntityIdx = null, inspectIdx = null, inspectFlags = 0, entLimit = 200;
  // auto-select ('off' | 'nearest' | 'aim') and live list survive closing the panel
  var entAuto = store.get('jdt:ent:auto', 'off'), entLive = !!store.get('jdt:ent:live', true), entFocus = null, entLiveTimer = 0;

  VIEWS.entities = () => `
    <div class="toggle-row">
      <span class="trow-label">Show the selected object in the world <span class="mx-count">box, axes and a label</span></span>
      <label class="sw"><input type="checkbox" id="chk-ent3d" ${drawEntities3D ? 'checked' : ''} onchange="toggle3DEntities(this.checked)"><span class="sw-track"><span class="sw-thumb"></span></span></label>
    </div>
    <div class="ent-auto">
      <div class="ent-auto-l">
        <span class="ent-sort-label">Select automatically</span>
        <div class="ent-filters">
          ${[['off', 'Off'], ['nearest', 'Nearest to me'], ['aim', 'What I look at']].map(([k, l]) => `<button class="ent-filter-btn${entAuto === k ? ' active' : ''}" data-auto="${k}" onclick="setEntAuto('${k}')">${l}</button>`).join('')}
        </div>
      </div>
      <label class="switch sinline" title="Refresh the list every second while this tab is open"><input type="checkbox" id="ent-live" ${entLive ? 'checked' : ''} onchange="setEntLive(this.checked)"><span>Live list</span></label>
    </div>
    <div id="ent-focus" class="ent-focus">${entFocusHTML()}</div>
    <div class="ent-toolbar">
      <div class="ent-search-wrap"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="9" r="5.5"/><path d="M13.2 13.2L17 17"/></svg>
        <input id="ent-search" class="field-input" type="text" placeholder="Filter by model, hash or room" spellcheck="false" autocomplete="off" value="${esc(entSearch)}" oninput="entSearchInput()"></div>
      <div class="ent-filters">
        <button class="ent-filter-btn${entMode === 'interior' ? ' active' : ''}" onclick="setEntMode('interior')">This interior</button>
        <button class="ent-filter-btn${entMode === 'radius' ? ' active' : ''}" onclick="setEntMode('radius')">Around me</button>
      </div>
      <button class="btn outline sm" onclick="pickAimedEntity()" title="Hold the free-look mouse button, aim at an object, then click">Pick aimed</button>
      <button id="ent-scan-btn" class="btn ${entLive ? 'outline' : 'primary'} sm" onclick="scanEntities()">${entLive ? 'Rescan' : 'Scan'}</button>
    </div>
    ${entMode === 'radius' ? `<div class="ent-toolbar"><span class="ent-sort-label">Radius</span><input type="range" class="dist-range" min="5" max="150" step="5" value="${entRadius}" oninput="setEntRadius(this.value)"><span class="dist-val" id="ent-radius-val">${entRadius}m</span></div>` : ''}
    <div class="ent-toolbar">
      <div class="ent-filters">
        ${[['all', 'All'], ['visible', 'Visible'], ['hidden', 'Hidden'], ['changed', 'Changed'], ['doors', 'Doors']].map(([k, l]) => `<button class="ent-filter-btn${entFilter === k ? ' active' : ''}" onclick="setEntFilter(this,'${k}')">${l}</button>`).join('')}
      </div>
      <span class="ent-sort-label" style="margin-left:6px">Sort</span>
      <div class="ent-filters">
        ${[['dist', 'Distance'], ['name', 'Name'], ['hash', 'Hash'], ['room', 'Room'], ['size', 'Size']].map(([k, l]) => `<button class="ent-sort-btn${entSort === k ? ' active' : ''}" onclick="setEntSort('${k}',this)">${l}</button>`).join('')}
      </div>
      <button class="btn outline sm danger" id="ent-restore-btn" onclick="restoreEntities()" hidden>Restore changed</button>
      <span id="ent-scan-count" class="ent-scan-count"></span>
    </div>
    <div class="mx-scroll" id="ent-dump-list"><div class="mx-empty">Press <strong>Scan</strong> to list every object in this interior, or switch to <strong>Around me</strong>.</div></div>`;

  // Lua entity -> MLOX entity card data
  function mapEnt(e) {
    return {
      idx: e.handle, name: e.name, hashNum: e.hash >>> 0, hash: num32(e.hash), etype: e.etype || 'Object',
      x: fmt(e.x), y: fmt(e.y), z: fmt(e.z), h: fmt(e.h, 1), rx: fmt(e.rx, 1), ry: fmt(e.ry, 1), rz: fmt(e.rz, 1),
      fx: e.x, fy: e.y, fz: e.z, q: arr(e.q),
      visible: !!e.visible, alpha: e.alpha ?? 255, collision: e.collision, lod: e.lod,
      dist: fmt(e.dist, 1), distNum: e.dist, room: e.room, interior: e.interior,
      size: { x: fmt(e.size.x), y: fmt(e.size.y), z: fmt(e.size.z) }, vol: e.size.x * e.size.y * e.size.z,
      modified: !!e.modified, door: !!e.door,
    };
  }
  function entRoomName(e) {
    if (e.room < 0) return e.interior ? '—' : 'Outside';
    const r = MX.intId !== 'OUTSIDE' && e.interior === MX.intId ? MX.rooms.find((x) => x.id === e.room) : null;
    return r ? r.name : `#${e.room}`;
  }
  function updateEnt(raw) {
    if (!raw) return null;
    const e = mapEnt(raw);
    const i = entityList.findIndex((x) => x.idx === e.idx);
    if (i >= 0) entityList[i] = e; else entityList.unshift(e);
    return e;
  }

  function entFocusHTML() {
    if (entAuto === 'off') return '';
    const e = entFocus;
    if (!e) {
      return `<div class="ent-focus-empty"><span class="em-loc-dot"></span>${entAuto === 'aim' ? 'Look at an object; it is picked the moment your crosshair is on it.' : 'Walk around; the object nearest to you is picked automatically.'}</div>`;
    }
    return `<div class="ent-focus-card">
      <span class="em-loc-dot"></span>
      <div class="ent-focus-main"><b>${esc(e.name)}</b><span class="mono">${e.hash}</span><span>${esc(entRoomName(e))}</span></div>
      <div class="ent-focus-pos mono"><span><i>x</i>${e.x}</span><span><i>y</i>${e.y}</span><span><i>z</i>${e.z}</span><span><i>h</i>${e.h}°</span><span class="ent-dist">${e.dist} m</span></div>
      <div class="ent-focus-act">
        <button class="pflag-edit" data-n="${esc(e.name)}" onclick="copyText(this.dataset.n)">Copy name</button>
        <button class="pflag-edit" onclick="quickToggleVis(${e.idx})">${e.visible ? 'Hide' : 'Show'}</button>
        <button class="pflag-edit on" onclick="openEntInspector(${e.idx})">Inspect</button>
      </div></div>`;
  }
  function paintFocus() { const el = qid('ent-focus'); if (el) el.innerHTML = entFocusHTML(); }
  function setEntAuto(mode) {
    entAuto = mode;
    store.set('jdt:ent:auto', mode);
    if (mode === 'off') entFocus = null;
    document.querySelectorAll('[data-auto]').forEach((b) => b.classList.toggle('active', b.dataset.auto === mode));
    nui('ent:auto', { mode, radius: entMode === 'radius' ? entRadius : 25 });
    if (mode !== 'off' && !drawEntities3D) { drawEntities3D = true; const c = qid('chk-ent3d'); if (c) c.checked = true; }
    paintFocus();
  }
  function setEntLive(on) {
    entLive = on;
    store.set('jdt:ent:live', on);
    const btn = qid('ent-scan-btn');
    if (btn) { btn.textContent = on ? 'Rescan' : 'Scan'; btn.classList.toggle('primary', !on); btn.classList.toggle('outline', on); }
    entLiveLoop();
  }
  function entLiveLoop() {
    clearInterval(entLiveTimer);
    entLiveTimer = 0;
    if (!entLive) return;
    entLiveTimer = setInterval(() => {
      if (!S.visible || S.tab !== 'entities' || openModalCount()) return;
      scanEntities(true);
    }, 1200);
  }
  const openModalCount = () => document.querySelectorAll('.modal-wrap.open').length;
  // Lua picked a new object (auto-select): select it in the list and show its card
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.action !== 'entAuto' || !m.data) return;
    const e = updateEnt(m.data);
    if (!e) return;
    entFocus = e;
    selectedEntityIdx = e.idx;
    _entScanned = true;
    if (S.visible && S.tab === 'entities') {
      paintFocus();
      renderEntities();
      const row = document.querySelector('.ent-card.ent-card-selected');
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  });

  async function scanEntities(quiet) {
    const btn = qid('ent-scan-btn');
    if (btn && !quiet) { btn.disabled = true; btn.textContent = 'Scanning…'; }
    const res = await nui('ent:scan', { mode: entMode, radius: entRadius });
    entityList = arr(res && res.list).map(mapEnt);
    if (res && res.mode && res.mode !== entMode) { entMode = res.mode; }
    _entScanned = true;
    entLimit = 200;
    if (selectedEntityIdx !== null && entAuto === 'off' && !entityList.some((e) => e.idx === selectedEntityIdx)) {
      selectedEntityIdx = null;
      nui('ent:select', { handle: 0 });
    }
    if (btn && !quiet) { btn.disabled = false; btn.textContent = entLive ? 'Rescan' : 'Scan'; }
    if (entFocus) { const f = entityList.find((x) => x.idx === entFocus.idx); if (f) { entFocus = f; paintFocus(); } }
    if (S.tab === 'entities') renderEntities();
  }
  function setEntFilter(btn, filter) {
    entFilter = filter;
    document.querySelectorAll('.ent-filter-btn[onclick^="setEntFilter"]').forEach((b) => b.classList.toggle('active', b === btn));
    renderEntities();
  }
  function setEntMode(mode) { entMode = mode; render(); scanEntities(); }
  let radiusTimer = null;
  function setEntRadius(v) {
    entRadius = clamp(parseInt(v, 10) || 40, 5, 150);
    const l = qid('ent-radius-val');
    if (l) l.textContent = `${entRadius}m`;
    clearTimeout(radiusTimer);
    radiusTimer = setTimeout(scanEntities, 250);
  }
  function setEntSort(sort, btn) {
    entSort = sort;
    document.querySelectorAll('.ent-sort-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderEntities();
  }
  let searchTimer = null;
  function entSearchInput() {
    entSearch = ((qid('ent-search') && qid('ent-search').value) || '').trim().toLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { entLimit = 200; renderEntities(); }, 110);
  }
  function toggle3DEntities(state) { drawEntities3D = state; nuiPost('toggleEntities3D', { state }); }
  function selectEntity(idx) {
    selectedEntityIdx = (selectedEntityIdx === idx) ? null : idx;
    nui('ent:select', { handle: selectedEntityIdx || 0 });
    if (selectedEntityIdx !== null && !drawEntities3D) toast('info', 'Selected', 'Turn on "Show the selected object in the world" to see it boxed in game.');
    renderEntities();
  }
  async function pickAimedEntity() {
    const r = await nui('ent:aimed');
    if (!r || !r.entity) return toast('warning', 'Nothing aimed at', 'Hold the free-look mouse button and aim at an object.');
    const e = updateEnt(r.entity);
    _entScanned = true;
    selectedEntityIdx = e.idx;
    nui('ent:select', { handle: e.idx });
    renderEntities();
    openEntInspector(e.idx);
  }
  async function restoreEntities() {
    const r = await nui('ent:restore');
    toast('success', `${(r && r.restored) || 0} objects restored`);
    scanEntities();
  }

  function renderEntities() {
    const list = qid('ent-dump-list');
    if (!list) return;
    const setCount = (txt) => { const el = qid('ent-scan-count'); if (el) el.textContent = txt; };
    const rb = qid('ent-restore-btn');
    if (rb) rb.hidden = !entityList.some((e) => e.modified);
    if (!_entScanned) { list.innerHTML = '<div class="mx-empty">Press <strong>Scan</strong> to detect all objects in the current interior.</div>'; setCount(''); return; }
    if (!entityList.length) { list.innerHTML = `<div class="mx-empty">No objects found${entMode === 'radius' ? ` within ${entRadius} m` : ' in this interior'}.</div>`; setCount('0 objects'); return; }

    const q = entSearch;
    const qHash = /^0x[0-9a-f]+$/i.test(q) ? parseInt(q, 16) >>> 0 : (/^\d+$/.test(q) ? Number(q) >>> 0 : null);
    const rows = entityList.filter((e) => {
      if (entFilter === 'visible' && !e.visible) return false;
      if (entFilter === 'hidden' && e.visible) return false;
      if (entFilter === 'changed' && !e.modified) return false;
      if (entFilter === 'doors' && !e.door) return false;
      if (!q) return true;
      return e.name.toLowerCase().includes(q) || e.hash.toLowerCase().includes(q) || (qHash !== null && e.hashNum === qHash) || entRoomName(e).toLowerCase().includes(q);
    });
    rows.sort((a, b) => {
      if (entSort === 'dist') return a.distNum - b.distNum;
      if (entSort === 'hash') return a.hash.localeCompare(b.hash);
      if (entSort === 'room') return (a.room - b.room) || (a.distNum - b.distNum);
      if (entSort === 'size') return b.vol - a.vol;
      return a.name.localeCompare(b.name);
    });
    const shown = rows.slice(0, entLimit);
    list.innerHTML = shown.map((e) => {
      const sel = e.idx === selectedEntityIdx;
      return `<div class="ent-card${e.visible ? '' : ' ent-card-hidden'}${sel ? ' ent-card-selected' : ''}" onclick="selectEntity(${e.idx})">
        <span class="ent-vis-dot ${e.visible ? 'ent-vis-on' : 'ent-vis-off'}" title="${e.visible ? 'Visible' : 'Hidden'}"></span>
        <div class="ent-main">
          <div class="ent-card-top"><span class="ent-hash">${esc(e.name)}</span>${sel ? '<span class="ent-sel-badge">Selected</span>' : ''}${e.modified ? '<span class="tag-changed">Changed</span>' : ''}</div>
          <div class="ent-sub"><span class="mono">${e.hash}</span><span>${esc(entRoomName(e))}</span>${e.door ? '<span class="ent-type-badge">Door</span>' : ''}${e.etype !== 'Object' ? `<span class="ent-type-badge">${esc(e.etype)}</span>` : ''}${e.alpha < 255 ? `<span class="ent-type-badge">alpha ${e.alpha}</span>` : ''}</div>
        </div>
        <div class="ent-coords" title="Position and heading">
          <span><i>x</i>${e.x}</span><span><i>y</i>${e.y}</span><span><i>z</i>${e.z}</span><span><i>h</i>${e.h}°</span>
          <span class="ent-size"><i>size</i>${e.size.x} × ${e.size.y} × ${e.size.z}</span>
        </div>
        <span class="ent-dist">${e.dist} m</span>
        <div class="ent-actions-row" onclick="event.stopPropagation()">
          <button class="ent-mini-btn" onclick="quickToggleVis(${e.idx})">${e.visible ? 'Hide' : 'Show'}</button>
          <button class="ent-mini-btn primary" onclick="openEntInspector(${e.idx})">Inspect</button>
        </div>
      </div>`;
    }).join('') + (rows.length > entLimit ? `<button class="btn outline sm" style="align-self:center" onclick="moreEntities()">Show ${Math.min(200, rows.length - entLimit)} more</button>` : '');
    setCount(shown.length < rows.length ? `${shown.length} / ${rows.length} shown` : `${rows.length} object${rows.length !== 1 ? 's' : ''}`);
  }
  function moreEntities() { entLimit += 200; renderEntities(); }

  async function quickToggleVis(idx) {
    const e = entityList.find((x) => x.idx === idx);
    if (!e) return;
    const r = await nui('ent:visible', { handle: idx, on: !e.visible });
    if (r && r.entity) { updateEnt(r.entity); renderEntities(); } else toast('warning', 'Object gone', 'It streamed out — scan again.');
  }

  // Inspector
  const insEntity = () => entityList.find((x) => x.idx === inspectIdx);
  function openEntInspector(idx) {
    const e = entityList.find((x) => x.idx === idx);
    if (!e) return;
    inspectIdx = idx; inspectFlags = 0; selectedEntityIdx = idx;
    nui('ent:select', { handle: idx });
    qid('ent-insp-title').textContent = e.name;
    const flagGrid = ENTITY_FLAGS.map((f) => `<div class="flag-item" id="insf-${f.bit}" onclick="insToggleFlag(${f.bit})">
      <input type="checkbox" tabindex="-1" onclick="event.preventDefault()"><span class="flag-name">${f.name}</span><span class="flag-bit">${f.bit}</span></div>`).join('');
    const presetBtns = ENTITY_FLAG_PRESETS.map((p) => `<button class="insp-preset-btn" onclick="insPreset(${p.value})">${esc(p.name)}</button>`).join('');
    qid('ent-insp-body').innerHTML = `
      <div class="insp-sec">Data</div>
      <div class="insp-grid">
        <div class="insp-row"><span class="insp-k">Model</span><span class="insp-v mono">${esc(e.name)}</span></div>
        <div class="insp-row"><span class="insp-k">Hash</span><span class="insp-v mono">${e.hashNum}</span></div>
        <div class="insp-row"><span class="insp-k">Type</span><span class="insp-v">${esc(e.etype)}${e.door ? ' · registered door' : ''}</span></div>
        <div class="insp-row"><span class="insp-k">Room</span><span class="insp-v">${esc(entRoomName(e))}</span></div>
        <div class="insp-row"><span class="insp-k">Position</span><span class="insp-v mono" id="ins-pos">${e.x}, ${e.y}, ${e.z}</span></div>
        <div class="insp-row"><span class="insp-k">Heading</span><span class="insp-v mono">${e.h}&deg;</span></div>
        <div class="insp-row"><span class="insp-k">Rotation</span><span class="insp-v mono">${e.rx}, ${e.ry}, ${e.rz}</span></div>
        <div class="insp-row"><span class="insp-k">Size (L×W×H)</span><span class="insp-v mono">${e.size.x} × ${e.size.y} × ${e.size.z}</span></div>
        <div class="insp-row"><span class="insp-k">LOD distance</span><span class="insp-v mono">${e.lod != null ? e.lod + ' m' : '—'}</span></div>
        <div class="insp-row"><span class="insp-k">Distance</span><span class="insp-v mono">${e.dist} m</span></div>
      </div>
      <div class="insp-sec">Live controls</div>
      <div class="insp-ctrls">
        <div class="insp-ctrl"><span class="insp-k">Visible</span>
          <label class="sw"><input type="checkbox" id="ins-vis" ${e.visible ? 'checked' : ''} onchange="insToggleVisible()"><span class="sw-track"><span class="sw-thumb"></span></span></label></div>
        ${e.collision === null || e.collision === undefined ? '' : `<div class="insp-ctrl"><span class="insp-k">Collision</span>
          <label class="sw"><input type="checkbox" id="ins-col" ${e.collision ? 'checked' : ''} onchange="insToggleCollision()"><span class="sw-track"><span class="sw-thumb"></span></span></label></div>`}
        <div class="insp-ctrl"><span class="insp-k">Opacity <span class="dist-val" id="ins-alpha-val">${e.alpha}</span></span>
          <input type="range" class="dist-range" id="ins-alpha" min="0" max="255" step="5" value="${e.alpha}" oninput="insSetAlpha(this.value)"></div>
        ${S.ui.allowTeleport !== false ? '<button class="btn outline sm insp-tp" onclick="insTeleport()">Teleport to entity</button>' : ''}
      </div>
      <div class="insp-sec">YMAP flags <span class="insp-note">Pick a preset or switch flags, then copy them into your YMAP</span></div>
      <div class="insp-presets">${presetBtns}</div>
      <div class="flag-grid insp-flag-grid">${flagGrid}</div>
      <div class="insp-flag-foot">
        <span class="insp-flag-val">Value <b class="mono" id="ins-flag-raw">0</b></span>
        <button class="btn outline sm" onclick="insCopy('flags',this)">Copy value</button>
        <button class="btn primary sm" onclick="insCopy('flagsline',this)">Copy &lt;flags&gt;</button>
      </div>
      <div class="insp-sec">Copy</div>
      <div class="insp-copy-row">
        <button class="btn outline sm" onclick="insCopy('name',this)">Name</button>
        <button class="btn outline sm" onclick="insCopy('hash',this)">Hash</button>
        <button class="btn outline sm" onclick="insCopy('coords',this)">Coords</button>
        <button class="btn outline sm" onclick="insCopy('vec4',this)">vector4</button>
        <button class="btn outline sm" onclick="insCopy('ymap',this)">YMAP Item</button>
      </div>`;
    qid('ent-flag-modal').classList.add('open');
    renderEntities();
  }
  function closeEntFlagModal() { qid('ent-flag-modal').classList.remove('open'); inspectIdx = null; }
  async function insToggleVisible() {
    const e = insEntity(); if (!e) return;
    const r = await nui('ent:visible', { handle: e.idx, on: !!qid('ins-vis').checked });
    if (r && r.entity) { const n = updateEnt(r.entity); const c = qid('ins-vis'); if (c) c.checked = n.visible; renderEntities(); }
  }
  async function insToggleCollision() {
    const e = insEntity(); if (!e) return;
    const r = await nui('ent:collision', { handle: e.idx, on: !!qid('ins-col').checked });
    if (r && r.entity) { updateEnt(r.entity); renderEntities(); }
  }
  let alphaTimer = null;
  function insSetAlpha(val) {
    const e = insEntity(); if (!e) return;
    const a = parseInt(val, 10);
    const lbl = qid('ins-alpha-val'); if (lbl) lbl.textContent = a;
    clearTimeout(alphaTimer);
    alphaTimer = setTimeout(async () => {
      const r = await nui('ent:alpha', { handle: e.idx, alpha: a });
      if (r && r.entity) { updateEnt(r.entity); renderEntities(); }
    }, 50);
  }
  function insTeleport() { const e = insEntity(); if (e) nui('ent:teleport', { handle: e.idx }); }
  function setInspectFlags(val) {
    inspectFlags = Number(val) >>> 0;
    ENTITY_FLAGS.forEach((f) => {
      const el = qid('insf-' + f.bit);
      if (!el) return;
      const on = !!(inspectFlags & f.bit);
      el.classList.toggle('on', on);
      const c = el.querySelector('input'); if (c) c.checked = on;
    });
    const raw = qid('ins-flag-raw'); if (raw) raw.textContent = String(inspectFlags);
  }
  function insToggleFlag(bit) { setInspectFlags((inspectFlags & bit) ? (inspectFlags & ~bit) >>> 0 : (inspectFlags | bit) >>> 0); }
  function insPreset(val) { setInspectFlags(val); }
  // YMAP CEntityDef rotation is stored inverted (conjugate) relative to the world rotation
  function buildYmapItem(e, flags) {
    const [x, y, z, w] = e.q.length === 4 ? e.q : [0, 0, 0, 1];
    const f6 = (n) => (Number(n) || 0).toFixed(6);
    return `<Item type="CEntityDef">
  <archetypeName>${/^\d+$/.test(e.name) ? 'hash_' + (Number(e.name) >>> 0).toString(16).toUpperCase().padStart(8, '0') : esc(e.name)}</archetypeName>
  <flags value="${flags >>> 0}"/>
  <guid value="0"/>
  <position x="${f6(e.fx)}" y="${f6(e.fy)}" z="${f6(e.fz)}"/>
  <rotation x="${f6(-x)}" y="${f6(-y)}" z="${f6(-z)}" w="${f6(w)}"/>
  <scaleXY value="1"/>
  <scaleZ value="1"/>
  <parentIndex value="-1"/>
  <lodDist value="${Math.round(e.lod || 100)}"/>
  <childLodDist value="0"/>
  <lodLevel>LODTYPES_DEPTH_ORPHANHD</lodLevel>
  <numChildren value="0"/>
  <priorityLevel>PRI_REQUIRED</priorityLevel>
  <extensions/>
  <ambientOcclusionMultiplier value="255"/>
  <artificialAmbientOcclusion value="255"/>
  <tintValue value="0"/>
</Item>`;
  }
  function insCopy(kind, btn) {
    const e = insEntity(); if (!e) return;
    const str = {
      name: e.name, hash: e.hash, coords: `${e.x}, ${e.y}, ${e.z}`, vec4: `vector4(${e.x}, ${e.y}, ${e.z}, ${e.h})`,
      ymap: buildYmapItem(e, inspectFlags), flags: String(inspectFlags >>> 0), flagsline: `<flags value="${inspectFlags >>> 0}"/>`,
    }[kind];
    if (str !== undefined) copyStr(str, btn);
  }

  /* ================================================================ EXPORT */

  var exportMode = 'all';
  function openExportModal() { qid('export-modal').classList.add('open'); renderExport(); }
  function closeExportModal() { qid('export-modal').classList.remove('open'); }
  function setExportMode(btn, mode) {
    document.querySelectorAll('.export-filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    exportMode = mode;
    renderExport();
  }
  const fv = (n) => (parseFloat(n) || 0).toFixed(4);
  const xesc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  function tcXml(r) {
    const name = (!r.tcHash || r.tcName === 'none') ? 'none' : (r.tcName || hashToName(r.tcHash));
    return /^\d+$/.test(name) ? 'hash_' + (Number(name) >>> 0).toString(16).toUpperCase().padStart(8, '0') : xesc(name);   // unknown name: CodeWalker's hash_XXXXXXXX
  }
  function buildRoomsXml(i1) {
    const i2 = i1 + '  ';
    return MX.rooms.map((r) => [
      `${i1}<Item>`, `${i2}<name>${xesc(r.name)}</name>`,
      `${i2}<bbMin x="${fv(r.bbMin.x)}" y="${fv(r.bbMin.y)}" z="${fv(r.bbMin.z)}" />`,
      `${i2}<bbMax x="${fv(r.bbMax.x)}" y="${fv(r.bbMax.y)}" z="${fv(r.bbMax.z)}" />`,
      `${i2}<blend value="1" />`, `${i2}<timecycleName>${tcXml(r)}</timecycleName>`, `${i2}<flags value="${r.flag >>> 0}" />`,
      `${i1}</Item>`].join('\n')).join('\n');
  }
  // corners are interior-local (what a .ytyp stores), not world positions
  function buildPortalsXml(i1) {
    const i2 = i1 + '  ', i3 = i2 + '  ';
    return MX.portals.map((p) => [
      `${i1}<Item>`, `${i2}<roomFrom value="${p.roomFrom}" />`, `${i2}<roomTo value="${p.roomTo}" />`,
      `${i2}<flags value="${p.flags >>> 0}" />`, `${i2}<mirrorPriority value="0" />`, `${i2}<opacity value="0" />`,
      `${i2}<corners>`, ...p.corners.map((c) => `${i3}<Item x="${fv(c.x)}" y="${fv(c.y)}" z="${fv(c.z)}" />`), `${i2}</corners>`,
      `${i1}</Item>`].join('\n')).join('\n');
  }
  function activeSets() { return Object.entries(lastScanResult).filter(([, v]) => v === true).map(([n]) => n); }
  function buildEntitySetsXml(ind) { return activeSets().map((n) => `${ind}<Item>${xesc(n)}</Item>`).join('\n'); }
  function archetypeName() {
    if (S.interior && S.interior.archetypeName) return S.interior.archetypeName;
    const vanilla = intName(MX.nameHash);
    return vanilla || 'hash_' + (MX.nameHash >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }
  function renderExport() {
    const out = qid('export-out'), meta = qid('export-meta');
    if (!out) return;
    if (MX.intId === 'OUTSIDE') { out.textContent = '<!-- Enter an interior to export data -->'; if (meta) meta.textContent = ''; return; }
    let xml = '', label = '';
    if (exportMode === 'rooms') { xml = `<rooms>\n${buildRoomsXml('  ')}\n</rooms>`; label = `${MX.rooms.length} room${MX.rooms.length !== 1 ? 's' : ''}`; }
    else if (exportMode === 'portals') { xml = `<portals>\n${buildPortalsXml('  ')}\n</portals>`; label = `${MX.portals.length} portal${MX.portals.length !== 1 ? 's' : ''}`; }
    else if (exportMode === 'sets') {
      const rows = buildEntitySetsXml('  '); const count = activeSets().length;
      xml = rows ? `<entitySets>\n${rows}\n</entitySets>` : '<entitySets />';
      label = `${count} active set${count !== 1 ? 's' : ''}`;
    } else {
      xml = ['<CMapTypes>', '  <archetypes>', '    <Item type="CMloArchetypeDef">', `      <name>${xesc(archetypeName())}</name>`,
        '      <rooms>', buildRoomsXml('        '), '      </rooms>', '      <portals>', buildPortalsXml('        '), '      </portals>',
        '      <entitySets>', buildEntitySetsXml('        '), '      </entitySets>', '    </Item>', '  </archetypes>', '</CMapTypes>'].join('\n');
      label = `interior ${MX.intId} · ${MX.roomCount} rooms · ${MX.portalCount} portals`;
    }
    out.textContent = xml;
    if (meta) meta.textContent = `Snapshot: ${label} — ${new Date().toLocaleTimeString()}`;
  }
  function copyExport() {
    const txt = qid('export-out') && qid('export-out').textContent;
    if (!txt || txt.startsWith('<!--')) return;
    const btn = qid('export-copy-btn');
    copyStr(txt);
    if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => { btn.textContent = 'Copy XML'; }, 1500); }
  }
  async function openExportModalFresh() { await loadState(); openExportModal(); }

  /* ========================================================= window API */
  // functions referenced by inline handlers in the MLOX markup
  Object.assign(window, {
    nuiPost, openRoomModal, closeRoomModal, toggleRoomFlag, applyRoomFlags, applyRoomTC, resetRoomFlags, resetAllChanges,
    toggle3DOverlay, toggleOvSettings, setOv, toggleOvField, setOvColor, resetOverlay, highlightPortal, toggleDropdown, selectPortalRoom, openFlagModal, closeFlagModal, togglePortalFlag,
    applyPortalFlags, resetPortalFlags, gotoPortal,
    fetchEntitySets, addEntitySet, removeEntitySet, doActivate, doDeactivate, setAllEntitySets,
    filterTC, applyTCName, resetCurrentTC, applyCustomHash,
    saveWaypoint, deleteWaypoint, teleportTo, copyCoords, copyLive, startRename, renderWaypoints, exportWaypoints, importWaypoints,
    graphNodeClick, hideGraphTooltip, graphZoom, graphFit, graphUnpin, graphResetLayout, setEntAuto, setEntLive,
    scanEntities, setEntFilter, setEntMode, setEntRadius, setEntSort, entSearchInput, toggle3DEntities, selectEntity,
    pickAimedEntity, restoreEntities, quickToggleVis, openEntInspector, closeEntFlagModal, insToggleVisible, insToggleCollision,
    insSetAlpha, insTeleport, insToggleFlag, insPreset, insCopy, moreEntities,
    openExportModal: openExportModalFresh, closeExportModal, setExportMode, copyExport,
  });
  // restore overlay state chosen in an earlier session
  setTimeout(() => sendOverlay(true), 1500);

  if (entAuto !== 'off') setTimeout(() => nui('ent:auto', { mode: entAuto, radius: 25 }), 900);
  // factory reset: overlay, auto-select and floor-plan view back to their defaults
  function factoryReset() {
    ov = { ...OV_DEFAULT, fields: { ...OV_DEFAULT.fields }, colors: { ...OV_DEFAULT.colors } };
    sendOverlay(true);
    nui('ins:overlay', { selected: false, entities: false });
    setEntAuto('off');
    _graphLayout = null; _graphFullKey = null; _gView = { x: 0, y: 0, k: 1 };
  }
  window.JDT_MLOX = { factoryReset, get state() { return MX; }, get waypoints() { return waypoints; }, get overlayOn() { return !!ov.portals; }, buildYmapItem, hashToName, cleanWp, renderExport, get entities() { return entityList; } };
})();
