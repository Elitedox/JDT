/* JDT UI - plain JS, no build step. */
'use strict';

const DEFAULT_ACCENT = '#58c98b';

const IS_BROWSER = typeof window.GetParentResourceName !== 'function';
const RESOURCE = IS_BROWSER ? 'jdt' : window.GetParentResourceName();

/* ------------------------------------------------------------------ state */

const S = {
  visible: false,
  aiming: false,
  tab: 'interior',
  locales: {},
  presets: [],
  fields: [],
  doorSounds: [],
  ui: {},
  output: { ymt: true, dat151: true, doors: true, xml: true, comments: false, install: 'self' },
  place: { defaultRange: 15, defaultGroup: 'default' },
  openKey: 'F5',
  version: '',
  resource: 'jdt',

  interior: null,      // project of the interior you stand in (null outside)
  analysis: null,
  doorSpots: {},
  room: 0,
  hereRoom: -1,
  portal: null,
  expanded: {},
  portalFilter: '',
  roomFilter: '',
  debug: { outline: false, fill: false, info: false, entities: false, navigate: null, selected: null, debugEntities: [] },
  dirty: false,
  editVersion: 0,

  elements: [],
  active: new Set(),   // element ids currently playing in the world
  group: 'default',
  range: 15,
  previews: [],
  muteAll: false,
  solo: null,
  overrides: {},       // id -> false (paused locally)
  exportStatus: {},
  resources: null,

  cat: { sounds: [], radios: [], statics: [], banks: [], bankKind: {}, objects: [], doorPresets: [], vanillaInt: new Map(), loaded: false,
    amb: { rules: [], dirAmbiences: [], environmentRules: [], weaponMetrics: [], categories: [], scenes: [] } },
  custom: {},          // group -> custom sounds (server list)
  csel: null,          // { group, key } custom sound open in the editor
  upload: null,        // { name, done, total } while uploading
  zoneStates: {},
  doorSamples: {},     // preset id (lower) -> file in samples/doors/
  samplePlaying: null, // preset id whose sample plays      // zone id -> { inside, rules: [{ index, playing }] }
  soundsCfg: { maxUploadMB: 25, sampleRate: 32000, codec: 'adpcm', category: 'scripted', normalize: true },
  check: { bad: new Set(), hidden: new Set(), checked: 0, at: null },
  scan: null,
  failed: new Set(),
  lib: 'sounds',
  q: { sounds: '', scat: '', src: '', emitters: '', ecat: '', radios: '', hiddenRadios: false, objects: '', audioOnly: true, mute: '', doors: '', placed: '', pgroup: '', here: false, custom: '', zrules: '' },
  showRemoved: false,
  limit: 250,
  sel: null,           // template being configured before placing
  edit: null,          // copy of an element being edited (live)

  preview: { kind: 'ymt', text: '' },
  lastResult: null,
  saves: null,
  busy: false,
  showHelp: true,
  prefs: { width: 980, height: 640, opacity: 1, scale: 1, accent: DEFAULT_ACCENT, x: null, y: null, theme: 'blackout', anim: true, smooth: true, compact: true, glass: false },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const u32 = (v) => (Number(v) >>> 0);
const hex = (v) => u32(v).toString(16).toUpperCase().padStart(8, '0');
const clone = (o) => JSON.parse(JSON.stringify(o));
const pretty = (n) => String(n || '').replace(/^(DLC_|dlc_|SE_|se_)/, '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function joaat(str) {
  let h = 0;
  const s = String(str).toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h = (h + s.charCodeAt(i)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  return h;
}

/* ----------------------------------------------------------- custom sounds */

const safeName = (g) => String(g || 'default').replace(/[^\w-]/g, '_').toLowerCase();
function customList() { return Object.values(obj(S.custom)).flatMap((l) => arr(l)); }
function customByName(name) {
  const n = String(name || '').toLowerCase();
  return customList().find((c) => c.name.toLowerCase() === n) || null;
}
function customTpl(c) {
  return { type: 'sound', sound: { name: c.name, set: '', bank: c.bank, bankType: 'script', repeat: !c.loop, delayMin: 0, delayMax: 0 }, label: c.label || c.key };
}
const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${(Number(s) || 0).toFixed(1)} s`);

/* ----------------------------------------------------------------- locale */

function t(key, ...args) {
  const str = S.locales[key] ?? key;
  let i = 0;
  return String(str).replace(/%(\.\d+)?[sdif]/g, (m, prec) => {
    const a = args[i++];
    if (a === undefined) return m;
    if (prec && typeof a === 'number') return a.toFixed(Number(prec.slice(1)));
    return String(a);
  });
}
const has = (key) => S.locales[key] !== undefined;

/* -------------------------------------------------------------------- NUI */

nui.warned = {};

async function nui(name, data = {}) {
  if (IS_BROWSER) return {};
  try {
    const resp = await fetch(`https://${RESOURCE}/jdt:${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(data),
    });
    // an empty reply means Lua has no handler for this name (an outdated client file): say so once, quietly
    const txt = await resp.text();
    if (!txt) { if (!nui.warned[name]) { nui.warned[name] = true; console.warn(`[JDT] no Lua handler for ${name}: restart jdt`); } return { ok: false, missing: true }; }
    return JSON.parse(txt);
  } catch (e) {
    console.error('nui', name, e);
    return {};
  }
}

/* -------------------------------------------------------------- catalogs */

function loadCatalogs() {
  const files = ['sounds', 'radios', 'static_emitters', 'banks', 'objects', 'interiors', 'door_presets', 'ambience'];
  const base = '../catalog/';
  Promise.all(files.map((f) => fetch(`${base}${f}.json`).then((r) => r.json()).catch(() => null)))
    .then(([sounds, radios, statics, banks, objects, interiors, doorPresets, ambience]) => {
      const c = S.cat;
      if (ambience) c.amb = { ...c.amb, ...ambience };
      c.sounds = sounds || [];
      c.radios = radios || [];
      c.statics = statics || [];
      c.objects = objects || [];
      c.doorPresets = doorPresets || [];
      if (banks) {
        arr(banks.script).forEach((b) => { c.bankKind[b] = 'script'; });
        arr(banks.ambient).forEach((b) => { c.bankKind[b] = 'ambient'; });
        c.banks = Object.keys(c.bankKind).sort((a, b) => a.localeCompare(b));
      }
      (interiors || []).forEach((n) => c.vanillaInt.set(joaat(n), n));
      c.loaded = true;
      if (S.visible && ['library', 'rooms', 'doors', 'placed'].includes(S.tab)) render();
    });
}

/* ------------------------------------------------------------------ prefs */

function loadPrefs() {
  if (S.ui.rememberLayout === false) return;
  try {
    const raw = localStorage.getItem('jdt:prefs');
    if (raw) {
      const saved = JSON.parse(raw);
      Object.assign(S.prefs, saved);
    }
    const tab = localStorage.getItem('jdt:tab');
    if (tab && TABS.includes(tab)) S.tab = tab;
    const help = localStorage.getItem('jdt:help');
    if (help !== null) S.showHelp = help === '1';
  } catch (e) { /* storage unavailable */ }
}

function savePrefs() {
  try {
    localStorage.setItem('jdt:prefs', JSON.stringify({ ...S.prefs, v: 2 }));
    localStorage.setItem('jdt:tab', S.tab);
    localStorage.setItem('jdt:help', S.showHelp ? '1' : '0');
  } catch (e) { /* storage unavailable */ }
}

function hexA(hex, a) {
  const n = parseInt(String(hex).replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1, 7), 16), pb = parseInt(b.slice(1, 7), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('');
}
// a player's starting look comes from Config.UI (Settings > Factory reset goes back to it)
function defaultPrefs() {
  const u = S.ui || {};
  return { width: u.width || 980, height: u.height || 640, opacity: u.opacity || 1, scale: u.scale || 1, accent: u.accent || DEFAULT_ACCENT, x: null, y: null,
    theme: u.theme || 'blackout', anim: u.animations !== false, smooth: u.smoothScroll !== false, compact: u.compact === true, glass: u.glass === true };
}

function applyPrefs() {
  const root = document.documentElement.style;
  const p = S.prefs;
  root.setProperty('--w', `${clamp(Number(p.width) || 980, 720, 1600)}px`);
  root.setProperty('--h', `${clamp(Number(p.height) || 640, 520, 1100)}px`);
  root.setProperty('--opacity', clamp(Number(p.opacity) || 1, 0.6, 1));
  root.setProperty('--scale', clamp(Number(p.scale) || 1, 0.8, 1.4));
  root.setProperty('--accent', p.accent || DEFAULT_ACCENT);
  root.setProperty('--accent-2', mixHex(p.accent || DEFAULT_ACCENT, '#ffffff', .35));
  root.setProperty('--accent-dim', hexA(p.accent || DEFAULT_ACCENT, .13));
  root.setProperty('--accent-glo', hexA(p.accent || DEFAULT_ACCENT, .32));
  // every glow, hover wash and highlight in the CSS is rgba(var(--accent-rgb), a): one value recolours them all
  const ac = String(p.accent || DEFAULT_ACCENT).replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(ac.slice(i, i + 2), 16) || 0);
  root.setProperty('--accent-rgb', rgb.join(', '));
  // the in-world drawings (locate path, selected object outline) follow the accent too
  if (applyPrefs._rgb !== rgb.join() && typeof nui === 'function') { applyPrefs._rgb = rgb.join(); nui('ui:accent', { rgb }); if (window.JDT_OVERLAY && window.JDT_OVERLAY.resend) window.JDT_OVERLAY.resend(); }
  const html = document.documentElement;
  html.dataset.theme = THEMES.some((x) => x.id === p.theme) ? p.theme : 'ember';
  html.classList.toggle('anim', p.anim !== false);
  html.classList.toggle('smooth', p.smooth !== false);
  html.classList.toggle('compact', !!p.compact);
  html.classList.toggle('glass', !!p.glass);
  placeShell();
}

/* Dark themes (JDT is always dark): surfaces + default accent */
const THEMES = [
  { id: 'ember', name: 'Ember', accent: '#ff7a1a', bg: '#141413', panel: '#1a1a19', card: '#262624' },
  { id: 'nightshift', name: 'Nightshift', accent: '#ff7a1a', bg: '#131417', panel: '#18191d', card: '#1f2025' },
  { id: 'blackout', name: 'Blackout', accent: '#ff7a1a', bg: '#0f0f10', panel: '#141415', card: '#1a1a1c' },
  { id: 'harbor', name: 'Harbor', accent: '#ff8c3a', bg: '#111419', panel: '#161a21', card: '#1c212a' },
  { id: 'foundry', name: 'Foundry', accent: '#ff9a4a', bg: '#121518', panel: '#171b1f', card: '#1d2227' },
  { id: 'kiln', name: 'Kiln', accent: '#ff6b1a', bg: '#151311', panel: '#1b1916', card: '#22201c' },
];

/* Window position: centred until dragged, then remembered (kept on screen). */
function placeShell() {
  const shell = $('#shell');
  if (!shell) return;
  const p = S.prefs;
  if (p.x === null || p.x === undefined || p.y === null || p.y === undefined) {
    shell.classList.remove('placed'); shell.style.left = ''; shell.style.top = '';
    return;
  }
  const r = shell.getBoundingClientRect();
  const w = r.width || 980, h = r.height || 640;
  shell.classList.add('placed');
  shell.style.left = `${clamp(p.x, 0, Math.max(0, window.innerWidth - w))}px`;
  shell.style.top = `${clamp(p.y, 0, Math.max(0, window.innerHeight - h))}px`;
}

/* ------------------------------------------------------------------ edits */

function buildEdits() {
  const i = S.interior;
  if (!i) return null;
  return {
    saveName: i.saveName,
    archetypeName: i.archetypeName || '',
    notes: i.notes || '',
    group: i.group,
    output: i.output,
    doors: obj(i.doors),
    placements: arr(i.placements),
    proxyHashOverride: i.proxyHashOverride === undefined || i.proxyHashOverride === null ? false : i.proxyHashOverride,
    settings: i.settings,
    rooms: i.rooms.map((r) => ({ preset: r.preset || '', dat151: r.dat151 })),
    portals: i.portals.map((p) => ({
      isEnabled: p.isEnabled,
      entities: p.entities.map((e) => ({ maxOcclusion: e.maxOcclusion, isDoor: e.isDoor, isGlass: e.isGlass, linkType: e.linkType })),
    })),
  };
}

function normalize(interior) {
  interior.rooms = arr(interior.rooms);
  interior.portals = arr(interior.portals).map((p) => ({
    ...p,
    isEnabled: arr(p.isEnabled).length ? arr(p.isEnabled) : [true, true],
    entities: arr(p.entities),
    corners: arr(p.corners),
  }));
  interior.settings = obj(interior.settings);
  interior.doors = obj(interior.doors);
  interior.output = { rooms: true, occlusion: true, doors: true, ...obj(interior.output) };
  return interior;
}

function applyPayload(p, soft = false, sentVersion = null) {
  if (!p || p.interior === undefined) return;
  if (p.interior === false) {
    S.interior = null;
    S.analysis = null;
    if (soft) renderDerived(); else render();
    return;
  }
  S.analysis = p.analysis || S.analysis;
  if (S.analysis) {
    S.analysis.issues = arr(S.analysis.issues);
    if (S.analysis.summary) S.analysis.summary.reach = arr(S.analysis.summary.reach);
  }
  if (p.doorSpots) S.doorSpots = obj(p.doorSpots);
  if (sentVersion === null || sentVersion === S.editVersion) {
    S.interior = normalize(p.interior);
    if (sentVersion !== null) S.dirty = false;
  }
  if (S.room >= S.interior.rooms.length) S.room = 0;
  if (soft) renderDerived(); else render();
}

let syncTimer = null;
function markDirty(delay = 350) {
  S.dirty = true;
  S.editVersion++;
  renderHeader();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

async function sync() {
  clearTimeout(syncTimer);
  if (!S.interior) return;
  const v = S.editVersion;
  const res = await nui('sync', { edits: buildEdits() });
  applyPayload(res, true, v);
}

async function action(name, data = {}, { full = true } = {}) {
  clearTimeout(syncTimer);
  S.busy = true;
  renderHeader();
  const res = await nui(name, { edits: buildEdits(), ...data });
  S.busy = false;
  if (res && res.interior !== undefined) applyPayload(res, !full, null);
  else if (res && res.data && res.data.interior !== undefined) applyPayload(res.data, !full, null);
  else renderHeader();
  return res;
}

/* ------------------------------------------------------------------ icons */

const ICON = {
  overview: '<path d="M3 4h14v12H3z"/><path d="M3 8h14M7 8v8"/>',
  rooms: '<path d="M3 3h14v14H3z"/><path d="M10 3v6H3M10 12v5M13 9h4"/>',
  portals: '<path d="M5 17V6a5 5 0 0 1 10 0v11"/><path d="M3 17h14M10 10v3"/>',
  doors: '<path d="M5 17V3h10v14"/><path d="M3 17h14M12 10h.5"/>',
  map: '<circle cx="5" cy="5" r="2.2"/><circle cx="15" cy="7" r="2.2"/><circle cx="8" cy="15" r="2.2"/><path d="M7 5.6l6 1M6 7l1.6 6M13.6 8.8l-4.2 4.6"/>',
  library: '<path d="M4 15V8M8 15V4M12 15V9M16 15V6"/><path d="M3 17h14"/>',
  placed: '<path d="M10 17s-5-4.6-5-8.5a5 5 0 0 1 10 0C15 12.4 10 17 10 17z"/><circle cx="10" cy="8.5" r="1.8"/>',
  checks: '<path d="M4 10.5l3.5 3.5L16 5.5"/>',
  export: '<path d="M10 3v10M6 9l4 4 4-4M4 16h12"/>',
  settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/>',
  play: '<path d="M7 5l9 5-9 5z" fill="currentColor"/>',
  pause: '<path d="M6.5 5v10M13.5 5v10" stroke-width="2.6"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1" fill="currentColor"/>',
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
  solo: '<path d="M4 13.5V11a6 6 0 0 1 12 0v2.5"/><path d="M3.5 12.5h3v4.5h-3zM13.5 12.5h3v4.5h-3z" fill="currentColor"/>',
  mute: '<path d="M4 8h3l4-3v10l-4-3H4z"/><path d="M14 8l4 4M18 8l-4 4"/>',
  speaker: '<path d="M4 8h3l4-3v10l-4-3H4z"/><path d="M14 7.5a4 4 0 0 1 0 5"/>',
  interior: '<rect x="2.5" y="2.5" width="6" height="6" rx="1"/><rect x="11.5" y="2.5" width="6" height="6" rx="1"/><rect x="2.5" y="11.5" width="6" height="6" rx="1"/><circle cx="14.5" cy="14.5" r="3"/>',
  mportals: '<circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="10" r="3.4"/><path d="M10 2.5v4M10 13.5v4"/>',
  entitysets: '<rect x="2.5" y="4" width="15" height="2.6" rx="1"/><rect x="2.5" y="8.7" width="15" height="2.6" rx="1"/><rect x="2.5" y="13.4" width="9.5" height="2.6" rx="1"/>',
  timecycles: '<circle cx="10" cy="10" r="7.5"/><path d="M10 5.5V10l3.4 2.2"/>',
  locations: '<path d="M10 17.5s-5.5-5-5.5-9.3a5.5 5.5 0 0 1 11 0c0 4.3-5.5 9.3-5.5 9.3z"/><circle cx="10" cy="8.2" r="1.9"/>',
  graph: '<circle cx="4.5" cy="10" r="2.4"/><circle cx="15.5" cy="4.5" r="2.4"/><circle cx="15.5" cy="15.5" r="2.4"/><path d="M6.8 9l6.4-3.4M6.8 11l6.4 3.4"/>',
  entities: '<rect x="2.5" y="3.5" width="6" height="6" rx="1"/><rect x="11.5" y="3.5" width="6" height="6" rx="1"/><rect x="2.5" y="11.5" width="6" height="6" rx="1"/><rect x="11.5" y="11.5" width="6" height="6" rx="1"/>',
};
const icon = (name, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;

/* Sidebar: MLO tools first, then the audio tools, then utilities and settings. */
const NAV = [
  { sec: 'ui_nav_mlo', tabs: ['interior', 'mportals', 'entitysets', 'timecycles', 'locations', 'graph', 'entities'] },
  { sec: 'ui_nav_audio', tabs: ['overview', 'rooms', 'portals', 'doors', 'map', 'library', 'placed', 'checks', 'export'] },
  { sec: '', tabs: ['settings'] },
];
const TABS = NAV.flatMap((g) => g.tabs);
const MLOX_TABS = NAV[0].tabs;
const NEEDS_INTERIOR = ['rooms', 'portals', 'doors', 'map', 'checks'];

/* ------------------------------------------------------------- help text */

/* Every editable value explains itself: what it does, and whether you hear it now or after reconnecting. */
function help(key, live) {
  if (!S.showHelp) return '';
  const text = has('help_' + key) ? t('help_' + key) : '';
  const badge = live === undefined ? '' : live
    ? `<span class="badge live" title="${esc(t('badge_live_info'))}">${esc(t('badge_live'))}</span>`
    : `<span class="badge later" title="${esc(t('badge_reconnect_info'))}">${esc(t('badge_reconnect'))}</span>`;
  if (!text && !badge) return '';
  return `<div class="hint">${badge}${esc(text)}</div>`;
}

/* ----------------------------------------------------------------- render */

function render() {
  const focus = captureFocus();
  renderHeader();
  renderRail();
  renderNowPlaying();
  const view = $('#view');
  const scroll = view.scrollTop;
  const fn = VIEWS[S.tab] || VIEWS.overview;
  view.classList.toggle('mx-tab', MLOX_TABS.includes(S.tab) || S.tab === 'emitters');
  view.innerHTML = (!S.interior && NEEDS_INTERIOR.includes(S.tab)) ? outsideView() : fn();
  afterRender();
  view.scrollTop = scroll;
  restoreFocus(focus);
}

function outsideView() {
  return `<div class="empty big">
    <div class="empty-icon">${icon(S.tab, 34)}</div>
    <b>${esc(t('ui_walk_in'))}</b>
    <p>${esc(t('ui_walk_in_text'))}</p>
    <button class="btn" data-tab="library">${esc(t('ui_go_library'))}</button>
  </div>`;
}

function renderDerived() {
  renderHeader();
  renderRail();
  $$('[data-derived]').forEach((el) => {
    const v = DERIVED[el.dataset.derived];
    if (v) el.innerHTML = v();
  });
  const active = document.activeElement;
  const typing = active && $('#view').contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName);
  if (!typing && (S.tab === 'checks' || S.tab === 'map')) render();
  drawEcho();
}

function captureFocus() {
  const a = document.activeElement;
  if (!a || !a.dataset || !(a.dataset.bind || a.id)) return null;
  return { bind: a.dataset.bind, id: a.id, kind: a.type, start: a.selectionStart, end: a.selectionEnd };
}

function restoreFocus(f) {
  if (!f) return;
  const el = f.bind ? $$(`[data-bind="${CSS.escape(f.bind)}"]`).find((e) => e.type === f.kind) : (f.id ? document.getElementById(f.id) : null);
  if (!el) return;
  el.focus({ preventScroll: true });
  try { if (f.start != null) el.setSelectionRange(f.start, f.end); } catch (e) { /* not a text input */ }
}

function renderHeader() {
  const i = S.interior;
  $('#title').textContent = t('ui_tab_' + S.tab);
  const audio = !MLOX_TABS.includes(S.tab) && S.tab !== 'settings' && !(window.JDT_UTIL_TABS || []).includes(S.tab);
  $('#subtitle').innerHTML = !audio ? '' : i
    ? `${esc(i.archetypeName || i.name)} · ${esc(t('ui_group'))} <b>${esc(i.group)}</b> · ${esc(i.saveName)}.json${S.dirty ? `<span class="dirty-dot" title="${esc(t('ui_unsynced'))}"></span>` : ''}`
    : `${esc(t('ui_outside_interior'))} · ${esc(t('ui_group'))} <b>${esc(S.group)}</b>`;
  const save = $('#btn-save');
  save.textContent = S.busy ? t('ui_working') : t('ui_save');
  save.disabled = S.busy || !i;
  save.hidden = !i || !audio;
  const xml = $('#btn-xml');
  if (xml) { xml.hidden = !MLOX_TABS.includes(S.tab); xml.textContent = t('ui_export_xml'); }
  const ver = $('#sb-ver');
  if (ver) ver.textContent = `JDT ${S.version || "1.0.0"}`;
}

// live problem counts for the MLO tabs (the panel already has the data; nothing extra is asked from the game)
function smartBadges() {
  const st = window.JDT_MLOX && window.JDT_MLOX.state;
  const out = {};
  if (st && st.intId !== 'OUTSIDE' && st.rooms && st.rooms.length) {
    const ids = new Set(st.rooms.map((r) => r.id));
    const broken = st.portals.filter((p) => !ids.has(p.roomFrom) || !ids.has(p.roomTo)).length;
    const linked = new Set();
    st.portals.forEach((p) => { linked.add(p.roomFrom); linked.add(p.roomTo); });
    const lonely = st.rooms.filter((r) => r.id !== 0 && !linked.has(r.id)).length;
    const changedRooms = st.rooms.filter((r) => r.flag !== r.oflag || r.tcHash !== r.originalTcHash).length;
    const changedPortals = st.portals.filter((p) => p.flags !== p.oflags || p.roomFrom !== p.ofrom || p.roomTo !== p.oto).length;
    if (broken) out.mportals = { n: broken, cls: '', tip: `${broken} portal${broken > 1 ? 's' : ''} lead to a room that does not exist` };
    else if (changedPortals) out.mportals = { n: changedPortals, cls: 'info', tip: `${changedPortals} portal${changedPortals > 1 ? 's' : ''} changed` };
    if (lonely) out.graph = { n: lonely, cls: 'warn', tip: `${lonely} room${lonely > 1 ? 's have' : ' has'} no portal` };
    if (changedRooms) out.interior = { n: changedRooms, cls: 'info', tip: `${changedRooms} room${changedRooms > 1 ? 's' : ''} changed` };
  }
  return out;
}

function renderRail() {
  const issues = S.analysis ? S.analysis.issues : [];
  const errors = issues.filter((x) => x.level === 'error').length;
  const warns = issues.filter((x) => x.level === 'warning').length;
  const pending = Object.values(obj(S.exportStatus)).some((s) => s.pending);
  const smart = smartBadges();
  const badgeOf = (tab) => {
    if (tab === 'checks' && (errors || warns)) return { n: errors || warns, cls: errors ? '' : 'warn', tip: '' };
    if (tab === 'placed' && S.elements.length) return { n: S.elements.length, cls: 'info', tip: '' };
    if (tab === 'export' && pending) return { n: '!', cls: 'warn', tip: t('ui_restart_needed') };
    return smart[tab] || null;
  };
  const rail = $('#rail');
  const html = NAV.map((g) => (g.sec ? `<div class="nav-sec">${esc(t(g.sec))}</div>` : '<div class="nav-sec"></div>') + g.tabs.map((tab) => {
    const b = badgeOf(tab);
    const dim = !S.interior && NEEDS_INTERIOR.includes(tab) ? 'dim' : '';
    return `<button data-tab="${tab}" class="nav-btn ${dim}">${icon(tab, 15)}<span>${esc(t('ui_tab_' + tab))}</span>${b ? `<span class="nav-badge ${b.cls}" title="${esc(b.tip)}">${b.n}</span>` : ''}</button>`;
  }).join('')).join('');
  // the active tab is only a class: switching tabs never rebuilds the list (no hover animation replay)
  if (rail._html !== html) { rail.innerHTML = html; rail._html = html; rail._fitH = -1; }
  if (rail._fitH !== rail.clientHeight) { fitRail(); rail._fitH = rail.clientHeight; }   // re-fit only when the height changed
  rail.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
}

// Every tab stays visible and the rail never scrolls: the row height shrinks with the window
// (31 px down to 22 px) so all tabs, including Settings, always fit.
function fitRail() {
  const rail = $('#rail');
  const shell = $('#shell');
  const btns = rail.querySelectorAll('.nav-btn');
  if (!btns.length || !rail.clientHeight) return;
  rail.style.removeProperty('--nav-h');
  shell.classList.remove('rail-tight');
  const size = () => {
    const extra = rail.scrollHeight - rail.clientHeight;
    if (extra > 0) rail.style.setProperty('--nav-h', `${Math.max(18, Math.floor(31 - extra / btns.length) - 1)}px`);
    return extra;
  };
  if (size() <= 0) return;
  // still too tall at small rows: tighter section headers and a slimmer logo block, then size again
  if (rail.scrollHeight > rail.clientHeight) {
    shell.classList.add('rail-tight');
    rail.style.removeProperty('--nav-h');
    size();
  }
}
window.addEventListener('resize', () => { if (S.visible) { $('#rail')._html = null; renderRail(); } });
document.addEventListener('DOMContentLoaded', () => {
  const rail = $('#rail');
  rail.addEventListener('scroll', () => { if (rail.scrollTop) rail.scrollTop = 0; });   // never scrolls
});

/* ------------------------------------------------------------ now playing */

function renderNowPlaying() {
  const bar = $('#nowplaying');
  const list = S.previews;
  const near = S.active.size;
  const chips = list.map((p) => `
    <div class="np-item ${p.playing ? 'on' : ''}">
      <button class="np-btn" data-np-toggle="${p.id}" aria-label="${esc(p.playing ? t('ui_pause') : t('ui_play'))}">${icon(p.playing ? 'pause' : 'play', 14)}</button>
      <div class="np-text"><b>${esc(p.label)}</b><span>${esc(p.sub || '')}</span></div>
      <button class="np-x" data-np-stop="${p.id}" aria-label="${esc(t('ui_stop'))}">${icon('close', 12)}</button>
    </div>`).join('');
  bar.innerHTML = `
    <div class="np-head">
      <span class="np-title">${icon('speaker', 15)} ${esc(t('ui_now_playing'))}</span>
      <span class="np-world">${esc(t('ui_world_playing', near))}</span>
      <button class="btn sm ghost ${S.muteAll ? 'on' : ''}" data-action="muteAll">${icon('mute', 14)} ${esc(S.muteAll ? t('ui_unmute_all') : t('ui_mute_all'))}</button>
      ${list.length ? `<button class="btn sm ghost" data-action="stopAll">${icon('stop', 13)} ${esc(t('ui_stop_all'))}</button>` : ''}
    </div>
    ${chips ? `<div class="np-list">${chips}</div>` : ''}`;
}

/* ------------------------------------------------------------- components */

function tip(text) {
  return text ? `<span class="tip" title="${esc(text)}">?</span>` : '';
}

function textField(bind, label, value, { placeholder, readonly, mono, helpKey, live } = {}) {
  return `<label class="field"><span class="lbl">${esc(label)}</span>
    <input type="text" class="${mono ? 'mono' : ''}" data-bind="${bind}" value="${esc(value ?? '')}" placeholder="${esc(placeholder || '')}" ${readonly ? 'readonly' : ''} spellcheck="false">
    ${help(helpKey, live)}</label>`;
}

function numberField(bind, label, value, { min, max, step = 1, helpKey, live } = {}) {
  return `<label class="field"><span class="lbl">${esc(label)}</span>
    <input type="number" data-bind="${bind}" data-type="num" value="${esc(value)}" ${min != null ? `min="${min}"` : ''} ${max != null ? `max="${max}"` : ''} step="${step}">
    ${help(helpKey, live)}</label>`;
}

function sliderField(bind, label, value, { min = 0, max = 1, step = 0.01, helpKey, live } = {}) {
  const v = Number(value) || 0;
  return `<label class="field"><span class="lbl">${esc(label)}</span>
    <div class="slider">
      <input type="range" data-bind="${bind}" data-type="num" min="${min}" max="${max}" step="${step}" value="${v}">
      <input type="number" data-bind="${bind}" data-type="num" min="${min}" max="${max}" step="${step}" value="${+v.toFixed(3)}">
    </div>${help(helpKey, live)}</label>`;
}

function check(bind, label, value, cls = 'check') {
  return `<label class="${cls === 'switch' ? 'switch sinline' : cls}"><input type="checkbox" data-bind="${bind}" data-type="bool" ${value ? 'checked' : ''}><span>${esc(label)}</span></label>`;
}

function roomName(index) {
  const r = S.interior && S.interior.rooms[index];
  return r ? (index === 0 ? t('ui_outside') : r.displayName || r.name) : `#${index}`;
}

function intName(hash) {
  return S.cat.vanillaInt.get(u32(hash)) || '';
}

/* ------------------------------------------------------------------ views */

const DERIVED = {
  hashes() {
    const i = S.interior;
    const a = S.analysis || {};
    const match = a.archetypeMatch;
    return `
      <div class="k">${esc(t('ui_name_hash'))}</div><div class="v">${u32(i.nameHash)}</div><div class="v muted">0x${hex(i.nameHash)}</div>
      <div class="k">${esc(t('ui_proxy_hash'))}</div><div class="v">${u32(i.proxyHash)}</div><div class="v muted">${i.proxyHash}</div>
      <div class="k">${esc(t('ui_interior_name'))}</div><div class="v" style="grid-column: span 2">${esc(i.name)}
        ${match === true ? `<span class="chip ok">${esc(t('ui_matches_hash'))}</span>` : match === false ? `<span class="chip bad">${esc(t('ui_hash_mismatch'))}</span>` : ''}</div>
      <div class="k">${esc(t('ui_location'))}</div><div class="v" style="grid-column: span 2">${[i.location.x, i.location.y, i.location.z].map((n) => Number(n).toFixed(2)).join(', ')}</div>
      ${arr(a.placements).map((p, n) => `<div class="k">${esc(t('ui_placement', n + 2))}</div>
        <div class="v">${[p.x, p.y, p.z].map((v) => Number(v).toFixed(2)).join(', ')}</div>
        <div class="v muted row" style="gap: 6px">${esc(p.ymt)}.ymt<button class="btn icon sm ghost danger" data-placement-del="${n}" title="${esc(t('ui_placement_remove'))}">${icon('close', 12)}</button></div>`).join('')}`;
  },
  stats() {
    const s = (S.analysis && S.analysis.summary) || {};
    const placed = S.interior ? S.elements.filter((e) => e.group === S.interior.group).length : 0;
    const tile = (n, l) => `<div class="stat"><b>${n ?? '–'}</b><span>${esc(l)}</span></div>`;
    const zones = S.interior ? S.elements.filter((e) => e.type === 'zone' && e.group === S.interior.group).length : 0;
    const custom = S.interior ? arr(S.custom[S.interior.group]).length : 0;
    return tile(s.rooms - 1, t('ui_stat_rooms')) + tile(s.enabledPortals, t('ui_stat_portals')) + tile(s.paths, t('ui_stat_paths'))
      + tile(s.doorSounds, t('ui_stat_door_sounds')) + tile(placed, t('ui_stat_placed')) + tile(zones, t('ui_stat_zones')) + tile(custom, t('ui_stat_custom'));
  },
  files() {
    const a = S.analysis || {};
    return [a.ymtName, ...arr(a.placements).map((p) => p.ymt)].map((y) => `<div class="f"><span>stream/${esc(y || '')}.ymt</span><span class="muted">${esc(t('ui_file_ymt'))}</span></div>`).join('') + `
      <div class="f"><span>${esc(a.relName || '')}</span><span class="muted">${esc(t('ui_file_dat151'))}</span></div>
      <div class="f"><span>${esc(a.listName || '')}</span><span class="muted">${esc(t('ui_file_list'))}</span></div>
      ${S.interior && arr(S.custom[S.interior.group]).length ? `<div class="f"><span>audio/${esc(safeName(S.interior.group))}_sounds.dat54.rel</span><span class="muted">${esc(t('ui_file_dat54'))}</span></div>
      <div class="f"><span>mas_${esc(safeName(S.interior.group))}/${esc(safeName(S.interior.group))}_sounds.awc</span><span class="muted">${esc(t('ui_file_awc', arr(S.custom[S.interior.group]).length))}</span></div>` : ''}`;
  },
  roomhash() {
    const r = S.interior.rooms[S.room];
    return `<div class="k">${esc(t('ui_room_key'))}</div><div class="v">${u32(r.roomKey)}</div><div class="v muted">${r.roomKey}</div>
      <div class="k">${esc(t('ui_name_hash'))}</div><div class="v">${u32(r.nameHash)}</div><div class="v muted">0x${hex(r.nameHash)}</div>`;
  },
};

const VIEWS = {};

/* Overview -------------------------------------------------------------- */

VIEWS.overview = () => {
  const i = S.interior;
  if (!i) {
    return `
      <h2>${esc(t('ui_outside_interior'))}</h2>
      <p class="lead">${esc(t('ui_outside_lead'))}</p>
      <div class="group stack">
        ${placeGroupField()}
      </div>
      <div class="cards2">
        <button class="card-link" data-tab="library">${icon('library', 22)}<b>${esc(t('ui_tab_library'))}</b><span>${esc(t('ui_card_library'))}</span></button>
        <button class="card-link" data-tab="placed">${icon('placed', 22)}<b>${esc(t('ui_tab_placed'))}</b><span>${esc(t('ui_card_placed', S.elements.length))}</span></button>
        <button class="card-link" data-tab="export">${icon('export', 22)}<b>${esc(t('ui_tab_export'))}</b><span>${esc(t('ui_card_export'))}</span></button>
        <button class="card-link" data-tab="entities">${icon('entities', 22)}<b>${esc(t('ui_tab_entities'))}</b><span>${esc(t('ui_card_entities'))}</span></button>
        <button class="card-link" data-tab="locations">${icon('locations', 22)}<b>${esc(t('ui_tab_locations'))}</b><span>${esc(t('ui_card_locations'))}</span></button>
      </div>`;
  }
  const override = i.proxyHashOverride != null && i.proxyHashOverride !== false && i.proxyHashOverride !== '';
  const o = i.output;
  return `
    <h2>${esc(t('ui_general_info'))}</h2>
    <p class="lead">${esc(t('ui_overview_lead'))}</p>

    <div class="stats" data-derived="stats">${DERIVED.stats()}</div>

    <h3>${esc(t('ui_project'))}</h3>
    <div class="group stack">
      <div class="grid2">
        ${textField('i:group', t('ui_group'), i.group, { mono: true, helpKey: 'group' })}
        ${textField('i:archetypeName', t('ui_archetype_name'), i.archetypeName, { placeholder: 'e.g. int_my_house', mono: true, helpKey: 'archetype' })}
      </div>
      <div class="grid2">
        ${textField('i:saveName', t('ui_save_name'), i.saveName, { mono: true, helpKey: 'save_name' })}
        <label class="field"><span class="lbl">${esc(t('ui_notes'))}</span>
          <textarea data-bind="i:notes" rows="1" placeholder="${esc(t('ui_notes_placeholder'))}">${esc(i.notes || '')}</textarea></label>
      </div>
      <div>
        <span class="lbl-plain">${esc(t('ui_generate_for'))}</span>
        <div class="row wrap" style="gap: 8px 18px; margin-top: 6px">
          ${check('i:output.rooms', t('ui_out_rooms'), o.rooms !== false, 'switch')}
          ${check('i:output.occlusion', t('ui_out_occlusion'), o.occlusion !== false, 'switch')}
          ${check('i:output.doors', t('ui_out_doors'), o.doors !== false, 'switch')}
        </div>
        ${help('outputs')}
      </div>
    </div>

    <h3>${esc(t('ui_import_title'))}</h3>
    <div class="group stack">
      <p class="small muted" style="margin: 0">${esc(t('ui_import_lead'))}</p>
      <div class="row">
        <select id="import-res" class="grow">${resourceOptions(i.group)}</select>
        <button class="btn" data-action="importFrom">${esc(t('ui_import_read'))}</button>
      </div>
    </div>

    <h3>${esc(t('ui_hashes'))}</h3>
    <div class="group">
      <div class="hashes" data-derived="hashes">${DERIVED.hashes()}</div>
      <div class="row" style="margin-top: 12px; align-items: flex-start">
        <div class="grow">${textField('i:proxyHashOverride', t('ui_proxy_override'), override ? i.proxyHashOverride : '', { placeholder: t('ui_proxy_override_placeholder'), mono: true, helpKey: 'proxy_override' })}</div>
        ${override ? `<button class="btn sm" data-action="resetProxy" style="margin-top: 22px">${esc(t('ui_reset'))}</button>` : ''}
      </div>
    </div>

    <h3>${esc(t('ui_interior_settings'))}</h3>
    <div class="group grid3">
      ${textField('i:settings.flags', t('ui_room_dat_flags'), i.settings.flags, { mono: true, helpKey: 'interior_flags', live: false })}
      ${textField('i:settings.wallaSoundSet', t('ui_walla'), i.settings.wallaSoundSet, { mono: true, helpKey: 'interior_walla', live: false })}
      ${textField('i:settings.reflections', t('ui_reflections'), i.settings.reflections, { mono: true, helpKey: 'interior_reflections', live: false })}
    </div>`;
};

function resourceOptions(prefer) {
  const list = S.resources || [];
  if (!S.resources) nui('resources').then((r) => { S.resources = arr(r && r.list); if (['overview', 'export'].includes(S.tab)) render(); });
  const guess = list.find((r) => r.toLowerCase() === String(prefer || '').toLowerCase()) || '';
  return `<option value="">${esc(t('ui_pick_resource'))}</option>` + list.map((r) => `<option ${r === guess ? 'selected' : ''}>${esc(r)}</option>`).join('');
}

function placeGroupField() {
  return `<div class="row" style="align-items: flex-end">
    <label class="field grow"><span class="lbl">${esc(t('ui_place_group'))}</span>
      <input type="text" id="place-group" class="mono" value="${esc(S.group)}" spellcheck="false"></label>
    <button class="btn" data-action="setGroup">${esc(t('ui_apply'))}</button>
  </div>${help('place_group')}`;
}

/* Rooms ---------------------------------------------------------------- */

const ROOM_GROUPS = [
  { title: 'ui_group_reverb', fields: ['reverbSmall', 'reverbMedium', 'reverbLarge'] },
  { title: 'ui_group_occlusion', fields: ['nonMarkedPortalOcclusion', 'exteriorAudibility', 'roomOcclusionDamping', 'distanceFromPortalForOcclusion', 'distanceFromPortalFadeDistance'] },
  { title: 'ui_group_advanced', advanced: true, fields: ['occlRoomName', 'flags', 'interiorType', 'rainType', 'interiorWallaSoundSet'] },
];

const FIELD_KEYS = {
  occlRoomName: 'ui_occl_name', flags: 'ui_room_dat_flags', ambientZone: 'ui_room_dat_ambient_zone', interiorType: 'ui_room_dat_interior_type',
  reverbSmall: 'ui_room_dat_reverb_small', reverbMedium: 'ui_room_dat_reverb_medium', reverbLarge: 'ui_room_dat_reverb_large',
  roomToneSound: 'ui_room_dat_room_tone_sound', rainType: 'ui_room_dat_rain_type', exteriorAudibility: 'ui_room_dat_exterior_audibility',
  roomOcclusionDamping: 'ui_room_dat_room_occlusion_damping', nonMarkedPortalOcclusion: 'ui_room_dat_nonmarked_portal_occlusion',
  distanceFromPortalForOcclusion: 'ui_room_dat_distance_from_portal_for_occlusion', distanceFromPortalFadeDistance: 'ui_room_dat_distance_from_portal_fade_distance',
  weaponMetrics: 'ui_room_dat_weapon_metrics', interiorWallaSoundSet: 'ui_room_dat_interior_walla_sound_set',
  weaponWetness: 'ui_weapon_wetness', weaponVisibility: 'ui_weapon_visibility', weaponLpf: 'ui_weapon_lpf',
  weaponPreDelay: 'ui_weapon_predelay', weaponHold: 'ui_weapon_hold',
};

function fieldSpec(key) {
  const f = arr(S.fields).find((x) => arr(x)[0] === key);
  const [, type, min, max] = f ? arr(f) : [key, 'string'];
  return { type, min, max };
}

function roomField(key, room) {
  const { type, min, max } = fieldSpec(key);
  const label = t(FIELD_KEYS[key]);
  const value = room.dat151[key];
  const bind = `r:${key}`;
  const o = { helpKey: key, live: false };
  if (type === 'float' && max <= 1) return sliderField(bind, label, value, { ...o, min, max });
  if (type === 'float') return numberField(bind, label, value, { ...o, min, max, step: 0.5 });
  if (type === 'int') return numberField(bind, label, value, { ...o, min, max });
  if (key === 'occlRoomName') {
    const prefix = S.analysis && S.analysis.archetypeMatch ? S.interior.archetypeName.toLowerCase() : hex(S.interior.nameHash);
    return textField(bind, label, value, { ...o, placeholder: `${prefix}_${room.name.toLowerCase()}`, mono: true });
  }
  return textField(bind, label, value, { ...o, mono: true });
}

const TONE_CATS = ['Room tones', 'HVAC & machinery', 'Electrical & tech', 'Appliances', 'Crowd & walla', 'Music', 'Water', 'Fire', 'Weather & creaks'];

function listeningTone() {
  return S.previews.find((p) => p.tone);
}

VIEWS.rooms = () => {
  const i = S.interior;
  const room = i.rooms[S.room] || i.rooms[0];
  const reach = (S.analysis && S.analysis.summary && S.analysis.summary.reach) || [];
  const filter = S.roomFilter.toLowerCase();

  const list = i.rooms.map((r, idx) => {
    if (filter && !r.name.toLowerCase().includes(filter) && String(idx) !== filter) return '';
    const tone = r.dat151 && r.dat151.roomToneSound && r.dat151.roomToneSound !== 'null_sound';
    return `<button class="roomitem ${idx === S.room ? 'active' : ''}" data-room="${idx}">
      <span class="idx">${idx}</span><span class="nm">${esc(idx === 0 ? t('ui_outside') : r.displayName || r.name)}</span>
      ${idx === S.hereRoom ? `<span class="here" title="${esc(t('ui_you_are_here'))}"></span>` : tone ? `<span class="tone-dot" title="${esc(t('ui_has_tone'))}"></span>` : '<span></span>'}</button>`;
  }).join('');

  let body;
  if (S.room === 0) {
    body = `<div class="group"><b>${esc(t('ui_outside'))}</b><p class="muted" style="margin: 6px 0 0; line-height: 1.5">${esc(t('ui_limbo_info'))}</p></div>`;
  } else {
    const preset = S.presets.find((p) => p.id === room.preset);
    const presetOpts = [`<option value="">${esc(t('ui_preset_custom'))}</option>`]
      .concat(S.presets.map((p) => `<option value="${esc(p.id)}" ${room.preset === p.id ? 'selected' : ''}>${esc(p.label)}</option>`)).join('');
    const d = reach[S.room];
    const tone = room.dat151.roomToneSound && room.dat151.roomToneSound !== 'null_sound' ? room.dat151.roomToneSound : '';
    const listening = listeningTone();

    body = `
      <div class="echo" id="echo">
        <svg viewBox="0 0 400 112" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="cap">${esc(room.displayName || room.name)}<small>${esc(preset ? preset.label : t('ui_preset_custom'))} · ${d > 0 ? esc(t('ui_hops_outside', d)) : d === 0 ? '' : esc(t('ui_unreachable'))}</small></div>
      </div>

      <div class="row" style="margin: 12px 0 4px">
        <select class="grow" id="preset-select" aria-label="${esc(t('ui_preset'))}">${presetOpts}</select>
        <button class="btn sm" data-action="applyPresetRoom">${esc(t('ui_apply'))}</button>
        <button class="btn sm" data-action="copyRoomDialog">${esc(t('ui_copy_to'))}</button>
        <button class="btn sm ghost" data-action="resetRoom">${esc(t('ui_reset'))}</button>
      </div>

      <h3>${esc(t('ui_room_tone'))}</h3>
      <div class="group">
        <div class="tone-wrap">
          <div class="row">
            <input type="text" id="tone-input" class="mono grow" value="${esc(tone)}" placeholder="${esc(t('ui_tone_search'))}" autocomplete="off" spellcheck="false">
            <button class="btn sm ${listening ? 'primary' : ''}" data-action="toneListen" ${tone ? '' : 'disabled'}>${icon(listening ? 'stop' : 'play', 13)} ${esc(listening ? t('ui_stop_listening') : t('ui_listen'))}</button>
            <button class="btn sm ghost" data-action="toneClear" ${tone ? '' : 'disabled'}>${esc(t('ui_none'))}</button>
          </div>
          <div class="picker" id="tone-picker" hidden></div>
        </div>
        ${help('roomToneSound', true)}
      </div>

      ${roomAmbience(room)}
      ${roomGunshots(room)}

      ${ROOM_GROUPS.map((g) => {
        const inner = `<div class="${g.advanced ? 'grid2' : 'stack'}">${g.fields.map((k) => roomField(k, room)).join('')}</div>`;
        if (g.advanced) return `<details class="adv"><summary>${esc(t(g.title))}</summary><div class="group">${inner}</div></details>`;
        return `<h3>${esc(t(g.title))}</h3><div class="group">${inner}</div>`;
      }).join('')}

      <details class="adv"><summary>${esc(t('ui_room_info'))}</summary>
        <div class="group hashes" data-derived="roomhash">${DERIVED.roomhash()}</div>
      </details>`;
  }

  return `
    <div class="row" style="margin-bottom: 12px">
      <h2 class="grow" style="margin: 0">${esc(t('ui_tab_rooms'))}</h2>
      <button class="btn sm ghost" data-action="goHere">${esc(t('ui_my_room'))}</button>
    </div>
    <div class="split">
      <div class="roomlist">
        <input type="text" id="room-filter" placeholder="${esc(t('ui_filter'))}" value="${esc(S.roomFilter)}" spellcheck="false">
        ${list}
      </div>
      <div>${body}</div>
    </div>`;
};

/* Ambient zone a room plays while you are inside it (InteriorRoom.AmbientZone). */
function roomAmbience(room) {
  const cur = room.dat151.ambientZone || '';
  const zones = S.elements.filter((e) => e.type === 'zone' && e.group === S.interior.group);
  const known = cur === '' || cur.startsWith('zone:') ? null : cur;
  const z = cur.startsWith('zone:') ? S.elements.find((e) => e.id === cur.slice(5)) : null;
  return `<h3>${esc(t('ui_room_ambience'))}</h3>
    <div class="group stack">
      <div class="row">
        <select class="grow" data-bind="r:ambientZone">
          <option value="">${esc(t('ui_none'))}</option>
          ${zones.map((e) => `<option value="zone:${esc(e.id)}" ${cur === 'zone:' + e.id ? 'selected' : ''}>${esc(e.label || e.id)} · ${esc(zoneSummary(e))}</option>`).join('')}
          ${known ? `<option value="${esc(known)}" selected>${esc(known)}</option>` : ''}
          ${cur.startsWith('zone:') && !z ? `<option value="${esc(cur)}" selected>${esc(t('ui_zone_missing'))}</option>` : ''}
        </select>
        ${z ? `<button class="btn sm" data-el="${esc(z.id)}" data-open-placed>${esc(t('ui_edit'))}</button>` : ''}
        <button class="btn sm ghost" data-action="newZoneForRoom">${esc(t('ui_new_zone'))}</button>
      </div>
      ${help('room_ambience', false)}
    </div>`;
}

/* Gunshot acoustics (InteriorWeaponMetrics): a vanilla preset or custom values. */
function roomGunshots(room) {
  const d = room.dat151;
  const cur = d.weaponMetrics || '';
  const list = arr(S.cat.amb.weaponMetrics);
  const opts = [`<option value="">${esc(t('ui_weapon_default'))}</option>`]
    .concat(list.map((n) => `<option value="${esc(n)}" ${cur.toLowerCase() === n ? 'selected' : ''}>${esc(pretty(n.replace(/^interior_weapon_/, '')))}</option>`))
    .concat([`<option value="custom" ${cur === 'custom' ? 'selected' : ''}>${esc(t('ui_weapon_custom'))}</option>`]);
  if (cur && cur !== 'custom' && !list.includes(cur.toLowerCase())) opts.push(`<option value="${esc(cur)}" selected>${esc(cur)}</option>`);
  const custom = cur === 'custom' ? `<div class="stack" style="margin-top: 8px">
      ${sliderField('r:weaponWetness', t('ui_weapon_wetness'), d.weaponWetness, { min: 0, max: 1, helpKey: 'weaponWetness', live: false })}
      ${sliderField('r:weaponVisibility', t('ui_weapon_visibility'), d.weaponVisibility, { min: 0, max: 1, helpKey: 'weaponVisibility', live: false })}
      <div class="grid3">
        ${numberField('r:weaponLpf', t('ui_weapon_lpf'), d.weaponLpf, { min: 100, max: 24000, step: 100, helpKey: 'weaponLpf', live: false })}
        ${numberField('r:weaponPreDelay', t('ui_weapon_predelay'), d.weaponPreDelay, { min: 0, max: 1000, step: 5, helpKey: 'weaponPreDelay', live: false })}
        ${numberField('r:weaponHold', t('ui_weapon_hold'), d.weaponHold, { min: 0, max: 10, step: 0.1, helpKey: 'weaponHold', live: false })}
      </div></div>` : '';
  return `<h3>${esc(t('ui_gunshots'))}</h3>
    <div class="group">
      <select data-bind="r:weaponMetrics">${opts.join('')}</select>
      ${help('weaponMetrics', false)}
      ${custom}
    </div>`;
}

/* Echo visual: an impulse followed by a decaying tail shaped by the three reverb sends. */
function drawEcho() {
  const svg = $('#echo svg');
  if (!svg || !S.interior) return;
  const r = S.interior.rooms[S.room];
  if (!r) return;
  const d = r.dat151;
  const small = Number(d.reverbSmall) || 0;
  const medium = Number(d.reverbMedium) || 0;
  const large = Number(d.reverbLarge) || 0;

  const W = 400, mid = 80, bars = 120;
  let seed = (S.room + 1) * 9301;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const tail = 0.06 + large * 0.9 + medium * 0.35 + small * 0.1;

  let path = '';
  for (let b = 0; b < bars; b++) {
    const x = 14 + (b / bars) * (W - 28);
    const p = b / bars;
    let amp = 0;
    if (p < 0.02) amp = 1;
    else {
      amp += small * 0.95 * Math.exp(-p / 0.09) * (rnd() > 0.4 ? 1 : 0.35);
      amp += medium * 0.6 * Math.exp(-p / (0.12 + medium * 0.2)) * (0.5 + rnd() * 0.5);
      amp += large * 0.5 * Math.exp(-p / Math.max(tail, 0.05)) * (0.4 + rnd() * 0.6);
    }
    const h = clamp(amp, 0, 1) * 26 + 0.6;
    path += `M${x.toFixed(1)} ${(mid - h).toFixed(1)}V${(mid + h * 0.55).toFixed(1)}`;
  }

  const occ = clamp(Number(d.nonMarkedPortalOcclusion) || 0, 0, 1);
  svg.innerHTML = `
    <defs><linearGradient id="eg" x1="0" x2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0.15"/></linearGradient></defs>
    <line x1="14" y1="${mid}" x2="${W - 8}" y2="${mid}" stroke="var(--line)" stroke-width="1"/>
    <path d="${path}" stroke="url(#eg)" stroke-width="2" stroke-linecap="round"/>
    <rect x="${W - 92}" y="14" width="80" height="4" rx="2" fill="var(--panel-3)"/>
    <rect x="${W - 92}" y="14" width="${(80 * occ).toFixed(1)}" height="4" rx="2" fill="var(--warn)"/>
    <text x="${W - 12}" y="30" text-anchor="end" fill="var(--ink-3)" font-size="9" font-family="Inter, sans-serif">${esc(t('ui_occlusion_short'))} ${Math.round(occ * 100)}%</text>`;
}


function bindTonePicker() {
  const input = $('#tone-input');
  const picker = $('#tone-picker');
  if (!input || !picker) return;
  const room = S.interior.rooms[S.room];
  const pool = () => customList().map((c) => ({ n: c.name, c: t('ui_custom_tag') + (c.loop ? '' : ' · ' + t('ui_one_shot')) }))
    .concat(S.cat.sounds.filter((x) => x.s === 'amb' && TONE_CATS.includes(x.c) && !isRemoved(x)));
  const show = () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rank = (x) => (x.c.startsWith(t('ui_custom_tag')) ? 0 : x.c === 'Room tones' ? 1 : 2);
    const hits = pool().filter((x) => words.every((w) => x.n.toLowerCase().includes(w) || x.c.toLowerCase().includes(w)))
      .sort((a, b) => rank(a) - rank(b)).slice(0, 40);
    picker.innerHTML = hits.length
      ? hits.map((x) => `<div class="pick" data-n="${esc(x.n)}"><span class="name">${esc(x.n)}</span><span class="tag">${esc(x.c)}</span><button class="btn icon sm" data-pp title="${esc(t('ui_play'))}">${icon('play', 12)}</button></div>`).join('')
      : `<div class="muted small" style="padding: 8px">${esc(S.cat.loaded ? t('ui_no_match') : t('ui_loading'))}</div>`;
    picker.hidden = false;
  };
  input.addEventListener('focus', show);
  input.addEventListener('input', () => {
    show();
    const v = input.value.trim();
    if (!v || S.cat.sounds.some((x) => x.n === v) || customByName(v)) setTone(v);
  });
  input.addEventListener('change', () => setTone(input.value.trim()));
  input.addEventListener('blur', () => setTimeout(() => { picker.hidden = true; }, 160));
  picker.addEventListener('mousedown', (ev) => {
    const row = ev.target.closest('.pick');
    if (!row) return;
    ev.preventDefault();
    if (ev.target.closest('[data-pp]')) {
      const c = customByName(row.dataset.n);
      startPreview(c ? { ...customTpl(c), sub: t('ui_room_tone') } : { type: 'sound', sound: { name: row.dataset.n, set: '' }, label: row.dataset.n, sub: t('ui_room_tone') });
      return;
    }
    input.value = row.dataset.n;
    setTone(row.dataset.n);
    picker.hidden = true;
    render();
  });

  function setTone(name) {
    room.dat151.roomToneSound = name || 'null_sound';
    markDirty();
    const l = listeningTone();
    if (l) { stopPreview(l.id); if (name) toneListen(); }
  }
}

async function toneListen() {
  const l = listeningTone();
  if (l) { await stopPreview(l.id); render(); return; }
  const room = S.interior.rooms[S.room];
  const name = room.dat151.roomToneSound;
  if (!name || name === 'null_sound') return;
  const c = customByName(name);
  const res = await nui('preview:start', { type: 'sound', sound: { name, set: '', bank: c ? c.bank : undefined, bankType: 'script' }, loop: true, label: c ? (c.label || c.key) : name, sub: `${t('ui_room_tone')} · ${room.name}` });
  if (res && res.id) {
    toneIds.add(res.id);
    // the "previews" message can arrive before this answer: mark the entry now so Listen turns into Stop
    S.previews = S.previews.map((p) => ({ ...p, tone: toneIds.has(p.id) }));
    if (S.tab === 'rooms') render();
  }
}
const toneIds = new Set();

/* Portals --------------------------------------------------------------- */

VIEWS.portals = () => {
  const i = S.interior;
  const dbg = S.debug;
  const filter = S.portalFilter;
  const portals = i.portals.map((p, idx) => ({ p, idx }))
    .filter(({ p }) => filter === '' || p.fromRoomIndex === Number(filter) || p.toRoomIndex === Number(filter));
  const roomOpts = [`<option value="">${esc(t('ui_all_rooms'))}</option>`]
    .concat(i.rooms.map((r, idx) => `<option value="${idx}" ${String(idx) === filter ? 'selected' : ''}>${idx}. ${esc(roomName(idx))}</option>`)).join('');

  return `
    <h2>${esc(t('ui_tab_portals'))}</h2>
    <p class="lead">${esc(t('ui_portals_lead'))}</p>
    <div class="notice">${icon('speaker', 16)}<span>${esc(t('ui_portals_live_note'))}</span></div>

    <div class="toolbar srow-list">
      <span class="muted small" style="width: 100%">${esc(t('ui_portal_debug'))}</span>
      <label class="switch srow"><input type="checkbox" id="occ-overlay" ${window.JDT_OVERLAY && window.JDT_OVERLAY.get().portals ? 'checked' : ''}><span>${esc(t('ui_portal_overlay_shared'))}</span></label>
      <label class="switch srow"><input type="checkbox" data-debug="entities" ${dbg.entities ? 'checked' : ''}><span>${esc(t('ui_debug_entities'))}</span></label>
          <button class="btn sm outline" style="align-self:flex-start;margin-top:8px" data-action="overlaySettings">${esc(t('ui_overlay_settings'))}</button>
    </div>

    <div class="toolbar">
      <span class="muted small" style="width: 100%">${esc(t('ui_bulk'))}</span>
      <button class="btn sm" data-action="enableAll">${esc(t('ui_enable_all'))}</button>
      <button class="btn sm" data-action="disableAll">${esc(t('ui_disable_all'))}</button>
      <button class="btn sm" data-action="autoDetect">${esc(t('ui_auto_detect'))}</button>
      <div class="row" style="gap: 6px">
        <select id="bulk-filter" style="width: auto">
          <option value="all">${esc(t('ui_bulk_all'))}</option><option value="doors">${esc(t('ui_bulk_doors'))}</option>
          <option value="glass">${esc(t('ui_bulk_glass'))}</option><option value="other">${esc(t('ui_bulk_other'))}</option>
        </select>
        <input type="number" id="bulk-value" min="0" max="1" step="0.05" value="0.7" style="width: 70px">
        <button class="btn sm" data-action="bulkOcclusion">${esc(t('ui_set_occlusion'))}</button>
      </div>
    </div>

    <div class="row" style="margin-bottom: 10px">
      <select id="portal-filter" class="grow">${roomOpts}</select>
      <button class="btn sm ghost" data-action="expandAll">${esc(t('ui_expand_all'))}</button>
    </div>

    ${portals.map(({ p, idx }) => portalCard(p, idx)).join('') || `<div class="list empty">${esc(t('ui_portal_alert'))}</div>`}`;
};

function portalCard(p, idx) {
  const open = !!S.expanded[idx];
  const sel = S.portal === idx;
  const both = p.isEnabled[0] && p.isEnabled[1];
  const none = !p.isEnabled[0] && !p.isEnabled[1];
  let chips = '';
  if (p.isMirror) chips += `<span class="chip">${esc(t('ui_mirror'))}</span>`;
  else if (none) chips += `<span class="chip bad">${esc(t('ui_disabled'))}</span>`;
  else if (!both) chips += `<span class="chip warn">${esc(t('ui_one_way'))}</span>`;
  if (p.isInteriorConnector) chips += `<span class="chip">${esc(t('ui_connector'))}</span>`;
  if (p.entities.length) chips += `<span class="chip accent">${p.entities.length} ${esc(t('ui_entities_short'))}</span>`;

  const nav = S.debug.navigate === idx;
  let body = '';
  if (open) {
    const ents = p.entities.length
      ? `<table class="ents"><thead><tr><th>${esc(t('ui_portal_entity_model'))}</th><th>${esc(t('ui_portal_entity_door'))}</th><th>${esc(t('ui_portal_entity_glass'))}</th><th style="width: 40%">${esc(t('ui_portal_entity_max_occl'))}</th><th></th></tr></thead><tbody>
        ${p.entities.map((e, ei) => `<tr>
          <td class="model" title="${esc(e.modelName)} (${u32(e.modelHashKey)})">${esc(e.modelName)}</td>
          <td><label class="check"><input type="checkbox" data-bind="e:${idx}:${ei}:isDoor" data-type="bool" ${e.isDoor ? 'checked' : ''}></label></td>
          <td><label class="check"><input type="checkbox" data-bind="e:${idx}:${ei}:isGlass" data-type="bool" ${e.isGlass ? 'checked' : ''}></label></td>
          <td><div class="slider"><input type="range" data-bind="e:${idx}:${ei}:maxOcclusion" data-type="num" min="0" max="1" step="0.05" value="${e.maxOcclusion}">
            <input type="number" data-bind="e:${idx}:${ei}:maxOcclusion" data-type="num" min="0" max="1" step="0.05" value="${+Number(e.maxOcclusion).toFixed(2)}"></div></td>
          <td><label class="switch" title="${esc(t('ui_outline_entity'))}"><input type="checkbox" data-dbg-entity="${idx}:${ei}" ${arr(S.debug.debugEntities).includes(`${idx}:${ei}`) ? 'checked' : ''}></label></td>
        </tr>`).join('')}</tbody></table>${help('portal_entity', false)}`
      : `<div class="muted small" style="padding: 4px 0">${esc(t('ui_portal_no_entities'))}</div>`;

    body = `<div class="portal-body">
      ${p.isMirror ? `<p class="muted small">${esc(t('ui_mirror_info'))}</p>` : `
      <div class="dirs">
        <label class="dir"><span class="t">${t('ui_hear_from', `<b>${esc(roomName(p.fromRoomIndex))}</b>`, `<b>${esc(roomName(p.toRoomIndex))}</b>`)}</span>
          <span class="switch"><input type="checkbox" data-bind="p:${idx}:0" data-type="bool" ${p.isEnabled[0] ? 'checked' : ''}></span></label>
        <label class="dir"><span class="t">${t('ui_hear_from', `<b>${esc(roomName(p.toRoomIndex))}</b>`, `<b>${esc(roomName(p.fromRoomIndex))}</b>`)}</span>
          <span class="switch"><input type="checkbox" data-bind="p:${idx}:1" data-type="bool" ${p.isEnabled[1] ? 'checked' : ''}></span></label>
      </div>${help('portal_direction', false)}`}
      ${ents}
      <div class="row wrap" style="margin-top: 10px">
        <button class="btn sm ${nav ? 'primary' : ''}" data-action="navigate" data-portal="${idx}">${esc(nav ? t('ui_stop_pointing') : t('ui_portal_debug_point'))}</button>
        ${S.ui.allowTeleport ? `<button class="btn sm" data-action="teleportPortal" data-portal="${idx}">${esc(t('ui_go_to'))}</button>` : ''}
        ${p.entities.length ? `<button class="btn sm ghost" data-action="autoDetectPortal" data-portal="${idx}">${esc(t('ui_auto_detect'))}</button>` : ''}
      </div>
    </div>`;
  }

  return `<div class="portal ${sel ? 'selected' : ''} ${p.isMirror ? 'mirror' : ''}" id="portal-${idx}">
    <div class="portal-head" data-toggle-portal="${idx}" role="button" tabindex="0" aria-expanded="${open}">
      <span class="pidx">#${idx}</span>
      <span class="route">${esc(roomName(p.fromRoomIndex))}<span class="arrow">${p.isMirror ? '◇' : '⇄'}</span>${esc(roomName(p.toRoomIndex))}</span>
      ${chips}
    </div>${body}</div>`;
}

/* Doors ----------------------------------------------------------------- */

const DG = (d) => `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square">${d}</svg>`;
const DOOR_GLYPH = {
  swing: DG('<path d="M4 18V2h9v16"/><path d="M13 2l4 2v14l-4-2"/><path d="M10.5 10h.01"/>'),
  sliding: DG('<path d="M2 4h16M2 16h16"/><path d="M4 6v8M16 6v8"/><path d="M7 10h6M7 10l2-2M7 10l2 2"/>'),
  vertical: DG('<path d="M3 3h14v14H3z"/><path d="M10 6v8M10 6l-2 2M10 6l2 2"/>'),
  garage: DG('<path d="M2 8l8-5 8 5v10H2z"/><path d="M5 11h10M5 14h10"/>'),
  gate: DG('<path d="M3 4v14M17 4v14M3 7h14M3 15h14"/><path d="M7 7v8M10 7v8M13 7v8"/>'),
  barrier: DG('<path d="M3 17V6"/><path d="M3 8l14-4"/><path d="M8 6.5v1.5M12 5.5v1.5"/><path d="M2 17h4"/>'),
};

function doorPresetSelect(key, cur) {
  const simple = S.doorSounds.map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
  const groups = {};
  S.cat.doorPresets.forEach((p) => { if (!S.doorSounds.some((x) => x.id === p.n)) (groups[p.g] = groups[p.g] || []).push(p); });
  const more = Object.keys(groups).sort().map((g) => `<optgroup label="${esc(g)}">${groups[g].map((p) => `<option value="${esc(p.n)}" ${p.n === cur ? 'selected' : ''}>${esc(p.l)}</option>`).join('')}</optgroup>`).join('');
  const unknown = cur && cur !== 'custom' && !S.doorSounds.some((x) => x.id === cur) && !S.cat.doorPresets.some((p) => p.n === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : '';
  return `<select data-door-preset="${esc(key)}"><option value="custom" ${cur === 'custom' ? 'selected' : ''}>${esc(t('ui_door_custom'))}</option>${unknown}<optgroup label="${esc(t('ui_door_common'))}">${simple}</optgroup>${more}</select>`;
}

/* Recorded sample of a door preset (samples/doors/<preset>.ogg|mp3|wav), played in the panel. */
let sampleAudio = null;
function sampleFile(id) { return id ? S.doorSamples[String(id).toLowerCase()] : null; }
function sampleButton(id) {
  const file = sampleFile(id);
  if (!file) return `<button class="btn icon sm ghost" disabled title="${esc(t('ui_no_sample'))}">♪</button>`;
  const on = S.samplePlaying === String(id).toLowerCase();
  return `<button class="btn icon sm ${on ? 'on' : ''}" data-sample="${esc(id)}" title="${esc(on ? t('ui_stop') : t('ui_play_sample'))}">${icon(on ? 'stop' : 'play', 12)}</button>`;
}
function toggleSample(id) {
  const key = String(id).toLowerCase();
  if (sampleAudio) { sampleAudio.pause(); sampleAudio = null; }
  if (S.samplePlaying === key) { S.samplePlaying = null; render(); return; }
  const file = sampleFile(id);
  if (!file) return;
  sampleAudio = new Audio(`../samples/doors/${encodeURIComponent(file)}`);
  sampleAudio.onended = () => { S.samplePlaying = null; sampleAudio = null; if (S.tab === 'doors' || S.tab === 'library') render(); };
  sampleAudio.play().catch(() => { S.samplePlaying = null; toast('warning', t('ui_sample_failed'), file); render(); });
  S.samplePlaying = key;
  render();
}

/* Custom door: own sound set + movement profile + how much sound gets through when it is closed. */
function doorCustomForm(key, d) {
  const c = d.custom || {};
  const sounds = arr(S.doorCustomSounds);
  const tunings = arr(S.doorTunings);
  const occ = c.maxOcclusion ?? 0.7;
  return `<div class="door-custom">
    <label class="field"><span class="lbl">${esc(t('ui_door_soundset'))}</span>
      <input type="text" class="mono" list="door-sets" data-door-custom="${esc(key)}:sounds" value="${esc(c.sounds || '')}" spellcheck="false">
      <datalist id="door-sets">${sounds.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('')}</datalist></label>
    <label class="field"><span class="lbl">${esc(t('ui_door_movement'))}</span>
      <select data-door-custom="${esc(key)}:tuning">${tunings.map((n) => `<option value="${esc(n)}" ${n === c.tuning ? 'selected' : ''}>${esc(pretty(n.replace(/^dtp_/, '')))}</option>`).join('')}
        ${c.tuning && !tunings.includes(c.tuning) ? `<option selected>${esc(c.tuning)}</option>` : ''}</select></label>
    <label class="field"><span class="lbl">${esc(t('ui_door_block'))} ${Math.round(occ * 100)}%</span>
      <input type="range" min="0" max="1" step="0.05" data-door-custom="${esc(key)}:maxOcclusion" value="${occ}"></label>
    ${help('door_custom', false)}
  </div>`;
}

VIEWS.doors = () => {
  const i = S.interior;
  const doors = Object.entries(obj(i.doors)).sort((a, b) => String(a[1].model).localeCompare(String(b[1].model)));
  const how = (d) => d.how ? `<span class="chip">${esc(t('ui_how_' + d.how))}</span>` : '';
  const rows = doors.map(([key, d]) => `
    <div class="door">
      <span class="door-glyph">${DOOR_GLYPH[d.kind] || DOOR_GLYPH.swing}</span>
      <div class="door-main">
        <b class="mono">${esc(d.model)}</b>
        <div class="row wrap" style="gap: 6px; margin-top: 4px">${how(d)}${S.doorSpots[key] ? '' : `<span class="chip warn">${esc(t('ui_door_not_here'))}</span>`}</div>
      </div>
      <div class="door-sound">${doorPresetSelect(key, d.preset)}</div>
      ${sampleButton(d.preset === 'custom' ? (d.custom && d.custom.sounds) : d.preset)}
      <button class="btn sm" data-door-test="${esc(key)}" ${S.doorSpots[key] ? '' : 'disabled'} title="${esc(t('ui_door_test_info'))}">${icon('play', 12)} ${esc(t('ui_door_test'))}</button>
      <button class="btn icon sm ghost" data-door-detect="${esc(key)}" ${S.doorSpots[key] ? '' : 'disabled'} title="${esc(t('ui_door_detect_info'))}">⟲</button>
      <button class="btn icon sm ghost danger" data-door-del="${esc(key)}" title="${esc(t('ui_door_remove'))}">${icon('close', 12)}</button>
      ${d.preset === 'custom' ? doorCustomForm(key, d) : ''}
    </div>`).join('');

  return `
    <h2>${esc(t('ui_tab_doors'))}</h2>
    <p class="lead">${esc(t('ui_doors_lead'))}</p>
    <div class="notice warn">${icon('speaker', 16)}<span>${esc(t('ui_doors_live_note'))}</span></div>
    <div class="row wrap" style="margin-bottom: 10px">
      <button class="btn sm" data-action="doorAimed">${esc(t('ui_door_add_aimed'))}</button>
      <button class="btn sm ghost" data-action="doorShelf">${icon('library', 14)} ${esc(t('ui_door_shelf'))}</button>
      <span class="grow"></span>
      ${check('i:output.doors', t('ui_out_doors'), i.output.doors !== false, 'switch')}
    </div>
    <div class="list">${rows || `<div class="empty">${esc(t('ui_no_doors'))}</div>`}</div>
    ${help('door_preset', false)}`;
};

/* Room names in one MLO usually share a long prefix (V_Michael_1_Bedroom, V_Michael_G_Kitchen ...).
   Labels drop that shared part so rooms can be told apart at a glance; the prefix is shown once. */
function roomNamePrefix(names) {
  const list = names.filter((n) => n && !/^limbo$/i.test(n));
  if (list.length < 2) return '';
  let pre = list[0];
  for (const n of list) { let k = 0; while (k < pre.length && k < n.length && pre[k].toLowerCase() === n[k].toLowerCase()) k++; pre = pre.slice(0, k); if (!pre) return ''; }
  const cut = Math.max(pre.lastIndexOf('_'), pre.lastIndexOf('-'), pre.lastIndexOf(' '));
  pre = cut >= 0 ? pre.slice(0, cut + 1) : '';
  return pre.length >= 3 && list.every((n) => n.length > pre.length + 1) ? pre : '';
}
function shortRoom(name, prefix) {
  return prefix && name && name.toLowerCase().startsWith(prefix.toLowerCase()) ? name.slice(prefix.length) : (name || '');
}

function layoutMap() {
  const i = S.interior;
  const W = 520, H = 380, pad = 46;
  const pos = {};
  const sums = {};

  i.portals.forEach((p) => {
    if (!p.centroid) return;
    [p.fromRoomIndex, p.toRoomIndex].forEach((r) => {
      if (r === 0) return;
      sums[r] = sums[r] || { x: 0, y: 0, n: 0 };
      sums[r].x += p.centroid.x; sums[r].y += p.centroid.y; sums[r].n++;
    });
  });

  const ids = i.rooms.map((r, idx) => idx).filter((idx) => idx !== 0);
  const geo = ids.filter((idx) => sums[idx]);

  if (geo.length >= Math.max(2, ids.length * 0.6)) {
    const pts = geo.map((idx) => ({ idx, x: sums[idx].x / sums[idx].n, y: sums[idx].y / sums[idx].n }));
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const sx = (W - pad * 2) / Math.max(maxX - minX, 1), sy = (H - pad * 2 - 40) / Math.max(maxY - minY, 1);
    const s = Math.min(sx, sy);
    const ox = (W - (maxX - minX) * s) / 2, oy = 40 + (H - 40 - (maxY - minY) * s) / 2;
    pts.forEach((p) => { pos[p.idx] = { x: ox + (p.x - minX) * s, y: oy + (maxY - p.y) * s }; });
  }

  // rooms without geometry go on a ring
  const rest = ids.filter((idx) => !pos[idx]);
  rest.forEach((idx, k) => {
    const a = (k / Math.max(rest.length, 1)) * Math.PI * 2 - Math.PI / 2;
    pos[idx] = { x: W / 2 + Math.cos(a) * (W / 2 - pad), y: H / 2 + 20 + Math.sin(a) * (H / 2 - pad - 20) };
  });

  // Force-directed relaxation seeded by the real geometry: keeps the rough floor plan,
  // but spreads rooms out so every room and portal stays readable.
  const links = [];
  i.portals.forEach((p) => { if (!p.isMirror && p.fromRoomIndex !== p.toRoomIndex) links.push([p.fromRoomIndex, p.toRoomIndex]); });
  pos[0] = { x: W / 2, y: 26 };
  const all = [0, ...ids];
  const k = Math.sqrt(((W - pad * 2) * (H - pad * 2)) / Math.max(all.length, 1)) * 0.9;
  for (let iter = 0; iter < 260; iter++) {
    const temp = 18 * (1 - iter / 260) + 0.5;
    const disp = {};
    all.forEach((a) => { disp[a] = { x: 0, y: 0 }; });
    all.forEach((a) => all.forEach((b) => {
      if (a >= b) return;
      let dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
      let d = Math.hypot(dx, dy);
      if (d < 0.01) { dx = Math.cos(a * 7 + b); dy = Math.sin(a * 3 + b); d = 1; }
      const f = (k * k) / d;
      disp[a].x += (dx / d) * f; disp[a].y += (dy / d) * f;
      disp[b].x -= (dx / d) * f; disp[b].y -= (dy / d) * f;
    }));
    links.forEach(([a, b]) => {
      const dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
      const d = Math.max(Math.hypot(dx, dy), 0.01);
      const f = (d * d) / k * (a === 0 || b === 0 ? 0.35 : 1);
      disp[a].x -= (dx / d) * f; disp[a].y -= (dy / d) * f;
      disp[b].x += (dx / d) * f; disp[b].y += (dy / d) * f;
    });
    ids.forEach((a) => {
      const d = Math.max(Math.hypot(disp[a].x, disp[a].y), 0.01);
      pos[a].x += (disp[a].x / d) * Math.min(d, temp);
      pos[a].y += (disp[a].y / d) * Math.min(d, temp);
      pos[a].y += 0.6; // gentle gravity away from Outside
      pos[a].x = clamp(pos[a].x, 34, W - 34); pos[a].y = clamp(pos[a].y, 70, H - 40);
    });
  }
  // labels are part of a room's footprint: push rooms apart until no box + label overlaps another,
  // and keep every label fully inside the frame
  const prefix = roomNamePrefix(i.rooms.map((r) => r.displayName || r.name));
  const half = {};
  all.forEach((idx) => {
    const label = idx === 0 ? t('ui_outside') : shortRoom(i.rooms[idx].displayName || i.rooms[idx].name, prefix);
    half[idx] = Math.max(16, Math.min(label.length, 16) * 3.3 + 6);
  });
  const fit = (idx) => {
    if (idx === 0) return;
    pos[idx].x = clamp(pos[idx].x, half[idx] + 4, W - half[idx] - 4);
    pos[idx].y = clamp(pos[idx].y, 64, H - 34);
  };
  ids.forEach(fit);
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) {
      const A = pos[all[a]], B = pos[all[b]];
      const ox = half[all[a]] + half[all[b]] + 6 - Math.abs(B.x - A.x);
      const oy = 44 - Math.abs(B.y - A.y);
      if (ox > 0 && oy > 0) {
        const fixedA = all[a] === 0, fixedB = all[b] === 0;
        const share = fixedA || fixedB ? 1 : 0.5;
        if (ox < oy) {
          const d = (B.x >= A.x ? 1 : -1) * ox * share;
          if (!fixedA) A.x -= d; if (!fixedB) B.x += d;
        } else {
          const d = (B.y >= A.y ? 1 : -1) * oy * share;
          if (!fixedA) A.y -= d; if (!fixedB) B.y += d;
        }
        moved = true;
      }
    }
    ids.forEach(fit);
    if (!moved) break;
  }

  return { pos, W, H, prefix };
}

VIEWS.map = () => {
  const i = S.interior;
  const { pos, W, H, prefix } = layoutMap();
  const reach = (S.analysis && S.analysis.summary && S.analysis.summary.reach) || [];
  const pairCount = {};

  const edges = i.portals.map((p, idx) => {
    if (p.isMirror) return '';
    const a = pos[p.fromRoomIndex], b = pos[p.toRoomIndex];
    if (!a || !b) return '';
    const key = [p.fromRoomIndex, p.toRoomIndex].sort().join('-');
    const n = (pairCount[key] = (pairCount[key] || 0) + 1) - 1;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    // several portals between the same two rooms fan out as curves instead of stacking
    const bend = (n === 0 ? 0 : (n % 2 ? -1 : 1) * Math.ceil(n / 2) * 16) * (p.fromRoomIndex > p.toRoomIndex ? -1 : 1);
    const cx = (a.x + b.x) / 2 + (-dy / len) * bend, cy = (a.y + b.y) / 2 + (dx / len) * bend;
    const cls = (!p.isEnabled[0] && !p.isEnabled[1]) ? 'off' : (!p.isEnabled[0] || !p.isEnabled[1]) ? 'oneway' : '';
    const d = `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    return `<g class="edge ${cls} ${S.portal === idx ? 'sel' : ''}" data-map-portal="${idx}"><title>#${idx} ${esc(roomName(p.fromRoomIndex))} ⇄ ${esc(roomName(p.toRoomIndex))}</title><path class="vis" d="${d}"/><path class="hit" d="${d}"/></g>`;
  }).join('');

  const linked = new Set();
  let broken = 0, oneway = 0;
  i.portals.forEach((p) => {
    if (p.fromRoomIndex >= i.rooms.length || p.toRoomIndex >= i.rooms.length || p.fromRoomIndex < 0 || p.toRoomIndex < 0) { broken++; return; }
    linked.add(p.fromRoomIndex); linked.add(p.toRoomIndex);
    if (!p.isMirror && p.isEnabled[0] !== p.isEnabled[1]) oneway++;
  });
  const orphans = i.rooms.map((r, idx) => idx).filter((idx) => idx !== 0 && !linked.has(idx));

  const nodes = i.rooms.map((r, idx) => {
    const p = pos[idx];
    const cls = [idx === 0 ? 'limbo' : '', idx === S.room ? 'sel' : '', idx === S.hereRoom ? 'here' : '', reach[idx] === -1 ? 'unreach' : '', orphans.includes(idx) ? 'orphan' : ''].join(' ');
    const full = idx === 0 ? t('ui_outside') : (r.displayName || r.name);
    const label = idx === 0 ? full : shortRoom(full, prefix);
    return `<g class="node ${cls}" data-map-room="${idx}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">
      <title>${idx}. ${esc(full)}</title>
      <rect class="box" x="${idx === 0 ? -16 : -13}" y="${idx === 0 ? -16 : -13}" width="${idx === 0 ? 32 : 26}" height="${idx === 0 ? 32 : 26}"/>
      <text y="${idx === 0 ? 4 : 28}">${esc(label.length > 16 ? label.slice(0, 15) + '…' : label)}</text>
      ${idx !== 0 && reach[idx] > 0 ? `<text class="d" y="3.5">${reach[idx]}</text>` : ''}
    </g>`;
  }).join('');

  return `
    <h2>${esc(t('ui_tab_map'))}</h2>
    <p class="lead">${esc(t('ui_map_lead'))}</p>
    <div class="map">${prefix ? `<span class="map-prefix">Room names start with <b class="mono">${esc(prefix)}</b></span>` : ''}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('ui_tab_map'))}">${edges}${nodes}</svg></div>
    <div class="legend">
      <span><i></i>${esc(t('ui_legend_both'))}</span><span><i class="ow"></i>${esc(t('ui_legend_oneway'))}</span>
      <span><i class="off"></i>${esc(t('ui_legend_off'))}</span><span><i class="orph"></i>${esc(t('ui_legend_orphan'))}</span><span class="muted">${esc(t('ui_legend_hops'))}</span>
    </div>
    <div class="row wrap" style="margin-top: 8px">
      <span class="chip">${esc(t('ui_map_rooms', i.rooms.length - 1))}</span>
      <span class="chip">${esc(t('ui_map_portals', i.portals.length))}</span>
      ${oneway ? `<span class="chip warn">${esc(t('ui_map_oneway', oneway))}</span>` : ''}
      ${orphans.length ? `<span class="chip bad" title="${esc(orphans.map((x) => roomName(x)).join(', '))}">${esc(t('ui_map_orphans', orphans.length))}</span>` : ''}
      ${broken ? `<span class="chip bad">${esc(t('ui_map_broken', broken))}</span>` : ''}
      ${!orphans.length && !broken ? `<span class="chip ok">${esc(t('ui_map_ok'))}</span>` : ''}
    </div>`;
};


/* Library ---------------------------------------------------------------- */

const LIB_TABS = ['sounds', 'custom', 'zones', 'emitters', 'radios', 'objects', 'mute', 'doorsounds'];
const AUDIO_PROP_RE = /speaker|boombox|ghettoblast|jukebox|radio|hifi|stereo|_tv_|tv_flat|tapeplayer|subwoof|amp_|dj_|turntable|mixer|megaphone|alarm|siren|bell/i;
const QUICK_PROPS = ['prop_boombox_01', 'prop_ghettoblast_02', 'prop_speaker_06', 'prop_speaker_01', 'ba_prop_battle_club_speaker_large', 'bkr_prop_clubhouse_jukebox_01a', 'prop_radio_01', 'prop_tv_flat_01'];
const SOUND_ORDER = ['Room tones', 'HVAC & machinery', 'Electrical & tech', 'Appliances', 'Crowd & walla', 'Music', 'Water', 'Fire', 'Alarms & bells', 'Doors & elevators', 'Construction & tools', 'Weather & creaks', 'Animals', 'Nature'];
const skey = (s) => ((s.r || '') + '|' + s.n).toLowerCase();
const isRemoved = (s) => S.check.bad.has(skey(s)) || S.check.hidden.has(skey(s));

function countBy(list, fn) {
  const m = new Map();
  list.forEach((x) => { const k = fn(x); m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()];
}

function chips(cats, current, attr) {
  return `<div class="chips">
    <button class="chip-btn ${!current ? 'on' : ''}" data-${attr}="">${esc(t('ui_all'))}</button>
    ${cats.map(([c, n]) => `<button class="chip-btn ${current === c ? 'on' : ''}" data-${attr}="${esc(c)}">${esc(c)} <span>${n}</span></button>`).join('')}
  </div>`;
}

function playBtn(attrs) {
  return `<button class="btn icon sm play" ${attrs} title="${esc(t('ui_play'))}">${icon('play', 12)}</button>`;
}

VIEWS.library = () => {
  if (!S.cat.loaded) return `<div class="empty">${esc(t('ui_loading'))}</div>`;
  const tabs = LIB_TABS.map((k) => `<button class="${S.lib === k ? 'active' : ''}" data-lib="${k}">${esc(t('ui_lib_' + k))}</button>`).join('');
  return `
    <div class="row" style="margin-bottom: 8px">
      <h2 class="grow" style="margin: 0">${esc(t('ui_tab_library'))}</h2>
      <span class="chip accent">${esc(t('ui_group'))}: ${esc(S.group)}</span>
    </div>
    <div class="subtabs">${tabs}</div>
    <p class="lead small">${esc(t('ui_lib_lead_' + S.lib))}</p>
    ${LIB[S.lib]()}
    ${S.sel ? detailPanel(S.sel, false) : ''}`;
};

const LIB = {};

function moreButton(total) {
  return total > S.limit ? `<button class="btn sm ghost more" data-action="more">${esc(t('ui_show_more', total - S.limit))}</button>` : '';
}

LIB.sounds = () => {
  const vis = S.cat.sounds.map((s, i) => ({ s, i })).filter(({ s }) => S.showRemoved || !isRemoved(s));
  const cats = countBy(vis.map((x) => x.s), (x) => x.c).sort((a, b) => {
    const ia = SOUND_ORDER.indexOf(a[0]), ib = SOUND_ORDER.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b[1] - a[1];
  });
  const q = S.q.sounds.toLowerCase();
  const items = vis.filter(({ s }) => (!S.q.scat || s.c === S.q.scat) && (!S.q.src || s.s === S.q.src) &&
    (!q || s.n.toLowerCase().includes(q) || (s.r || '').toLowerCase().includes(q)));
  const rows = items.slice(0, S.limit).map(({ s, i }) => {
    const removed = isRemoved(s), k = skey(s);
    const sel = S.sel && S.sel.type === 'sound' && S.sel.sound.name === s.n && (S.sel.sound.set || '') === (s.r || '');
    return `<div class="lrow ${removed ? 'removed' : ''} ${sel ? 'sel' : ''}" data-snd="${i}">
      ${playBtn(`data-snd-play="${i}"`)}
      <div class="main"><div class="name">${esc(s.n)}${s.v ? `<span class="tag">${s.v} ${esc(t('ui_variants'))}</span>` : ''}${S.failed.has((s.r || '') + '|' + s.n) ? `<span class="tag bad">${esc(t('ui_didnt_play'))}</span>` : ''}${S.check.bad.has(k) ? `<span class="tag bad">${esc(t('ui_unplayable'))}</span>` : ''}</div>
        <div class="sub">${s.s === 'amb' ? esc(t('ui_ambience_loop')) : esc(s.r || t('ui_no_soundset'))} · ${esc(s.c)}</div></div>
      ${S.check.hidden.has(k) ? `<button class="btn icon sm ghost" data-snd-unhide="${i}" title="${esc(t('ui_put_back'))}">↺</button>` : `<button class="btn icon sm ghost" data-snd-hide="${i}" title="${esc(t('ui_hide_sound'))}">${icon('close', 11)}</button>`}
    </div>`;
  }).join('');
  return `
    <div id="banner">${checkBanner()}</div>
    ${chips(cats, S.q.scat, 'scat')}
    <div class="row filters">
      <input type="text" id="q-sounds" class="grow" placeholder="${esc(t('ui_search_sounds'))}" value="${esc(S.q.sounds)}" spellcheck="false">
      <select id="q-src" style="width: auto">
        <option value="">${esc(t('ui_all_sources'))}</option>
        <option value="amb" ${S.q.src === 'amb' ? 'selected' : ''}>${esc(t('ui_ambience_loops'))}</option>
        <option value="set" ${S.q.src === 'set' ? 'selected' : ''}>${esc(t('ui_soundsets'))}</option>
      </select>
    </div>
    <div class="count">${esc(t('ui_count_sounds', items.length))}</div>
    <div class="llist">${rows || `<div class="empty">${esc(t('ui_no_match'))}</div>`}</div>
    ${moreButton(items.length)}
    <div class="custom row">
      <input type="text" id="c-name" class="grow mono" placeholder="${esc(t('ui_custom_sound'))}">
      <input type="text" id="c-set" class="grow mono" placeholder="${esc(t('ui_custom_set'))}">
      <button class="btn sm" data-action="customSound">${esc(t('ui_use'))}</button>
    </div>`;
};

function checkBanner() {
  if (S.scan) {
    const pct = Math.round(100 * S.scan.done / Math.max(1, S.scan.total));
    return `<div class="notice scan"><div class="grow"><b>${esc(t('ui_scan_running', S.scan.done, S.scan.total))}</b> · ${esc(t('ui_scan_bad', S.scan.bad))}
      <div class="bar"><span style="width: ${pct}%"></span></div><span class="small muted">${esc(t('ui_scan_tip'))}</span></div>
      <button class="btn sm" data-action="scanStop">${esc(t('ui_stop'))}</button></div>`;
  }
  if (!S.check.at) {
    return `<div class="notice warn"><div class="grow"><b>${esc(t('ui_scan_once'))}</b> ${esc(t('ui_scan_once_text'))}
      <div class="row" style="margin-top: 8px"><button class="btn primary sm" data-scan="all">${esc(t('ui_scan_all'))}</button>${S.q.scat ? `<button class="btn sm" data-scan="cat">${esc(t('ui_scan_cat', S.q.scat))}</button>` : ''}</div></div></div>`;
  }
  const removed = S.check.bad.size + S.check.hidden.size;
  return `<div class="notice"><div class="grow">${esc(t('ui_scan_done_at', S.check.at, removed))}
    <span class="links"> <a data-scan="all">${esc(t('ui_scan_again'))}</a>${S.q.scat ? ` · <a data-scan="cat">${esc(t('ui_scan_cat', S.q.scat))}</a>` : ''} · <a data-action="toggleRemoved">${esc(S.showRemoved ? t('ui_hide_removed') : t('ui_show_removed'))}</a> · <a data-action="scanReset">${esc(t('ui_scan_reset'))}</a></span></div></div>`;
}

function usedEmitters() {
  return new Set(S.elements.flatMap((e) => [e.ambient && e.ambient.emitter, e.radio && e.radio.emitter, e.static && e.static.name]).filter(Boolean).map((n) => n.toLowerCase()));
}

LIB.emitters = () => {
  const cats = countBy(S.cat.statics, (n) => n.c);
  const q = S.q.emitters.toLowerCase();
  const used = usedEmitters();
  const items = S.cat.statics.filter((n) => (!S.q.ecat || n.c === S.q.ecat) &&
    (!q || n.n.toLowerCase().includes(q) || (n.i || '').toLowerCase().includes(q) || (n.rs || '').toLowerCase().includes(q) || (n.a || '').toLowerCase().includes(q)))
    .sort((a, b) => (!!a.i - !!b.i) || a.n.localeCompare(b.n));
  const rows = items.slice(0, S.limit).map((n) => {
    const sel = S.sel && S.sel.type === 'ambient' && S.sel.ambient.emitter === n.n;
    return `<div class="lrow ${sel ? 'sel' : ''}" data-emi="${esc(n.n)}">
      ${playBtn(`data-emi-play="${esc(n.n)}"`)}
      <div class="main"><div class="name">${esc(pretty(n.n))}<span class="tag">${esc(n.c)}</span>${n.i ? `<span class="tag">${esc(t('ui_interior_bound'))}</span>` : ''}${used.has(n.n.toLowerCase()) ? `<span class="tag bad">${esc(t('ui_in_use'))}</span>` : ''}</div>
        <div class="sub mono">${esc([n.n, n.rs && '📻 ' + n.rs, n.a && '🚨 ' + n.a].filter(Boolean).join(' · '))}</div></div>
    </div>`;
  }).join('');
  return `
    ${chips(cats, S.q.ecat, 'ecat')}
    <div class="row filters"><input type="text" id="q-emitters" class="grow" placeholder="${esc(t('ui_search_emitters'))}" value="${esc(S.q.emitters)}" spellcheck="false"></div>
    <div class="count">${esc(t('ui_count_emitters', items.length))}</div>
    <div class="llist">${rows || `<div class="empty">${esc(t('ui_no_match'))}</div>`}</div>
    ${moreButton(items.length)}
    <div class="custom row">
      <input type="text" id="c-emitter" class="grow mono" placeholder="${esc(t('ui_custom_emitter'))}">
      <button class="btn sm" data-action="customEmitter">${esc(t('ui_use'))}</button>
    </div>`;
};

LIB.radios = () => {
  const q = S.q.radios.toLowerCase();
  const items = S.cat.radios.filter((r) => (S.q.hiddenRadios || !r.h) && (!q || r.n.toLowerCase().includes(q) || r.l.toLowerCase().includes(q)));
  const rows = items.map((r) => {
    const sel = S.sel && S.sel.type === 'radio' && S.sel.radio.station === r.n;
    return `<div class="lrow ${sel ? 'sel' : ''}" data-radio="${esc(r.n)}">
      ${playBtn(`data-radio-play="${esc(r.n)}"`)}
      <div class="main"><div class="name">${esc(r.l)}${r.h ? `<span class="tag">${esc(t('ui_hidden_station'))}</span>` : ''}</div><div class="sub mono">${esc(r.n)}</div></div>
    </div>`;
  }).join('');
  return `
    <div class="row filters">
      <input type="text" id="q-radios" class="grow" placeholder="${esc(t('ui_search_radios'))}" value="${esc(S.q.radios)}" spellcheck="false">
      <label class="check"><input type="checkbox" id="q-hidden-radios" ${S.q.hiddenRadios ? 'checked' : ''}><span>${esc(t('ui_hidden_stations'))}</span></label>
    </div>
    <div class="count">${esc(t('ui_count_radios', items.length))}</div>
    <div class="llist">${rows || `<div class="empty">${esc(t('ui_no_match'))}</div>`}</div>
    <div class="custom row">
      <input type="text" id="c-station" class="grow mono" placeholder="${esc(t('ui_custom_station'))}">
      <button class="btn sm" data-action="customStation">${esc(t('ui_use'))}</button>
    </div>`;
};

LIB.objects = () => {
  const q = S.q.objects.toLowerCase();
  const items = S.cat.objects.filter((o) => (!S.q.audioOnly || AUDIO_PROP_RE.test(o)) && (!q || o.toLowerCase().includes(q)));
  const rows = items.slice(0, S.limit).map((o) => {
    const sel = S.sel && S.sel.type === 'prop' && S.sel.prop.model === o;
    return `<div class="lrow ${sel ? 'sel' : ''}" data-obj="${esc(o)}"><span class="dot prop"></span><div class="main"><div class="name mono">${esc(o)}</div></div></div>`;
  }).join('');
  return `
    <div class="row filters">
      <input type="text" id="q-objects" class="grow" placeholder="${esc(t('ui_search_objects'))}" value="${esc(S.q.objects)}" spellcheck="false">
      <label class="check"><input type="checkbox" id="q-audio-only" ${S.q.audioOnly ? 'checked' : ''}><span>${esc(t('ui_audio_props'))}</span></label>
    </div>
    <div class="count">${esc(t('ui_count_objects', items.length))}</div>
    <div class="llist">${rows || `<div class="empty">${esc(t('ui_no_match'))}</div>`}</div>
    ${moreButton(items.length)}
    <div class="custom row">
      <input type="text" id="c-object" class="grow mono" placeholder="${esc(t('ui_custom_object'))}">
      <button class="btn sm" data-action="customObject">${esc(t('ui_use'))}</button>
    </div>`;
};

LIB.mute = () => {
  const q = S.q.mute.toLowerCase();
  const items = S.cat.statics.filter((n) => !q || n.n.toLowerCase().includes(q) || (n.i || '').toLowerCase().includes(q) || (n.rs || '').toLowerCase().includes(q));
  const rows = items.slice(0, S.limit).map((n) => {
    const sel = S.sel && S.sel.type === 'static' && S.sel.static.name === n.n;
    return `<div class="lrow ${sel ? 'sel' : ''}" data-mute="${esc(n.n)}">
      ${playBtn(`data-mute-play="${esc(n.n)}"`)}
      <div class="main"><div class="name mono">${esc(n.n)}${n.on ? '' : `<span class="tag">${esc(t('ui_off_by_default'))}</span>`}</div>
        <div class="sub">${esc([n.rs && '📻 ' + n.rs, n.i, n.a && '🚨 ' + n.a].filter(Boolean).join(' · ') || '–')}</div></div>
    </div>`;
  }).join('');
  return `
    <div class="row filters"><input type="text" id="q-mute" class="grow" placeholder="${esc(t('ui_search_emitters'))}" value="${esc(S.q.mute)}" spellcheck="false"></div>
    <div class="count">${esc(t('ui_count_emitters', items.length))}</div>
    <div class="llist">${rows || `<div class="empty">${esc(t('ui_no_match'))}</div>`}</div>
    ${moreButton(items.length)}`;
};

LIB.doorsounds = () => {
  const q = S.q.doors.toLowerCase();
  const items = S.cat.sounds.map((s, i) => ({ s, i })).filter(({ s }) => s.c === 'Doors & elevators' && (!q || s.n.toLowerCase().includes(q) || (s.r || '').toLowerCase().includes(q)));
  const rows = items.map(({ s, i }) => `<div class="lrow" data-snd="${i}">
      ${playBtn(`data-snd-play="${i}"`)}
      <div class="main"><div class="name">${esc(s.n)}</div><div class="sub">${esc(s.r || t('ui_no_soundset'))}</div></div>
    </div>`).join('');
  return `
    <div class="row filters"><input type="text" id="q-doors" class="grow" placeholder="${esc(t('ui_search_door_sounds'))}" value="${esc(S.q.doors)}" spellcheck="false"></div>
    <div class="count">${esc(t('ui_count_sounds', items.length))}</div>
    <div class="llist">${rows}</div>`;
};

/* Custom sounds ----------------------------------------------------------- */

function customGroup() { return (S.interior && S.interior.group) || S.group; }

LIB.custom = () => {
  const groups = Object.keys(obj(S.custom)).sort();
  const target = S.uploadGroup || customGroup();
  const q = S.q.custom.toLowerCase();
  const up = S.upload;
  const cfg = S.soundsCfg;
  const rows = groups.map((g) => {
    const list = arr(S.custom[g]).filter((c) => !q || c.key.includes(q) || String(c.label || '').toLowerCase().includes(q));
    if (!list.length) return '';
    return `<div class="cgroup"><div class="cg-head mono">${esc(g)}<span class="muted small"> · ${list.length}</span></div>
      ${list.map((c) => {
        const sel = S.csel && S.csel.group === g && S.csel.key === c.key;
        return `<div class="lrow ${sel ? 'sel' : ''}" data-cs="${esc(g)}/${esc(c.key)}">
          ${playBtn(`data-cs-play="${esc(g)}/${esc(c.key)}"`)}
          <div class="main"><div class="name">${esc(c.label || c.key)}${c.loop ? `<span class="tag">${esc(t('ui_loop'))}</span>` : ''}${c.inGame ? `<span class="tag ok">${esc(t('ui_in_game'))}</span>` : `<span class="tag warn">${esc(t('ui_needs_export'))}</span>`}</div>
            <div class="sub mono">${esc(c.name)} · ${esc(fmtSec(c.seconds))}${c.volume ? ` · ${c.volume > 0 ? '+' : ''}${c.volume} dB` : ''}</div></div>
        </div>`;
      }).join('')}</div>`;
  }).join('');
  return `
    <label class="drop ${up ? 'busy' : ''}" id="drop">
      <input type="file" id="cs-file" accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.opus,.webm" multiple hidden>
      ${up ? `<b>${esc(t('ui_uploading', up.name))}</b><div class="bar"><span style="width: ${Math.round(100 * up.done / Math.max(1, up.total))}%"></span></div>`
        : `<b>${esc(t('ui_drop_title'))}</b><span>${esc(t('ui_drop_text', cfg.maxUploadMB))}</span>`}
    </label>
    <div class="grid3" style="margin: 10px 0">
      <label class="field"><span class="lbl">${esc(t('ui_upload_group'))}</span><input type="text" id="cs-group" class="mono" value="${esc(target)}" spellcheck="false"></label>
      <label class="field"><span class="lbl">${esc(t('ui_sample_rate'))}</span><select id="cs-rate">${[22050, 32000, 44100, 48000].map((r) => `<option value="${r}" ${Number(S.uploadRate || cfg.sampleRate) === r ? 'selected' : ''}>${r} Hz</option>`).join('')}</select></label>
      <label class="check" style="align-self: end; margin-bottom: 8px"><input type="checkbox" id="cs-loop" ${S.uploadLoop ? 'checked' : ''}><span>${esc(t('ui_upload_loop'))}</span></label>
    </div>
    ${help('custom_upload')}
    <div class="row filters" style="margin-top: 10px">
      <input type="text" id="q-custom" class="grow" placeholder="${esc(t('ui_filter'))}" value="${esc(S.q.custom)}" spellcheck="false">
      <button class="btn sm" data-action="soundRescan">${esc(t('ui_rescan_folder'))}</button>
    </div>
    <div class="llist">${rows || `<div class="empty">${esc(t('ui_no_custom'))}</div>`}</div>
    ${S.csel ? customDetail() : ''}`;
};

function customDetail() {
  const c = arr(S.custom[S.csel.group]).find((x) => x.key === S.csel.key);
  if (!c) return '';
  const cats = arr(S.cat.amb.categories);
  const cat = c.category || 'scripted';
  return `<div class="detail" id="cdetail">
    <div class="d-head"><span class="dot custom"></span>
      <div class="grow"><b>${esc(c.label || c.key)}</b><div class="muted small mono">${esc(c.name)} · ${esc(c.group)}</div></div>
      <span class="chip ${c.inGame ? 'ok' : 'warn'}">${esc(c.inGame ? t('ui_in_game') : t('ui_needs_export'))}</span>
      <button class="btn icon sm ghost" data-action="closeCustom" title="${esc(t('ui_close'))}">${icon('close', 12)}</button>
    </div>
    <canvas class="wave" id="cs-wave" width="560" height="64"></canvas>
    <div class="muted small" style="margin: -4px 0 8px">${esc(fmtSec(c.seconds))} · ${esc(t('ui_file_size', Math.round((c.bytes || 0) / 1024)))}${c.rate ? ' · ' + c.rate + ' Hz' : ''}</div>
    <div class="grid2 dform" id="cs-form">
      <label class="field"><span class="lbl">${esc(t('ui_label'))}</span><input type="text" data-cf="label" value="${esc(c.label || '')}"></label>
      <label class="field"><span class="lbl">${esc(t('ui_volume_db'))}</span><input type="number" data-cf="volume" min="-40" max="24" step="1" value="${c.volume || 0}"></label>
      <label class="check full"><input type="checkbox" data-cf="loop" ${c.loop ? 'checked' : ''}><span>${esc(t('ui_loop_sound'))}</span></label>
      <div class="full">${help('custom_loop', false)}</div>
      <label class="field"><span class="lbl">${esc(t('ui_category'))}</span><select data-cf="category">${['scripted', 'ambience_general', 'ambience_music', 'ambience_industrial', 'ambience_speech', ...cats.filter((x) => !['scripted', 'ambience_general', 'ambience_music', 'ambience_industrial', 'ambience_speech'].includes(x))].map((x) => `<option ${x === cat ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label class="field"><span class="lbl">${esc(t('ui_codec'))}</span><select data-cf="codec"><option value="adpcm" ${c.codec !== 'pcm' ? 'selected' : ''}>ADPCM (${esc(t('ui_smaller'))})</option><option value="pcm" ${c.codec === 'pcm' ? 'selected' : ''}>PCM (${esc(t('ui_lossless'))})</option></select></label>
      <label class="field"><span class="lbl">${esc(t('ui_sample_rate'))}</span><select data-cf="rate"><option value="0">${esc(t('ui_keep_rate'))}</option>${[22050, 32000, 44100, 48000].map((r) => `<option value="${r}" ${Number(c.rate) === r ? 'selected' : ''}>${r} Hz</option>`).join('')}</select></label>
      <label class="check" style="align-self: end; margin-bottom: 8px"><input type="checkbox" data-cf="normalize" ${c.normalize ? 'checked' : ''}><span>${esc(t('ui_normalize'))}</span></label>
      <div class="full">${help('custom_settings', false)}</div>
    </div>
    <div class="row wrap actions">
      <button class="btn" data-action="customPlay">${icon('play', 13)} ${esc(t('ui_preview'))}</button>
      <button class="btn" data-action="customPlace">${esc(t('ui_place_as_sound'))}</button>
      ${S.interior && S.room > 0 ? `<button class="btn" data-action="customTone">${esc(t('ui_use_as_tone', roomName(S.room)))}</button>` : ''}
      <button class="btn" data-action="customZone">${esc(t('ui_new_zone_with'))}</button>
      <button class="btn danger" data-action="customDelete">${esc(t('ui_delete'))}</button>
      <span class="grow"></span>
      <button class="btn primary" data-action="customSave">${esc(t('ui_save'))}</button>
    </div>
    <div class="hint">${esc(t('ui_custom_script_hint', c.bank, c.key, c.set))}</div>
  </div>`;
}

async function drawCustomWave() {
  const cv = $('#cs-wave');
  if (!cv || !S.csel || !window.JDT_AUDIO) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  let buf;
  try { buf = await window.JDT_AUDIO.getBuffer(S.csel.group, S.csel.key); } catch (e) { return; }
  if (!$('#cs-wave')) return;
  const peaks = window.JDT_AUDIO.waveform(buf, W);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || DEFAULT_ACCENT;
  g.fillStyle = accent;
  peaks.forEach(([lo, hi], x) => {
    const y0 = (1 - hi) * H / 2, y1 = (1 - lo) * H / 2;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  });
}

/* Sound data for the panel (previews, waveform, 3D playback) comes from the server in chunks. */
const fetches = {};
function fetchSound(group, key) {
  return nui('sound:fetch', { group, key }).then((r) => {
    if (!r || !r.ok) throw new Error((r && r.error) || 'fetch failed');
    return new Promise((resolve, reject) => {
      fetches[r.requestId] = { parts: [], count: r.count, resolve, reject };
      setTimeout(() => { if (fetches[r.requestId]) { delete fetches[r.requestId]; reject(new Error('timeout')); } }, 60000);
    });
  });
}
if (window.JDT_AUDIO) {
  window.JDT_AUDIO.setFetcher(fetchSound);
  window.JDT_AUDIO.setOnEnded((id) => nui('voice:ended', { id }));
}

async function uploadFiles(files) {
  if (!window.JDT_AUDIO || !files || !files.length) return;
  const group = (($('#cs-group') && $('#cs-group').value) || customGroup()).trim();
  const rate = Number(($('#cs-rate') && $('#cs-rate').value) || S.soundsCfg.sampleRate);
  const loop = !!($('#cs-loop') && $('#cs-loop').checked);
  S.uploadGroup = group; S.uploadRate = rate; S.uploadLoop = loop;
  for (const file of files) {
    S.upload = { name: file.name, done: 0, total: 1 };
    render();
    let conv;
    try { conv = await window.JDT_AUDIO.convertFile(file, rate); } catch (e) {
      toast('error', t('ui_cant_decode'), file.name);
      continue;
    }
    if (conv.wav.length > S.soundsCfg.maxUploadMB * 1048576) { toast('error', t('ui_too_big', S.soundsCfg.maxUploadMB), file.name); continue; }
    const b64 = window.JDT_AUDIO.toBase64(conv.wav);
    const size = 240000;
    const count = Math.ceil(b64.length / size);
    const uploadId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    S.upload = { name: file.name, done: 0, total: count };
    let res = null;
    for (let i = 0; i < count; i++) {
      res = await nui('sound:chunk', {
        uploadId, index: i + 1, count, data: b64.slice(i * size, (i + 1) * size),
        info: i === 0 ? { group, name: file.name, loop, rate: 0, normalize: S.soundsCfg.normalize, codec: S.soundsCfg.codec, category: S.soundsCfg.category } : undefined,
      });
      if (!res || res.ok === false) break;
      S.upload.done = i + 1;
      const dz = $('#drop .bar span');
      if (dz) dz.style.width = `${Math.round(100 * S.upload.done / count)}%`;
    }
    if (res && res.ok && res.done) {
      window.JDT_AUDIO.putBuffer(res.group, res.key, conv.buffer);
      S.csel = { group: res.group, key: res.key };
      if (conv.peak < 0.2) toast('info', t('ui_quiet_file'), file.name);
    }
  }
  S.upload = null;
  render();
}

/* Ambient zones ------------------------------------------------------------ */

function zoneSummary(e) {
  const z = e.zone || {};
  const size = z.shape === 'sphere' ? `⌀ ${(2 * (z.radius || 0)).toFixed(0)} m` : `${(z.width || 0).toFixed(0)}×${(z.length || 0).toFixed(0)}×${(z.height || 0).toFixed(0)} m`;
  return `${size} · ${t('ui_zone_rules_n', arr(z.rules).length + arr(z.vanillaRules).length)}`;
}

function newZoneTpl(shape, rules) {
  return {
    type: 'zone', label: '',
    zone: { shape: shape || 'box', width: 12, length: 12, height: 5, radius: 8, rotation: 0, fade: 5, rulesToPlay: 4, rules: rules || [], vanillaRules: [], dirAmbiences: [] },
  };
}

function ruleFromSound(name, loop) {
  return { sound: name, category: 'ambience_general', weight: 1, minDist: 0, maxDist: 25, from: 0, to: 24, every: loop ? 0 : 12, variance: loop ? 0 : 8, occlusion: true, stopOnLeave: true };
}

LIB.zones = () => {
  const q = S.q.zrules.toLowerCase();
  const rules = arr(S.cat.amb.rules).filter((n) => !q || n.includes(q)).slice(0, S.limit);
  const total = arr(S.cat.amb.rules).filter((n) => !q || n.includes(q)).length;
  return `
    <div class="cards2">
      <button class="card-link" data-action="newZoneBox"><span class="zone-ico box"></span><b>${esc(t('ui_zone_box'))}</b><span>${esc(t('ui_zone_box_info'))}</span></button>
      <button class="card-link" data-action="newZoneSphere"><span class="zone-ico sphere"></span><b>${esc(t('ui_zone_sphere'))}</b><span>${esc(t('ui_zone_sphere_info'))}</span></button>
    </div>
    ${help('zone_intro')}
    <h3>${esc(t('ui_vanilla_rules'))}</h3>
    <p class="small muted">${esc(t('ui_vanilla_rules_lead'))}</p>
    <div class="row filters"><input type="text" id="q-zrules" class="grow" placeholder="${esc(t('ui_search_rules'))}" value="${esc(S.q.zrules)}" spellcheck="false"></div>
    <div class="count">${esc(t('ui_count_rules', total))}</div>
    <div class="llist">${rules.map((n) => `<div class="lrow" data-vrule="${esc(n)}"><span class="dot zone"></span>
      <div class="main"><div class="name">${esc(pretty(n.replace(/^ar_/, '')))}</div><div class="sub mono">${esc(n)}</div></div>
      <button class="btn sm ghost" data-vrule-add="${esc(n)}">${esc(S.sel && S.sel.type === 'zone' ? t('ui_add_to_zone') : t('ui_new_zone_with'))}</button></div>`).join('') || `<div class="empty">${esc(t('ui_no_match'))}</div>`}</div>
    ${moreButton(total)}`;
};

function ruleSoundOptions() {
  return customList().map((c) => `<option value="${esc(c.name)}">${esc(t('ui_custom_tag'))} · ${esc(c.label || c.key)}</option>`).join('')
    + S.cat.sounds.filter((x) => x.s === 'amb' && !isRemoved(x)).map((x) => `<option value="${esc(x.n)}">${esc(x.c)}</option>`).join('');
}

function zoneForm(e, editing) {
  const z = e.zone;
  const live = (k) => help(k, true);
  const later = (k) => help(k, false);
  const states = (editing && S.zoneStates[e.id]) || null;
  const playingRule = (i) => states && arr(states.rules).some((r) => r.index === i + 1 && r.playing);
  const rules = arr(z.rules).map((r, i) => {
    const custom = customByName(r.sound);
    return `<div class="rule ${playingRule(i) ? 'on' : ''}">
      <div class="rule-head"><span class="rule-n">${i + 1}</span>
        <input type="text" class="mono grow" data-f="zone.rules.${i}.sound" value="${esc(r.sound)}" list="rule-sounds" placeholder="${esc(t('ui_rule_sound'))}" spellcheck="false">
        ${custom ? `<span class="tag">${esc(t('ui_custom_tag'))}</span>` : ''}
        <button class="btn icon sm" data-rule-play="${i}" title="${esc(t('ui_play'))}">${icon('play', 12)}</button>
        <button class="btn icon sm ghost" data-rule-del="${i}" title="${esc(t('ui_delete'))}">${icon('close', 11)}</button>
      </div>
      <div class="grid4">
        <label class="field"><span class="lbl">${esc(t('ui_rule_every'))}</span><input type="number" min="0" max="600" data-f="zone.rules.${i}.every" value="${r.every ?? 10}"></label>
        <label class="field"><span class="lbl">${esc(t('ui_rule_variance'))}</span><input type="number" min="0" max="600" data-f="zone.rules.${i}.variance" value="${r.variance ?? 5}"></label>
        <label class="field"><span class="lbl">${esc(t('ui_rule_min'))}</span><input type="number" min="0" max="500" step="0.5" data-f="zone.rules.${i}.minDist" value="${r.minDist ?? 0}"></label>
        <label class="field"><span class="lbl">${esc(t('ui_rule_max'))}</span><input type="number" min="0.5" max="1000" step="0.5" data-f="zone.rules.${i}.maxDist" value="${r.maxDist ?? 25}"></label>
        <label class="field"><span class="lbl">${esc(t('ui_active_from'))}</span><input type="number" min="0" max="23" data-f="zone.rules.${i}.from" value="${r.from ?? 0}"></label>
        <label class="field"><span class="lbl">${esc(t('ui_active_to'))}</span><input type="number" min="1" max="24" data-f="zone.rules.${i}.to" value="${r.to ?? 24}"></label>
        <label class="field"><span class="lbl">${esc(t('ui_rule_weight'))}</span><input type="number" min="0" max="100" step="0.1" data-f="zone.rules.${i}.weight" value="${r.weight ?? 1}"></label>
        <label class="field"><span class="lbl">${esc(t('ui_category'))}</span><input type="text" class="mono" list="amb-cats" data-f="zone.rules.${i}.category" value="${esc(r.category || 'ambience_general')}"></label>
      </div>
      <div class="row wrap rule-flags">
        <label class="check"><input type="checkbox" data-f="zone.rules.${i}.fixed" ${r.fixed ? 'checked' : ''}><span>${esc(t('ui_rule_fixed'))}</span></label>
        ${r.fixed ? `<button class="btn sm ghost" data-rule-here="${i}">${esc(t('ui_rule_here'))}</button><span class="muted small mono">${r.x != null ? [r.x, r.y, r.z].map((n) => Number(n).toFixed(1)).join(', ') : ''}</span>` : ''}
        <label class="check"><input type="checkbox" data-f="zone.rules.${i}.occlusion" ${r.occlusion !== false ? 'checked' : ''}><span>${esc(t('ui_rule_occlusion'))}</span></label>
        <label class="check"><input type="checkbox" data-f="zone.rules.${i}.stopRain" ${r.stopRain ? 'checked' : ''}><span>${esc(t('ui_rule_rain'))}</span></label>
        <label class="check"><input type="checkbox" data-f="zone.rules.${i}.stopOnLeave" ${r.stopOnLeave !== false ? 'checked' : ''}><span>${esc(t('ui_rule_leave'))}</span></label>
        <label class="check"><input type="checkbox" data-f="zone.rules.${i}.startNow" ${r.startNow ? 'checked' : ''}><span>${esc(t('ui_rule_now'))}</span></label>
        <label class="check"><input type="checkbox" data-f="zone.rules.${i}.followListener" ${r.followListener ? 'checked' : ''}><span>${esc(t('ui_rule_follow'))}</span></label>
        <label class="check"><input type="checkbox" data-f="zone.rules.${i}.streaming" ${r.streaming ? 'checked' : ''}><span>${esc(t('ui_rule_streaming'))}</span></label>
      </div>
    </div>`;
  }).join('');
  const linked = S.interior ? S.interior.rooms.filter((r) => r.index !== 0 && editing && r.dat151.ambientZone === 'zone:' + e.id) : [];
  return `
    <div class="field full"><span class="lbl">${esc(t('ui_zone_shape'))}</span>
      <div class="seg zseg"><button data-zseg="box" class="${z.shape !== 'sphere' ? 'on' : ''}">${esc(t('ui_zone_box'))}</button><button data-zseg="sphere" class="${z.shape === 'sphere' ? 'on' : ''}">${esc(t('ui_zone_sphere'))}</button></div></div>
    ${z.shape === 'sphere'
      ? `<label class="field"><span class="lbl">${esc(t('ui_zone_radius'))}</span><input type="number" min="0.5" max="500" step="0.5" data-f="zone.radius" value="${z.radius ?? 8}"></label>`
      : `<label class="field"><span class="lbl">${esc(t('ui_zone_width'))}</span><input type="number" min="0.5" max="500" step="0.5" data-f="zone.width" value="${z.width ?? 10}"></label>
         <label class="field"><span class="lbl">${esc(t('ui_zone_length'))}</span><input type="number" min="0.5" max="500" step="0.5" data-f="zone.length" value="${z.length ?? 10}"></label>
         <label class="field"><span class="lbl">${esc(t('ui_zone_height'))}</span><input type="number" min="0.5" max="200" step="0.5" data-f="zone.height" value="${z.height ?? 5}"></label>`}
    <label class="field"><span class="lbl">${esc(t('ui_rotation'))}</span><input type="number" min="0" max="359" data-f="zone.rotation" value="${z.rotation ?? 0}"></label>
    <label class="field"><span class="lbl">${esc(t('ui_zone_fade'))}</span><input type="number" min="0" max="200" step="0.5" data-f="zone.fade" value="${z.fade ?? 5}"></label>
    <label class="field"><span class="lbl">${esc(t('ui_zone_to_play'))}</span><input type="number" min="1" max="32" data-f="zone.rulesToPlay" value="${z.rulesToPlay ?? 4}"></label>
    <div class="full">${live('zone_volume')}</div>

    <div class="full"><h4>${esc(t('ui_zone_rules'))} ${states ? `<span class="chip ${states.inside ? 'ok' : ''}">${esc(states.inside ? t('ui_zone_inside') : t('ui_zone_outside'))}</span>` : ''}</h4>
      ${live('zone_rules')}
      <datalist id="rule-sounds">${ruleSoundOptions()}</datalist>
      <datalist id="amb-cats">${arr(S.cat.amb.categories).filter((c) => c.startsWith('ambience') || c === 'scripted').map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="rules">${rules || `<div class="empty small">${esc(t('ui_no_rules'))}</div>`}</div>
      <div class="row" style="margin-top: 8px"><button class="btn sm" data-action="addRule">+ ${esc(t('ui_add_rule'))}</button></div>
    </div>

    <div class="full"><h4>${esc(t('ui_vanilla_rules'))}</h4>${later('zone_vanilla')}
      <div class="chips">${arr(z.vanillaRules).map((n, i) => `<span class="chip">${esc(n)} <button class="x" data-vr-del="${i}">×</button></span>`).join('') || `<span class="muted small">${esc(t('ui_none'))}</span>`}</div>
      <div class="row" style="margin-top: 6px"><input type="text" id="vr-add" class="mono grow" list="vr-list" placeholder="ar_..." spellcheck="false"><datalist id="vr-list">${arr(S.cat.amb.rules).map((n) => `<option value="${esc(n)}">`).join('')}</datalist><button class="btn sm" data-action="addVanillaRule">${esc(t('ui_add'))}</button></div>
    </div>

    <div class="full"><h4>${esc(t('ui_dir_ambiences'))}</h4>${later('zone_dir')}
      ${arr(z.dirAmbiences).map((d, i) => `<div class="row" style="margin-bottom: 4px"><span class="mono grow small">${esc(d.name)}</span>
        <input type="number" min="0" max="4" step="0.1" style="width: 80px" data-f="zone.dirAmbiences.${i}.volume" value="${d.volume ?? 1}">
        <button class="btn icon sm ghost" data-dir-del="${i}">${icon('close', 11)}</button></div>`).join('')}
      <div class="row"><input type="text" id="dir-add" class="mono grow" list="dir-list" placeholder="da_..." spellcheck="false"><datalist id="dir-list">${arr(S.cat.amb.dirAmbiences).map((n) => `<option value="${esc(n)}">`).join('')}</datalist><button class="btn sm" data-action="addDir">${esc(t('ui_add'))}</button></div>
    </div>

    <details class="adv full"><summary>${esc(t('ui_zone_more'))}</summary>
      <div class="grid2" style="margin-top: 8px">
        <label class="field"><span class="lbl">${esc(t('ui_zone_scene'))}</span><input type="text" class="mono" list="scene-list" data-f="zone.scene" value="${esc(z.scene || '')}"><datalist id="scene-list">${arr(S.cat.amb.scenes).map((n) => `<option value="${esc(n)}">`).join('')}</datalist>${later('zone_scene')}</label>
        <label class="field"><span class="lbl">${esc(t('ui_zone_env'))}</span><input type="text" class="mono" list="env-list" data-f="zone.environmentRule" value="${esc(z.environmentRule || '')}"><datalist id="env-list">${arr(S.cat.amb.environmentRules).map((n) => `<option value="${esc(n)}">`).join('')}</datalist>${later('zone_env')}</label>
      </div>
    </details>
    ${editing && S.interior && e.group === S.interior.group ? `<div class="full"><h4>${esc(t('ui_zone_rooms'))}</h4>${later('zone_rooms')}
      <div class="row wrap">${S.interior.rooms.filter((r) => r.index !== 0).map((r) => `<label class="check"><input type="checkbox" data-zone-room="${r.index}" ${r.dat151.ambientZone === 'zone:' + e.id ? 'checked' : ''}><span>${esc(r.displayName || r.name)}</span></label>`).join('')}</div>
      ${linked.length ? '' : ''}</div>` : ''}`;
}

/* Native StaticEmitter fields (advanced, applied by the game after export + reconnect). */
function emitterForm(e) {
  const x = e.emitter || {};
  const f = (k, label, min, max, step, ph) => `<label class="field"><span class="lbl">${esc(label)}</span><input type="number" data-f="emitter.${k}" min="${min}" max="${max}" step="${step}" value="${x[k] ?? ''}" placeholder="${esc(ph)}"></label>`;
  return `<details class="adv full"><summary>${esc(t('ui_native_emitter'))}</summary>
    <div class="group" style="margin-top: 8px">${help('emitter_native', false)}
      <div class="grid3">
        ${f('minDistance', t('ui_em_min_distance'), 0, 300, 0.5, '0')}
        ${f('rolloff', t('ui_em_rolloff'), 1, 1000, 10, e.type === 'sound' ? '100' : '250')}
        ${f('maxPathDepth', t('ui_em_path_depth'), 1, 10, 1, '3')}
        ${f('lpf', t('ui_em_lpf'), 100, 23900, 100, '23900')}
        ${f('hpf', t('ui_em_hpf'), 0, 20000, 10, '0')}
        ${f('maxLeakage', t('ui_em_leakage'), 0, 1, 0.05, '0.8')}
        ${f('minLeakDist', t('ui_em_leak_min'), 0, 500, 1, '6')}
        ${f('maxLeakDist', t('ui_em_leak_max'), 0, 500, 1, '15')}
        ${f('smallReverb', t('ui_em_rev_small'), 0, 100, 5, e.type === 'sound' ? '0' : '50')}
        ${f('mediumReverb', t('ui_em_rev_medium'), 0, 100, 5, e.type === 'sound' ? '0' : '50')}
        ${f('largeReverb', t('ui_em_rev_large'), 0, 100, 5, '0')}
      </div>
    </div></details>`;
}

/* Element detail (placing or editing) ------------------------------------ */

const TYPE_LABEL = () => ({ sound: t('type_sound'), ambient: t('type_ambient'), radio: t('type_radio'), static: t('type_static'), prop: t('type_prop'), zone: t('type_zone') });

function describe(e) {
  if (!e) return '';
  if (e.type === 'sound') return (e.sound.set ? e.sound.set + ' › ' : '') + e.sound.name;
  if (e.type === 'ambient') return e.ambient.emitter;
  if (e.type === 'radio') { const r = S.cat.radios.find((x) => x.n === e.radio.station); return r ? r.l : e.radio.station; }
  if (e.type === 'static') return e.static.name;
  if (e.type === 'prop') return e.prop.model;
  if (e.type === 'zone') return zoneSummary(e);
  return '';
}

function selectTemplate(tpl) {
  S.sel = {
    type: tpl.type, label: tpl.label || '', range: S.range, interiorOnly: !!S.interior, hours: { from: 0, to: 24 },
    sound: tpl.sound ? { repeat: true, delayMin: 0, delayMax: 0, bank: '', bankType: 'script', ...tpl.sound } : undefined,
    ambient: tpl.ambient ? { ...tpl.ambient } : undefined,
    radio: tpl.radio ? { ...tpl.radio } : undefined,
    static: tpl.static,
    prop: tpl.prop ? { heading: 0, ...tpl.prop } : undefined,
    zone: tpl.zone ? clone(tpl.zone) : undefined,
  };
  if (tpl.type === 'zone') { S.sel.range = 6; S.sel.interiorOnly = false; }
  render();
  requestAnimationFrame(() => { const d = $('#detail'); if (d) d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
}

function stationOptions(cur, allowNone) {
  const list = S.cat.radios.slice();
  if (cur && !list.find((r) => r.n === cur)) list.unshift({ n: cur, l: cur });
  return (allowNone ? `<option value="">${esc(t('ui_original_station'))}</option>` : '') +
    list.map((r) => `<option value="${esc(r.n)}" ${r.n === cur ? 'selected' : ''}>${esc(r.l)}${r.l !== r.n ? ' — ' + esc(r.n) : ''}</option>`).join('');
}

function propField(e) {
  const cur = (e.prop && e.prop.model) || '';
  return `<label class="field full"><span class="lbl">${esc(t('ui_visible_object'))}</span>
    <input type="text" class="mono" data-f="prop" value="${esc(cur)}" placeholder="${esc(t('ui_visible_object_none'))}" spellcheck="false">
    <div class="quick">${QUICK_PROPS.map((p) => `<button class="chip-btn" data-qp="${p}">${esc(p.replace(/^(prop_|ba_prop_battle_|bkr_prop_clubhouse_)/, ''))}</button>`).join('')}</div>
    ${help('el_prop', true)}</label>`;
}

function detailPanel(e, editing) {
  const hours = e.hours || { from: 0, to: 24 };
  const ro = editing && e.pack;
  const audio = e.type !== 'prop';
  let specific = '';

  const custom = e.type === 'sound' ? customByName(e.sound.name) : null;
  if (e.type === 'zone') {
    specific = zoneForm(e, editing);
  } else if (e.type === 'sound') {
    specific = `
      ${custom ? `<div class="notice full">${esc(t(custom.inGame ? 'ui_custom_in_game' : 'ui_custom_panel', custom.label || custom.key))}</div>` : ''}
      <label class="field"><span class="lbl">${esc(t('ui_audio_name'))}</span><input type="text" class="mono" data-f="sound.name" value="${esc(e.sound.name)}"></label>
      <label class="field"><span class="lbl">${esc(t('ui_soundset'))}</span><input type="text" class="mono" data-f="sound.set" value="${esc(e.sound.set || '')}" placeholder="${esc(t('ui_none'))}"></label>
      <label class="field full"><span class="lbl">${esc(t('ui_audio_bank'))}</span>
        <input type="text" class="mono" data-f="sound.bank" list="bank-list" value="${esc(e.sound.bank || '')}" placeholder="${esc(t('ui_optional'))}">
        <datalist id="bank-list">${S.cat.banks.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>${help('el_bank', true)}</label>
      <label class="check full"><input type="checkbox" data-f="sound.repeat" ${e.sound.repeat !== false ? 'checked' : ''}><span>${esc(t('ui_repeat'))}</span></label>
      <label class="field"><span class="lbl">${esc(t('ui_pause_min'))}</span><input type="number" min="0" step="0.5" data-f="sound.delayMin" value="${e.sound.delayMin || 0}"></label>
      <label class="field"><span class="lbl">${esc(t('ui_pause_max'))}</span><input type="number" min="0" step="0.5" data-f="sound.delayMax" value="${e.sound.delayMax || 0}"></label>
      <div class="full">${help('el_pause', true)}</div>
      ${propField(e)}`;
  } else if (e.type === 'ambient') {
    const n = S.cat.statics.find((x) => x.n === e.ambient.emitter);
    specific = `
      <label class="field full"><span class="lbl">${esc(t('type_ambient'))}</span><input type="text" class="mono" data-f="ambient.emitter" value="${esc(e.ambient.emitter)}"></label>
      ${e.ambient.alarm ? `<div class="hint full">🚨 ${esc(t('ui_alarm_emitter', e.ambient.alarm))}</div>` : ''}
      ${n && n.i ? `<div class="hint full">⚠ ${esc(t('ui_interior_bound_warn', n.i))}</div>` : ''}
      ${propField(e)}
      <div class="full">${help('el_ambient', true)}</div>`;
  } else if (e.type === 'radio') {
    specific = `
      <label class="field full"><span class="lbl">${esc(t('ui_station'))}</span><select data-f="radio.station">${stationOptions(e.radio.station)}</select></label>
      ${propField(e)}
      <div class="full">${help('el_radio', true)}${editing && e.radio.emitter ? `<div class="hint">${esc(t('ui_radio_slot', e.radio.emitter))}</div>` : ''}</div>`;
  } else if (e.type === 'static') {
    specific = `
      <div class="field full"><span class="lbl">${esc(t('ui_zone_action'))}</span>
        <div class="seg"><button data-seg="0" class="${!e.static.enabled ? 'on' : ''}">${esc(t('ui_zone_mute'))}</button><button data-seg="1" class="${e.static.enabled ? 'on' : ''}">${esc(t('ui_zone_on'))}</button></div></div>
      <label class="field full"><span class="lbl">${esc(t('ui_force_station'))}</span><select data-f="static.station">${stationOptions(e.static.station, true)}</select></label>
      <div class="full">${help('el_static', true)}</div>`;
  } else {
    specific = `
      <label class="field full"><span class="lbl">${esc(t('ui_model'))}</span><input type="text" class="mono" data-f="prop.model" value="${esc(e.prop.model)}"></label>
      <div class="hint full">${esc(t('ui_prop_place_tip'))}</div>`;
  }

  if (['sound', 'radio', 'ambient'].includes(e.type)) specific += emitterForm(e);
  const zone = e.type === 'zone';
  const playing = editing && S.active.has(e.id);
  const paused = editing && S.overrides[e.id] === false;
  return `
    <div class="detail" id="detail">
      <div class="d-head">
        <span class="dot ${e.type}"></span>
        <div class="grow"><b>${esc(editing ? (e.label || e.id) : TYPE_LABEL()[e.type])}</b><div class="muted small mono">${esc(describe(e))}</div></div>
        ${editing ? `<span class="chip ${playing ? 'ok' : ''}">${esc(playing ? t('ui_playing_now') : paused ? t('ui_paused') : t('ui_not_in_range'))}</span>` : ''}
        <button class="btn icon sm ghost" data-action="${editing ? 'closeEdit' : 'clearSel'}" title="${esc(t('ui_close'))}">${icon('close', 12)}</button>
      </div>
      ${ro ? `<div class="notice">${esc(t('ui_pack_readonly', e.pack))}</div>` : ''}
      ${editing ? `<div class="notice live">${icon('speaker', 15)}<span>${esc(t('ui_live_edit_note'))}</span></div>` : ''}
      ${editing && e.interiorHash ? `<div class="hint">${esc(t('ui_in_interior', intName(e.interiorHash) || ('0x' + hex(e.interiorHash))))}${e.roomName ? ' · ' + esc(e.roomName) : ''}</div>` : ''}
      <div class="grid2 dform">
        <label class="field ${audio ? '' : 'full'}"><span class="lbl">${esc(t('ui_label'))}</span><input type="text" data-f="label" value="${esc(e.label || '')}" placeholder="${esc(t('ui_label_placeholder'))}"></label>
        ${audio && !zone ? `<label class="field"><span class="lbl">${esc(t('ui_range'))}</span>
          <div class="slider"><input type="range" data-f="range" min="1" max="100" step="0.5" value="${e.range}"><input type="number" data-f="range" min="1" max="300" step="0.5" value="${e.range}"></div>${help('el_range', true)}</label>` : ''}
        ${audio && !zone && e.type !== 'static' ? `<label class="field"><span class="lbl">${esc(t('ui_volume_export'))}</span><input type="number" data-f="volume" min="-30" max="24" step="1" value="${e.volume ?? ''}" placeholder="${e.type === 'sound' ? '0' : '+12'}">${help('el_volume', false)}</label>` : ''}
        ${editing ? `<label class="field"><span class="lbl">${esc(t('ui_group'))}</span><input type="text" class="mono" data-f="group" value="${esc(e.group)}"></label>` : ''}
        ${specific}
        ${audio && !zone ? `
          <label class="check full"><input type="checkbox" data-f="interiorOnly" ${e.interiorOnly ? 'checked' : ''}><span>${esc(t('ui_interior_only'))}</span></label>
          <label class="field"><span class="lbl">${esc(t('ui_active_from'))}</span><input type="number" min="0" max="23" data-f="hours.from" value="${hours.from}"></label>
          <label class="field"><span class="lbl">${esc(t('ui_active_to'))}</span><input type="number" min="0" max="24" data-f="hours.to" value="${hours.to}"></label>
          <div class="full">${help('el_hours', true)}</div>` : ''}
        ${editing ? `<label class="check full"><input type="checkbox" data-f="enabled" ${e.enabled !== false ? 'checked' : ''}><span>${esc(t('ui_enabled_for_all'))}</span></label>` : ''}
      </div>
      <div class="row wrap actions">
        ${audio && !editing && !zone ? `<button class="btn" data-action="previewSel">${icon('play', 13)} ${esc(t('ui_preview'))}</button>` : ''}
        ${editing ? `
          <button class="btn" data-action="elementToggle" data-id="${esc(e.id)}">${icon(paused ? 'play' : 'pause', 13)} ${esc(paused ? t('ui_resume') : t('ui_pause'))}</button>
          <button class="btn" data-action="elementSolo" data-id="${esc(e.id)}">${icon('solo', 13)} ${esc(S.solo === e.id ? t('ui_unsolo') : t('ui_solo'))}</button>
          <button class="btn" data-action="elementTp" data-id="${esc(e.id)}">${esc(t('ui_go_to'))}</button>
          ${ro ? '' : `<button class="btn" data-action="elementMove" data-id="${esc(e.id)}">${esc(t('ui_move'))}</button>
          <button class="btn danger" data-action="elementDelete" data-id="${esc(e.id)}">${esc(t('ui_delete'))}</button>`}
          <span class="grow"></span>
          ${ro ? '' : `<button class="btn ghost" data-action="revertEdit">${esc(t('ui_revert'))}</button><button class="btn primary" data-action="saveEdit">${esc(t('ui_save'))}</button>`}`
        : `<span class="grow"></span><button class="btn primary" data-action="placeSel">${esc(t('ui_place_it'))}</button>`}
      </div>
    </div>`;
}

/* Reads every data-f field of the detail form into a copy of `base`. */
function readForm(base) {
  const out = clone(base);
  const root = $('#detail');
  if (!root) return out;
  $$('[data-f]', root).forEach((el) => {
    const path = el.dataset.f.split('.');
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number' || el.type === 'range') { v = parseFloat(el.value); if (Number.isNaN(v)) v = undefined; }
    else v = el.value.trim();
    if (path[0] === 'prop' && path.length === 1) {
      out.prop = v ? { ...(out.prop || {}), model: v, heading: (out.prop && out.prop.heading) || 0 } : undefined;
      return;
    }
    let o = out;
    for (let k = 0; k < path.length - 1; k++) { o[path[k]] = o[path[k]] || {}; o = o[path[k]]; }
    o[path[path.length - 1]] = v;
  });
  if (!out.label) delete out.label;
  if (out.range !== undefined) out.range = clamp(out.range || 15, 1, 300);
  if (out.volume === undefined || out.volume === '') delete out.volume; else out.volume = clamp(out.volume, -30, 24);
  if (out.hours) { out.hours.from = clamp(Math.floor(out.hours.from || 0), 0, 23); out.hours.to = out.hours.to === undefined ? 24 : clamp(Math.floor(out.hours.to), 0, 24); }
  if (out.sound) {
    if (!out.sound.set) out.sound.set = '';
    if (!out.sound.bank) delete out.sound.bank;
    out.sound.bankType = S.cat.bankKind[out.sound.bank] || 'script';
  }
  if (out.ambient) {
    const n = S.cat.statics.find((x) => x.n.toLowerCase() === String(out.ambient.emitter).toLowerCase());
    out.ambient.alarm = n ? (n.a || undefined) : out.ambient.alarm;
  }
  if (out.static) {
    const on = $('.seg .on', root);
    out.static.enabled = on ? on.dataset.seg === '1' : false;
    if (!out.static.station) delete out.static.station;
  }
  if (out.zone) {
    const on = $('.zseg .on', root);
    if (on) out.zone.shape = on.dataset.zseg;
    out.zone.rules = arr(out.zone.rules).filter(Boolean);
    out.zone.rules.forEach((r) => {
      if (r.from !== undefined) r.from = clamp(Math.floor(r.from || 0), 0, 23);
      if (r.to !== undefined) r.to = clamp(Math.floor(r.to || 24), 1, 24);
      if (r.fixed && r.x == null) { r.x = out.x; r.y = out.y; r.z = out.z; }
    });
    out.zone.vanillaRules = arr(out.zone.vanillaRules);
    out.zone.dirAmbiences = arr(out.zone.dirAmbiences);
    if (!out.zone.scene) delete out.zone.scene;
    if (!out.zone.environmentRule) delete out.zone.environmentRule;
  }
  if (out.emitter) {
    Object.keys(out.emitter).forEach((k) => { if (out.emitter[k] === undefined || out.emitter[k] === '' || Number.isNaN(out.emitter[k])) delete out.emitter[k]; });
    if (!Object.keys(out.emitter).length) delete out.emitter;
  }
  return out;
}

/* Placed ----------------------------------------------------------------- */

VIEWS.placed = () => {
  const groups = [...new Set(S.elements.map((e) => e.group))].sort();
  const q = S.q.placed.toLowerCase();
  const items = S.elements
    .filter((e) => (!S.q.pgroup || e.group === S.q.pgroup) && (!S.q.here || (S.interior && u32(e.interiorHash) === u32(S.interior.nameHash))) &&
      (!q || (e.label || e.id).toLowerCase().includes(q) || describe(e).toLowerCase().includes(q)));
  const rows = items.map((e) => {
    const playing = S.active.has(e.id);
    const paused = S.overrides[e.id] === false;
    const off = e.enabled === false;
    return `<div class="lrow placed ${S.edit && S.edit.id === e.id ? 'sel' : ''} ${off ? 'off' : ''}" data-el="${esc(e.id)}">
      ${e.type === 'prop' ? `<span class="dot prop"></span>` : `<button class="btn icon sm play ${playing ? 'on' : ''}" data-el-toggle="${esc(e.id)}" title="${esc(paused ? t('ui_resume') : t('ui_pause'))}">${icon(paused ? 'play' : (playing ? 'pause' : 'play'), 12)}</button>`}
      <div class="main"><div class="name">${esc(e.label || e.id)}${e.type === 'zone' && S.zoneStates[e.id] && S.zoneStates[e.id].inside ? `<span class="tag ok">${esc(t('ui_zone_inside'))}</span>` : ''}${e.pack ? `<span class="tag">${esc(t('ui_pack'))}</span>` : ''}${e.native ? `<span class="tag ok">${esc(t('ui_native'))}</span>` : ''}${playing ? `<span class="tag ok">${esc(t('ui_playing_now'))}</span>` : ''}${paused ? `<span class="tag warn">${esc(t('ui_paused'))}</span>` : ''}${off ? `<span class="tag bad">${esc(t('ui_disabled'))}</span>` : ''}</div>
        <div class="sub"><span class="dot ${e.type}"></span>${esc(TYPE_LABEL()[e.type])} · ${esc(describe(e))}</div></div>
      ${e.type === 'prop' ? '' : `<button class="btn icon sm ghost ${S.solo === e.id ? 'on' : ''}" data-el-solo="${esc(e.id)}" title="${esc(t('ui_solo'))}">${icon('solo', 12)}</button>`}
      <span class="side">${esc(e.group)}</span>
    </div>`;
  }).join('');
  const editing = S.edit && S.elements.find((e) => e.id === S.edit.id);
  return `
    <div class="row" style="margin-bottom: 8px">
      <h2 class="grow" style="margin: 0">${esc(t('ui_tab_placed'))}</h2>
      ${S.solo ? `<button class="btn sm primary" data-action="unsolo">${esc(t('ui_unsolo'))}</button>` : ''}
    </div>
    <p class="lead small">${esc(t('ui_placed_lead'))}</p>
    <div class="row filters">
      <input type="text" id="q-placed" class="grow" placeholder="${esc(t('ui_filter'))}" value="${esc(S.q.placed)}" spellcheck="false">
      <select id="q-pgroup" style="width: auto"><option value="">${esc(t('ui_all_groups'))}</option>${groups.map((g) => `<option ${g === S.q.pgroup ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
      ${S.interior ? `<label class="check"><input type="checkbox" id="q-here" ${S.q.here ? 'checked' : ''}><span>${esc(t('ui_this_interior'))}</span></label>` : ''}
    </div>
    <div class="count">${esc(t('ui_count_placed', items.length))}</div>
    <div class="llist">${rows || `<div class="empty">${esc(t('ui_nothing_placed'))}</div>`}</div>
    ${editing ? detailPanel(S.edit, true) : ''}
    <div class="row" style="margin-top: 12px">
      <button class="btn sm ghost" data-action="packJson">${esc(t('ui_pack_export'))}</button>
    </div>`;
};

/* Checks ---------------------------------------------------------------- */

VIEWS.checks = () => {
  const issues = (S.analysis && S.analysis.issues) || [];
  const rows = issues.map((x) => {
    const target = x.room != null ? `data-goto-room="${x.room}"` : x.portal != null ? `data-goto-portal="${x.portal}"` : '';
    return `<div class="issue"><span class="lv ${x.level}"></span>
      <span class="msg">${esc(t(x.key, ...arr(x.args)))}</span>
      ${target ? `<button class="btn sm ghost" ${target}>${esc(t('ui_show'))}</button>` : '<span></span>'}</div>`;
  }).join('');
  return `
    <h2>${esc(t('ui_tab_checks'))}</h2>
    <p class="lead">${esc(t('ui_checks_lead'))}</p>
    <div class="stats" data-derived="stats" style="margin-bottom: 14px">${DERIVED.stats()}</div>
    <div class="list">${rows || `<div class="empty">${esc(t('ui_no_issues'))}</div>`}</div>`;
};

/* Export ---------------------------------------------------------------- */

VIEWS.export = () => {
  const o = S.output;
  const groups = [...new Set([S.interior && S.interior.group, S.group, ...S.elements.filter((e) => !e.pack).map((e) => e.group), ...Object.keys(obj(S.exportStatus))].filter(Boolean))].sort();
  const cur = S.exportGroup || (S.interior ? S.interior.group : S.group);
  const st = obj(S.exportStatus);
  const r = S.lastResult;
  const install = S.exportInstall || o.install || 'self';

  const statusRows = Object.entries(st).map(([g, s]) => `
    <div class="save-item">
      <span class="dot ${s.pending ? 'radio' : 'static'}"></span>
      <div class="grow"><b class="mono">${esc(g)}</b>
        <div class="muted small">${esc(t('ui_install_' + (s.install || 'none')))}${s.target ? ' → ' + esc(s.target) : ''} · ${esc(s.at || '')}${(s.ymts || []).length ? ' · ' + esc(arr(s.ymts).map((y) => y + '.ymt').join(', ')) : ''}</div>
        ${s.manifest === false && s.perm ? `<div class="hint bad">${esc(t('ui_perm_needed'))}<br><code class="mono sel">${esc(s.perm)}</code></div>` : ''}</div>
      <span class="chip ${s.pending ? 'warn' : 'ok'}">${esc(s.target ? (s.pending ? t('ui_restart_needed') : t('ui_loaded')) : t('ui_folder_only'))}</span>
      <button class="btn icon sm ghost danger" data-uninstall="${esc(g)}" title="${esc(t('ui_uninstall'))}">${icon('close', 12)}</button>
    </div>`).join('');

  return `
    <h2>${esc(t('ui_tab_export'))}</h2>
    <p class="lead">${esc(t('ui_export_lead'))}</p>

    <div class="group stack">
      <label class="field"><span class="lbl">${esc(t('ui_export_group'))}</span>
        <select id="export-group">${groups.map((g) => `<option ${g === cur ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
        ${help('export_group')}</label>
      ${S.interior && S.interior.group === cur ? `<div class="files" data-derived="files">${DERIVED.files()}</div>` : ''}

      <div class="field"><span class="lbl">${esc(t('ui_install_where'))}</span>
        <div class="radio-cards">
          ${['self', 'resource', 'none'].map((k) => `<label class="rcard ${install === k ? 'on' : ''}"><input type="radio" name="install" value="${k}" ${install === k ? 'checked' : ''}>
            <b>${esc(t('ui_install_' + k))}</b><span>${esc(t('ui_install_' + k + '_info', S.resource))}</span></label>`).join('')}
        </div>
      </div>
      ${install === 'resource' ? `<div class="row"><select id="export-target" class="grow">${resourceOptions(cur)}</select></div>
        <div class="hint">${esc(t('ui_install_resource_perm'))}<br><code class="mono sel">add_filesystem_permission ${esc(S.resource)} write ${esc(S.exportTarget || '<mlo>')}</code></div>` : ''}
      <div class="row wrap" style="gap: 10px 18px">
        ${check('o:xml', t('ui_xml_copies'), o.xml !== false)}
        ${check('o:comments', t('ui_debug_comments'), o.comments)}
      </div>
      <div class="row end">
        <button class="btn primary" data-action="export" ${S.busy ? 'disabled' : ''}>${esc(t('ui_export_button'))}</button>
      </div>
      ${r ? `<div class="result">
        <b>${esc(t('ui_export_written', r.dir))}</b>
        <div class="files">${arr(r.files).map((f) => `<div>${esc(f)}</div>`).join('')}</div>
        ${arr(r.notes).map((n) => `<div class="hint">${esc(n)}</div>`).join('')}
        ${r.target ? `<div class="notice warn">${icon('speaker', 16)}<span>${esc(t('ui_after_export'))}</span></div>` : `<div class="notice">${esc(t('ui_copy_folder', r.dir))}</div>`}
      </div>` : ''}
      ${S.exportError ? `<div class="notice bad"><span>${esc(S.exportError)}</span></div>` : ''}
    </div>

    <h3>${esc(t('ui_installed'))}</h3>
    <div class="list">${statusRows || `<div class="empty small">${esc(t('ui_nothing_exported'))}</div>`}</div>

    ${S.interior ? `
    <h3>${esc(t('ui_preview_files'))}</h3>
    <div class="tabs">
      ${['ymt', 'dat151', 'manifest'].map((k) => `<button data-preview-file="${k}" class="${S.preview.kind === k && S.preview.text ? 'active' : ''}">${esc(t('ui_preview_' + k))}</button>`).join('')}
      <span class="grow"></span>
      ${S.preview.text ? `<button data-action="copyPreview">${esc(t('ui_copy'))}</button>` : ''}
    </div>
    ${S.preview.text ? `<pre class="preview">${esc(S.preview.text)}</pre>` : `<div class="list empty small">${esc(t('ui_preview_empty'))}</div>`}

    <h3>${esc(t('ui_projects'))}</h3>
    <div class="row wrap" style="margin-bottom: 10px">
      <button class="btn sm" data-action="listSaves">${esc(t('ui_browse_saves'))}</button>
      <button class="btn sm" data-action="reload">${esc(t('ui_reload_file'))}</button>
      <button class="btn sm" data-action="rescanKeep">${esc(t('ui_rescan_keep'))}</button>
      <button class="btn sm danger" data-action="rebuild">${esc(t('ui_rebuild'))}</button>
      <button class="btn sm ghost" data-action="exportJson">${esc(t('ui_export_json'))}</button>
      <button class="btn sm ghost" data-action="importDialog">${esc(t('ui_import_json'))}</button>
    </div>
    ${S.saves ? `<div class="list">${S.saves.length ? S.saves.map((s) => `
      <div class="save-item">
        <div class="grow"><b class="mono">${esc(s.file)}</b><div class="muted small">${esc(s.name || '')} · ${esc(t('ui_group'))} ${esc(s.group || '')} · ${s.rooms} ${esc(t('ui_stat_rooms'))}${s.updatedAt ? ' · ' + new Date(s.updatedAt * 1000).toLocaleString() : ''}</div></div>
        ${u32(s.nameHash) === u32(S.interior.nameHash) ? `<button class="btn sm" data-load-save="${esc(s.file)}">${esc(t('ui_load'))}</button>` : `<span class="chip">${esc(t('ui_other_interior'))}</span>`}
      </div>`).join('') : `<div class="empty">${esc(t('ui_no_saves'))}</div>`}</div>` : ''}` : ''}`;
};

/* Settings --------------------------------------------------------------- */

VIEWS.settings = () => {
  const p = S.prefs;
  const swatches = ['#ff7a1a', '#ff9a3c', '#ffb547', '#f2c94c', '#58c98b', '#4fc3d9', '#7fa8d9', '#e46a8c'];
  return `
    <h2>${esc(t('ui_tab_settings'))}</h2>
    <p class="lead">${esc(t('ui_settings_lead'))}</p>
    <h3>${esc(t('ui_appearance'))}</h3>
    <div class="group stack">
      <div class="theme-grid">${THEMES.map((th) => `<button class="theme-card ${p.theme === th.id ? 'on' : ''}" data-theme-pick="${th.id}" style="--tp-accent:${th.accent}">
        <div class="theme-prev" style="background:${th.panel}"><div class="tp-side" style="background:${th.bg}"><i></i><i></i><i></i><i></i></div>
          <div class="tp-main"><i style="background:${th.card}"></i><i style="background:${th.card}"></i><i style="background:${th.accent};width:40%"></i></div></div>
        ${esc(th.name)}</button>`).join('')}</div>
      <div class="srow-list">
        <label class="switch srow"><input type="checkbox" data-pref-bool="anim" ${p.anim !== false ? 'checked' : ''}><span>${esc(t('ui_pref_anim'))}</span></label>
        <label class="switch srow"><input type="checkbox" data-pref-bool="smooth" ${p.smooth !== false ? 'checked' : ''}><span>${esc(t('ui_pref_smooth'))}</span></label>
        <label class="switch srow"><input type="checkbox" data-pref-bool="compact" ${p.compact ? 'checked' : ''}><span>${esc(t('ui_pref_compact'))}</span></label>
        <label class="switch srow"><input type="checkbox" data-pref-bool="glass" ${p.glass ? 'checked' : ''}><span>${esc(t('ui_pref_glass'))}</span></label>
      </div>
    </div>
    <div class="group stack">
      <label class="switch srow"><input type="checkbox" id="show-help" ${S.showHelp ? 'checked' : ''}><span>${esc(t('ui_show_help'))}</span></label>
      <div class="grid2">
        <div class="field"><span class="lbl">${esc(t('ui_window_pos'))}</span>
          <div class="row" style="height: 33px"><button class="btn sm" data-action="centerWindow">${esc(t('ui_center_window'))}</button></div></div>
        <div class="field"><span class="lbl">${esc(t('ui_accent'))}</span>
          <div class="row" style="gap: 6px; height: 33px">${swatches.map((c) => `<button class="swatch" data-accent="${c}" aria-label="${c}" style="background: ${c}; outline-color: ${p.accent === c ? '#fff' : 'transparent'}"></button>`).join('')}</div></div>
      </div>
      ${prefSlider('width', t('ui_width'), p.width, 720, 1600, 10)}
      ${prefSlider('height', t('ui_height_win'), p.height, 520, 1100, 10)}
      ${prefSlider('opacity', t('ui_opacity'), p.opacity, 0.6, 1, 0.01)}
      ${prefSlider('scale', t('ui_text_size'), p.scale, 0.8, 1.4, 0.05)}
      <div class="row end"><button class="btn sm ghost" data-action="resetPrefs">${esc(t('ui_reset'))}</button></div>
    </div>

    <h3>${esc(t('ui_factory_title'))}</h3>
    <div class="group factory">
      <p class="muted small">${esc(t('ui_factory_info'))}</p>
      <div class="row end"><button class="btn sm danger" data-action="factoryReset">${esc(t('ui_factory_reset'))}</button></div>
    </div>

    ${window.keybindsSection ? window.keybindsSection() : ''}

    <h3>${esc(t('ui_shortcuts'))}</h3>
    <div class="group hashes" style="grid-template-columns: auto 1fr">
      <div class="k mono">${esc(((S.keybinds || []).find((b) => b.id === 'toggle') || {}).key || S.openKey || 'F5')} / Esc</div><div>${esc(t('ui_sc_close'))}</div>
      <div class="k mono">Ctrl + S</div><div>${esc(t('ui_sc_save'))}</div>
      <div class="k mono">Alt + 1…0</div><div>${esc(t('ui_sc_tabs'))}</div>
      <div class="k mono">${esc(t('ui_mouse_' + (S.ui.freeMoveButton ?? 2)))}</div><div>${esc(t('ui_sc_freemove'))}</div>
      <div class="k mono">E / Q / G / H / X</div><div>${esc(t('ui_sc_aim'))}</div>
    </div>`;
};

function prefSlider(key, label, value, min, max, step) {
  return `<label class="field"><span class="lbl">${esc(label)}</span><div class="slider">
    <input type="range" data-pref="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
    <input type="number" data-pref="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></div></label>`;
}


function afterRender() {
  if (S.tab === 'rooms' && S.interior) { drawEcho(); bindTonePicker(); }
  if (S.tab === 'library' && S.lib === 'custom' && S.csel) drawCustomWave();
}

/* ---------------------------------------------------------------- binding */

function setBound(bind, value) {
  const i = S.interior;
  const [kind, ...rest] = bind.split(':');
  if (kind === 'i') {
    const path = rest[0].split('.');
    let o = i;
    while (path.length > 1) o = o[path.shift()];
    o[path[0]] = value;
  } else if (kind === 'r') {
    const room = i.rooms[S.room];
    room.dat151[rest[0]] = value;
    if (['reverbSmall', 'reverbMedium', 'reverbLarge', 'nonMarkedPortalOcclusion', 'exteriorAudibility'].includes(rest[0])) room.preset = '';
  } else if (kind === 'p') {
    i.portals[+rest[0]].isEnabled[+rest[1]] = value;
  } else if (kind === 'e') {
    i.portals[+rest[0]].entities[+rest[1]][rest[2]] = value;
  } else if (kind === 'o') {
    S.output[rest[0]] = value;
    return false;
  }
  return true;
}

function readInput(el) {
  if (el.dataset.type === 'bool') return el.checked;
  if (el.dataset.type === 'num') {
    const v = parseFloat(el.value);
    if (Number.isNaN(v)) return null;
    const min = el.min !== '' ? +el.min : -Infinity, max = el.max !== '' ? +el.max : Infinity;
    return clamp(v, min, max);
  }
  return el.value;
}

/* Live element editing: every change plays immediately (not saved until Save). */
let liveTimer = null;
function liveEdit() {
  if (!S.edit) return;
  const data = readForm(S.edit);
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => nui('element:live', { element: data }), 120);
}

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.bind) {
    const v = readInput(el);
    if (v === null) return;
    const isData = setBound(el.dataset.bind, v);
    $$(`[data-bind="${CSS.escape(el.dataset.bind)}"]`).forEach((o) => { if (o !== el && o.type !== 'checkbox') o.value = o.type === 'number' ? +Number(v).toFixed(3) : v; });
    if (el.dataset.bind.startsWith('r:')) drawEcho();
    if (isData) markDirty(el.type === 'text' || el.tagName === 'TEXTAREA' ? 500 : 250);
    return;
  }
  if (el.dataset.f) {
    if (el.type === 'range' || el.type === 'number') $$(`[data-f="${el.dataset.f}"]`, $('#detail')).forEach((o) => { if (o !== el) o.value = el.value; });
    if (S.edit && $('#detail') && $('#detail').contains(el)) liveEdit();
    return;
  }
  if (el.dataset.prefBool) {
    S.prefs[el.dataset.prefBool] = el.checked;
    applyPrefs(); savePrefs();
    return;
  }
  if (el.dataset.pref) {
    const v = el.type === 'range' || el.type === 'number' ? parseFloat(el.value) : el.value;
    if (Number.isNaN(v)) return;
    S.prefs[el.dataset.pref] = v;
    $$(`[data-pref="${el.dataset.pref}"]`).forEach((o) => { if (o !== el) o.value = v; });
    applyPrefs();
    savePrefs();
    return;
  }
  const searches = { 'q-custom': 'custom', 'q-zrules': 'zrules', 'room-filter': 'roomFilter', 'q-sounds': 'sounds', 'q-emitters': 'emitters', 'q-radios': 'radios', 'q-objects': 'objects', 'q-mute': 'mute', 'q-doors': 'doors', 'q-placed': 'placed' };
  if (searches[el.id]) {
    if (el.id === 'room-filter') S.roomFilter = el.value; else S.q[searches[el.id]] = el.value;
    S.limit = 250;
    clearTimeout(window.__searchTimer);
    window.__searchTimer = setTimeout(render, 140);
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.bind === 'r:weaponMetrics' || el.dataset.bind === 'r:ambientZone') { render(); return; }
  if (el.id === 'cs-file') { uploadFiles([...el.files]); el.value = ''; return; }
  if (el.dataset.zoneRoom !== undefined && S.edit) {
    const room = S.interior && S.interior.rooms.find((r) => r.index === +el.dataset.zoneRoom);
    if (room) { room.dat151.ambientZone = el.checked ? 'zone:' + S.edit.id : ''; markDirty(0); }
    return;
  }
  if (el.dataset.bind && el.type === 'checkbox') {
    if (el.dataset.bind.startsWith('o:')) render();
    else if (el.dataset.bind.startsWith('p:') || el.dataset.bind.startsWith('i:output')) { render(); sync(); }
    return;
  }
  if (el.dataset.f && S.edit && $('#detail') && $('#detail').contains(el)) { liveEdit(); return; }
  if (el.id === 'occ-overlay') {
    if (window.JDT_OVERLAY) window.JDT_OVERLAY.set({ portals: el.checked });
    return;
  }
  if (el.dataset.debug) {
    S.debug[el.dataset.debug] = el.checked;
    nui('debug', { [el.dataset.debug]: el.checked }).then(updateDebug);
    return;
  }
  if (el.dataset.dbgEntity) {
    const [portal, entity] = el.dataset.dbgEntity.split(':').map(Number);
    nui('debugEntity', { portal, entity, enabled: el.checked }).then(updateDebug);
    return;
  }
  if (el.dataset.doorPreset) {
    const door = S.interior.doors[el.dataset.doorPreset];
    if (door) {
      door.preset = el.value;
      door.how = 'manual';
      if (el.value === 'custom' && !door.custom) door.custom = { sounds: 'door_swing_exit_wood_no_mech', tuning: 'dtp_default_swing', maxOcclusion: 0.7 };
      const simple = S.doorSounds.find((x) => x.id === el.value);
      if (simple) door.kind = simple.kind;
      markDirty(0);
      render();
    }
    return;
  }
  if (el.dataset.doorCustom) {
    const [key, field] = el.dataset.doorCustom.split(':');
    const door = S.interior.doors[key];
    if (door) {
      door.custom = door.custom || {};
      door.custom[field] = field === 'maxOcclusion' ? clamp(parseFloat(el.value) || 0, 0, 1) : el.value.trim();
      markDirty(0);
      render();
    }
    return;
  }
  if (el.name === 'install') { S.exportInstall = el.value; render(); return; }
  if (el.id === 'export-target') { S.exportTarget = el.value; render(); return; }
  if (el.id === 'export-group') { S.exportGroup = el.value; S.lastResult = null; render(); return; }
  if (el.id === 'portal-filter') { S.portalFilter = el.value; render(); }
  if (el.id === 'q-src') { S.q.src = el.value; render(); }
  if (el.id === 'q-hidden-radios') { S.q.hiddenRadios = el.checked; render(); }
  if (el.id === 'q-audio-only') { S.q.audioOnly = el.checked; S.limit = 250; render(); }
  if (el.id === 'q-pgroup') { S.q.pgroup = el.value; render(); }
  if (el.id === 'q-here') { S.q.here = el.checked; render(); }
  if (el.id === 'show-help') { S.showHelp = el.checked; savePrefs(); render(); }
});

function updateDebug(state) {
  if (state && typeof state === 'object' && 'outline' in state) {
    S.debug = { ...S.debug, ...state, debugEntities: arr(state.debugEntities) };
    if (state.navigate === undefined) S.debug.navigate = null;
  }
}

/* Applies a change to the zone being placed / edited (form values first, so nothing typed is lost). */
function zoneEdit(fn) {
  const editing = !!(S.edit && S.edit.type === 'zone' && $('#detail'));
  const base = editing ? S.edit : S.sel;
  if (!base || base.type !== 'zone') return;
  const cur = readForm(base);
  fn(cur.zone);
  if (editing) { S.edit = cur; liveEdit(); } else S.sel = cur;
  render();
}

/* ------------------------------------------------------------- previews */

async function startPreview(tpl) {
  return nui('preview:start', tpl);
}
async function stopPreview(id) {
  toneIds.delete(id);
  return nui('preview:stop', { id });
}

function soundTpl(s) {
  return { type: 'sound', sound: { name: s.n, set: s.r || '' }, label: s.s === 'amb' ? pretty(s.n) : s.n, sub: s.s === 'amb' ? t('ui_ambience_loop') : (s.r || s.c) };
}

/* ---------------------------------------------------------------- actions */

async function refreshActive() {
  const r = await nui('element:active');
  S.active = new Set(arr(r && r.active));
  S.zoneStates = {};
  Object.entries(obj(r && r.zones)).forEach(([id, z]) => { if (z) S.zoneStates[id] = { inside: !!z.inside, rules: arr(z.rules) }; });
}

const ACTIONS = {
  async save() {
    const res = await action('save', {}, { full: false });
    if (res && res.ok) S.dirty = false;
    renderHeader();
  },
  resetProxy() { S.interior.proxyHashOverride = false; markDirty(0); setTimeout(render, 50); },
  async setGroup() {
    const g = ($('#place-group').value || '').trim();
    const r = await nui('setGroup', { group: g });
    if (r && r.group) S.group = r.group;
    toast('success', t('ui_group_set', S.group));
    render();
  },
  async importFrom() {
    const res = $('#import-res').value;
    if (!res) return toast('warning', t('ui_pick_resource'));
    const out = await action('importFrom', { resource: res });
    if (out && out.importNotes) arr(out.importNotes).forEach((n) => toast('warning', n));
  },
  async applyPresetRoom() {
    const id = $('#preset-select').value;
    if (id) await action('applyPreset', { preset: id, rooms: [S.room] });
  },
  copyRoomDialog() {
    const rooms = S.interior.rooms.map((r, idx) => idx).filter((idx) => idx !== 0 && idx !== S.room);
    modal(`<h2>${esc(t('ui_copy_title', roomName(S.room)))}</h2>
      <p class="muted">${esc(t('ui_copy_lead'))}</p>
      <div class="checklist">${rooms.map((idx) => `<label class="check"><input type="checkbox" value="${idx}"><span>${idx}. ${esc(roomName(idx))}</span></label>`).join('')}</div>
      <div class="row end"><button class="btn ghost" data-modal-select>${esc(t('ui_select_all'))}</button><button class="btn ghost" data-close-modal>${esc(t('ui_cancel'))}</button><button class="btn primary" data-modal-ok>${esc(t('ui_copy'))}</button></div>`,
    async (card) => {
      const to = $$('input:checked', card).map((c) => +c.value);
      if (to.length) await action('copyRoom', { from: S.room, to });
    });
  },
  async resetRoom() { await action('resetRoom', { rooms: [S.room] }); },
  toneListen() { toneListen(); },
  toneClear() {
    S.interior.rooms[S.room].dat151.roomToneSound = 'null_sound';
    const l = listeningTone(); if (l) stopPreview(l.id);
    markDirty(0); render();
  },
  async goHere() {
    const res = await nui('currentRoom');
    if (res && res.index >= 0) { S.hereRoom = res.index; S.room = res.index; render(); }
    else toast('warning', t('ui_not_in_room'));
  },
  async enableAll() { await action('setAllPortals', { enabled: true }); },
  async disableAll() { await action('setAllPortals', { enabled: false }); },
  async autoDetect() { await action('autoDetect', {}); },
  async autoDetectPortal(el) { await action('autoDetect', { portal: +el.dataset.portal }); },
  async bulkOcclusion() { await action('bulkEntities', { filter: $('#bulk-filter').value, maxOcclusion: parseFloat($('#bulk-value').value) }); },
  expandAll() {
    const all = S.interior.portals.every((p, i) => S.expanded[i]);
    S.interior.portals.forEach((p, i) => { S.expanded[i] = !all; });
    render();
  },
  overlaySettings() {
    setTab('mportals');
    requestAnimationFrame(() => { if (!document.querySelector('#ov-wrap.open') && window.toggleOvSettings) window.toggleOvSettings(); });
  },
  async navigate(el) {
    const idx = +el.dataset.portal;
    const next = S.debug.navigate === idx ? false : idx;
    updateDebug(await nui('debug', { navigate: next, selected: next === false ? false : idx }));
    if (window.JDT_OVERLAY) window.JDT_OVERLAY.highlight(next === false ? null : idx);
    S.debug.navigate = next === false ? null : next;
    render();
  },
  async teleportPortal(el) { await nui('teleportPortal', { portal: +el.dataset.portal }); },
  async doorAimed() { await action('doorAimed'); },
  doorShelf() { S.tab = 'library'; S.lib = 'doorsounds'; render(); },

  muteAll() {
    S.muteAll = !S.muteAll;
    nui('element:muteAll', { on: S.muteAll }).then((r) => { S.active = new Set(arr(r && r.active)); render(); });
  },
  stopAll() { toneIds.clear(); nui('preview:stopAll'); },
  more() { S.limit += 500; render(); },
  clearSel() { S.sel = null; render(); },
  previewSel() {
    const tpl = readForm(S.sel);
    startPreview({ ...tpl, label: tpl.label || describe(tpl), sub: TYPE_LABEL()[tpl.type] });
  },
  placeSel() {
    const tpl = readForm(S.sel);
    if (tpl.range) S.range = tpl.range;
    nui('place', { template: tpl });
  },
  customSound() {
    const n = $('#c-name').value.trim();
    if (!n) return toast('error', t('ui_enter_name'));
    selectTemplate({ type: 'sound', sound: { name: n, set: $('#c-set').value.trim() } });
  },
  customEmitter() {
    const n = $('#c-emitter').value.trim();
    if (!n) return toast('error', t('ui_enter_name'));
    selectTemplate({ type: 'ambient', ambient: { emitter: n } });
  },
  customStation() {
    const n = $('#c-station').value.trim();
    if (!n) return toast('error', t('ui_enter_name'));
    selectTemplate({ type: 'radio', radio: { station: n } });
  },
  customObject() {
    const n = $('#c-object').value.trim();
    if (!n) return toast('error', t('ui_enter_name'));
    selectTemplate({ type: 'prop', prop: { model: n } });
  },
  scanStop() { nui('scan:stop'); },
  scanReset() {
    modal(`<h2>${esc(t('ui_scan_reset'))}</h2><p class="muted">${esc(t('ui_scan_reset_confirm'))}</p>
      <div class="row end"><button class="btn ghost" data-close-modal>${esc(t('ui_cancel'))}</button><button class="btn primary danger" data-modal-ok>${esc(t('ui_scan_reset'))}</button></div>`,
    async () => { await nui('scan:reset'); });
  },
  toggleRemoved() { S.showRemoved = !S.showRemoved; render(); },

  closeEdit() { if (S.edit) nui('element:endLive', { id: S.edit.id }); S.edit = null; render(); },
  revertEdit() {
    if (!S.edit) return;
    nui('element:endLive', { id: S.edit.id });
    S.edit = clone(S.elements.find((e) => e.id === S.edit.id) || S.edit);
    render();
  },
  async saveEdit() {
    const data = readForm(S.edit);
    const r = await nui('element:save', { element: data });
    if (r && r.ok) S.edit = clone(r.element);
    render();
  },
  async elementToggle(el) {
    const id = el.dataset.id;
    S.overrides[id] = S.overrides[id] === false ? undefined : false;
    const r = await nui('element:toggle', { id, state: S.overrides[id] === false ? false : 'default' });
    S.active = new Set(arr(r && r.active));
    render();
  },
  async elementSolo(el) {
    const id = el.dataset.id;
    S.solo = S.solo === id ? null : id;
    const r = await nui('element:solo', { id: S.solo });
    S.active = new Set(arr(r && r.active));
    render();
  },
  async unsolo() {
    S.solo = null;
    const r = await nui('element:solo', { id: null });
    S.active = new Set(arr(r && r.active));
    render();
  },
  elementTp(el) { nui('element:teleport', { id: el.dataset.id }); },
  elementMove(el) { nui('element:move', { id: el.dataset.id }); },
  elementDelete(el) {
    const e = S.elements.find((x) => x.id === el.dataset.id);
    modal(`<h2>${esc(t('ui_delete'))}</h2><p class="muted">${esc(t('ui_delete_confirm', e ? (e.label || e.id) : ''))}</p>
      <div class="row end"><button class="btn ghost" data-close-modal>${esc(t('ui_cancel'))}</button><button class="btn primary danger" data-modal-ok>${esc(t('ui_delete'))}</button></div>`,
    async () => { await nui('element:delete', { id: el.dataset.id }); S.edit = null; render(); });
  },
  async packJson() {
    const g = S.q.pgroup || S.group;
    const r = await nui('packJson', { group: g });
    if (!r || !r.text) return;
    modal(`<h2>${esc(t('ui_pack_export'))}: ${esc(g)}</h2><p class="muted">${esc(t('ui_pack_export_lead', r.count || 0))}</p>
      <textarea rows="14" readonly id="export-text">${esc(r.text)}</textarea>
      <div class="row end" style="margin-top: 12px"><button class="btn ghost" data-close-modal>${esc(t('ui_close'))}</button><button class="btn primary" data-copy-export>${esc(t('ui_copy'))}</button></div>`);
  },

  async export() {
    const group = ($('#export-group') && $('#export-group').value) || S.group;
    const install = S.exportInstall || S.output.install || 'self';
    const target = install === 'resource' ? ($('#export-target') && $('#export-target').value) : undefined;
    if (install === 'resource' && !target) return toast('warning', t('ui_pick_resource'));
    S.exportError = null;
    S.busy = true; render();
    const res = await nui('export', { edits: buildEdits(), group, options: { install, target, xml: S.output.xml !== false, comments: !!S.output.comments } });
    S.busy = false;
    if (res && res.ok) { S.lastResult = res.result; S.dirty = false; } else { S.lastResult = null; S.exportError = (res && res.error) || t('ui_export_failed'); }
    render();
  },
  copyPreview() { copyText(S.preview.text); },
  async listSaves() { const res = await nui('listSaves'); S.saves = arr(res && res.list); render(); },
  async reload() { await action('reload'); },
  async rescanKeep() { await action('rebuild', { keepSettings: true }); },
  rebuild() {
    modal(`<h2>${esc(t('ui_rebuild'))}</h2><p class="muted" style="line-height: 1.5">${esc(t('ui_rebuild_confirm'))}</p>
      <div class="row end"><button class="btn ghost" data-close-modal>${esc(t('ui_cancel'))}</button><button class="btn primary danger" data-modal-ok>${esc(t('ui_rebuild'))}</button></div>`,
    async () => { await action('rebuild', { keepSettings: false }); });
  },
  async exportJson() {
    const res = await nui('exportJson', { edits: buildEdits() });
    if (!res || !res.text) return;
    modal(`<h2>${esc(t('ui_export_json'))}</h2><p class="muted">${esc(t('ui_export_json_lead'))}</p>
      <textarea rows="14" readonly id="export-text">${esc(res.text)}</textarea>
      <div class="row end" style="margin-top: 12px"><button class="btn ghost" data-close-modal>${esc(t('ui_close'))}</button><button class="btn primary" data-copy-export>${esc(t('ui_copy'))}</button></div>`);
  },
  importDialog() {
    modal(`<h2>${esc(t('ui_import_json'))}</h2><p class="muted">${esc(t('ui_import_json_lead'))}</p>
      <textarea rows="12" id="import-text" placeholder="{ ... }"></textarea>
      <div class="row end" style="margin-top: 12px"><button class="btn ghost" data-close-modal>${esc(t('ui_cancel'))}</button><button class="btn primary" data-modal-ok>${esc(t('ui_import_json'))}</button></div>`,
    async (card) => { await action('importJson', { text: $('#import-text', card).value }); });
  },
  /* custom sounds */
  async soundRescan() { await nui('sound:rescan', { groups: [customGroup()] }); },
  closeCustom() { S.csel = null; render(); },
  async customSave() {
    const c = S.csel; if (!c) return;
    const fields = {};
    $$('[data-cf]', $('#cdetail')).forEach((el) => {
      const k = el.dataset.cf;
      fields[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? parseFloat(el.value) || 0 : (k === 'rate' ? Number(el.value) : el.value);
    });
    const r = await nui('sound:update', { group: c.group, key: c.key, fields });
    if (r && r.ok) toast('success', t('ui_saved'));
  },
  customDelete() {
    const c = S.csel; if (!c) return;
    modal(`<h2>${esc(t('ui_delete'))}</h2><p class="muted">${esc(t('ui_delete_confirm', c.group + '/' + c.key))}</p>
      <div class="row end"><button class="btn ghost" data-close-modal>${esc(t('ui_cancel'))}</button><button class="btn primary danger" data-modal-ok>${esc(t('ui_delete'))}</button></div>`,
    async () => { await nui('sound:delete', { group: c.group, key: c.key }); if (window.JDT_AUDIO) window.JDT_AUDIO.forget(c.group, c.key); S.csel = null; render(); });
  },
  customPlay() {
    const c = S.csel && arr(S.custom[S.csel.group]).find((x) => x.key === S.csel.key);
    if (c) startPreview({ ...customTpl(c), sub: t('ui_custom_tag') });
  },
  customPlace() {
    const c = S.csel && arr(S.custom[S.csel.group]).find((x) => x.key === S.csel.key);
    if (c) { S.lib = 'custom'; selectTemplate(customTpl(c)); }
  },
  customTone() {
    const c = S.csel && arr(S.custom[S.csel.group]).find((x) => x.key === S.csel.key);
    if (!c || !S.interior || S.room <= 0) return;
    S.interior.rooms[S.room].dat151.roomToneSound = c.name;
    markDirty(0);
    toast('success', t('ui_tone_set', roomName(S.room)), c.name);
    if (!c.loop) toast('warning', t('ui_tone_not_loop'));
  },
  customZone() {
    const c = S.csel && arr(S.custom[S.csel.group]).find((x) => x.key === S.csel.key);
    if (!c) return;
    S.lib = 'zones';
    selectTemplate(newZoneTpl('box', [ruleFromSound(c.name, c.loop)]));
  },

  /* ambient zones */
  newZoneBox() { selectTemplate(newZoneTpl('box')); },
  newZoneSphere() { selectTemplate(newZoneTpl('sphere')); },
  newZoneForRoom() { S.tab = 'library'; S.lib = 'zones'; selectTemplate(newZoneTpl('box')); },
  addRule() { zoneEdit((z) => { z.rules = arr(z.rules); if (z.rules.length < 16) z.rules.push(ruleFromSound('', false)); }); },
  addVanillaRule() {
    const v = ($('#vr-add') && $('#vr-add').value.trim().toLowerCase()) || '';
    if (v) zoneEdit((z) => { z.vanillaRules = arr(z.vanillaRules); if (!z.vanillaRules.includes(v)) z.vanillaRules.push(v); });
  },
  addDir() {
    const v = ($('#dir-add') && $('#dir-add').value.trim().toLowerCase()) || '';
    if (v) zoneEdit((z) => { z.dirAmbiences = arr(z.dirAmbiences); if (z.dirAmbiences.length < 8) z.dirAmbiences.push({ name: v, volume: 1 }); });
  },
  resetPrefs() {
    S.prefs = defaultPrefs();
    applyPrefs(); savePrefs(); render();
  },
  // two clicks: the first arms the button for 4 s, the second resets (no browser dialogs in NUI)
  async factoryReset(el) {
    if (!el.dataset.armed) {
      el.dataset.armed = '1'; el.textContent = t('ui_factory_confirm'); el.classList.add('primary');
      clearTimeout(el._disarm);
      el._disarm = setTimeout(() => { delete el.dataset.armed; el.textContent = t('ui_factory_reset'); el.classList.remove('primary'); }, 4000);
      return;
    }
    clearTimeout(el._disarm);
    const keep = (k) => k === 'jdt:waypoints' || k.startsWith('jdt:sets:');   // saved locations and entity sets are your data
    try { Object.keys(localStorage).filter((k) => k.startsWith('jdt:') && !keep(k)).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* storage unavailable */ }
    if (window.JDT_MLOX && window.JDT_MLOX.factoryReset) window.JDT_MLOX.factoryReset();
    if (window.JDT_EMIT_RESET) window.JDT_EMIT_RESET();
    try { localStorage.removeItem('jdt:emit'); localStorage.removeItem('jdt:mx:overlay'); localStorage.removeItem('jdt:ent:auto'); } catch (e) { /* storage unavailable */ }
    ACTIONS.resetPrefs();
    toast('success', t('ui_factory_done'), t('ui_factory_done_info'));
  },
  centerWindow() { S.prefs.x = null; S.prefs.y = null; applyPrefs(); savePrefs(); },
};

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('button, a, [data-toggle-portal], [data-map-room], [data-map-portal], .lrow');
  if (!el || el.closest('#modal')) return;
  const d = el.dataset;

  if (d.tab) return setTab(d.tab);
  if (d.themePick) {
    const th = THEMES.find((x) => x.id === d.themePick);
    if (th) { S.prefs.theme = th.id; S.prefs.accent = th.accent; applyPrefs(); savePrefs(); render(); }
    return;
  }
  if (d.action && ACTIONS[d.action]) return ACTIONS[d.action](el);
  if (d.npToggle) return nui('preview:toggle', { id: +d.npToggle });
  if (d.npStop) { toneIds.delete(+d.npStop); return nui('preview:stop', { id: +d.npStop }); }
  if (d.room !== undefined) { S.room = +d.room; return render(); }
  if (d.lib) { S.lib = d.lib; S.limit = 250; return render(); }
  if (d.scat !== undefined) { S.q.scat = d.scat; S.limit = 250; return render(); }
  if (d.ecat !== undefined) { S.q.ecat = d.ecat; S.limit = 250; return render(); }
  if (d.scan) {
    const pool = S.cat.sounds.filter((s) => !S.check.hidden.has(skey(s)) && (d.scan === 'all' || s.c === S.q.scat));
    if (!pool.length) return;
    S.scan = { done: 0, total: pool.length, bad: 0 };
    nui('scan:start', { items: pool.map((s) => ({ k: skey(s), n: s.n, r: s.r })), full: d.scan === 'all' });
    return render();
  }
  if (d.qp) { const input = $('[data-f="prop"]'); if (input) { input.value = d.qp; if (S.edit) liveEdit(); } return; }
  if (d.seg !== undefined) { $$('.seg button').forEach((b) => b.classList.toggle('on', b === el)); if (S.edit) liveEdit(); return; }

  // library rows
  if (d.sndPlay !== undefined) return startPreview(soundTpl(S.cat.sounds[+d.sndPlay]));
  if (d.sndHide !== undefined) { const s = S.cat.sounds[+d.sndHide]; S.check.hidden.add(skey(s)); nui('scan:hide', { key: skey(s), state: true }); return render(); }
  if (d.sndUnhide !== undefined) { const s = S.cat.sounds[+d.sndUnhide]; S.check.hidden.delete(skey(s)); nui('scan:hide', { key: skey(s), state: false }); return render(); }
  if (d.snd !== undefined) {
    const s = S.cat.sounds[+d.snd];
    return selectTemplate({ type: 'sound', sound: { name: s.n, set: s.r || '' }, label: s.s === 'amb' ? pretty(s.n) : '' });
  }
  if (d.emiPlay) { const n = S.cat.statics.find((x) => x.n === d.emiPlay); return startPreview({ type: 'ambient', ambient: { emitter: n.n, alarm: n.a || undefined }, label: pretty(n.n), sub: t('type_ambient') }); }
  if (d.emi) { const n = S.cat.statics.find((x) => x.n === d.emi); return selectTemplate({ type: 'ambient', ambient: { emitter: n.n, alarm: n.a || undefined }, label: pretty(n.n) }); }
  if (d.radioPlay) { const r = S.cat.radios.find((x) => x.n === d.radioPlay); return startPreview({ type: 'radio', radio: { station: r.n }, label: r.l, sub: t('type_radio') }); }
  if (d.radio) { const r = S.cat.radios.find((x) => x.n === d.radio); return selectTemplate({ type: 'radio', radio: { station: r.n }, label: r.l }); }
  if (d.obj) return selectTemplate({ type: 'prop', prop: { model: d.obj } });
  if (d.mutePlay) { const n = S.cat.statics.find((x) => x.n === d.mutePlay); return startPreview({ type: 'static', static: { name: n.n, default: n.on, station: undefined }, label: n.n, sub: t('type_static') }); }
  if (d.mute) { const n = S.cat.statics.find((x) => x.n === d.mute); return selectTemplate({ type: 'static', static: { name: n.n, enabled: !n.on, default: n.on, vx: n.x, vy: n.y, vz: n.z } }); }

  if (d.sample) return toggleSample(d.sample);
  // custom sounds
  if (d.csPlay) {
    const [g, k] = d.csPlay.split('/');
    const c = arr(S.custom[g]).find((x) => x.key === k);
    if (c) startPreview({ ...customTpl(c), sub: t('ui_custom_tag') });
    return;
  }
  if (d.cs) {
    const [g, k] = d.cs.split('/');
    S.csel = { group: g, key: k };
    render();
    requestAnimationFrame(() => { const det = $('#cdetail'); if (det) det.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    return;
  }
  // zones
  if (d.vruleAdd) {
    if (S.sel && S.sel.type === 'zone') { zoneEdit((z) => { z.vanillaRules = arr(z.vanillaRules); if (!z.vanillaRules.includes(d.vruleAdd)) z.vanillaRules.push(d.vruleAdd); }); return; }
    const tpl = newZoneTpl('box'); tpl.zone.vanillaRules = [d.vruleAdd]; tpl.label = pretty(d.vruleAdd.replace(/^ar_/, ''));
    return selectTemplate(tpl);
  }
  if (d.zseg) { zoneEdit((z) => { z.shape = d.zseg; }); return; }
  if (d.ruleDel !== undefined) { zoneEdit((z) => { z.rules = arr(z.rules); z.rules.splice(+d.ruleDel, 1); }); return; }
  if (d.vrDel !== undefined) { zoneEdit((z) => { z.vanillaRules = arr(z.vanillaRules); z.vanillaRules.splice(+d.vrDel, 1); }); return; }
  if (d.dirDel !== undefined) { zoneEdit((z) => { z.dirAmbiences = arr(z.dirAmbiences); z.dirAmbiences.splice(+d.dirDel, 1); }); return; }
  if (d.rulePlay !== undefined) {
    const base = readForm((S.edit && S.edit.type === 'zone') ? S.edit : S.sel);
    const r = arr(base.zone && base.zone.rules)[+d.rulePlay];
    if (!r || !r.sound) return;
    const c = customByName(r.sound);
    return startPreview(c ? { ...customTpl(c), sub: t('ui_zone_rule') } : { type: 'sound', sound: { name: r.sound, set: '' }, label: pretty(r.sound), sub: t('ui_zone_rule') });
  }
  if (d.ruleHere !== undefined) {
    const pos = await nui('playerPos');
    if (pos && pos.x !== undefined) zoneEdit((z) => { const r = z.rules[+d.ruleHere]; if (r) { r.x = pos.x; r.y = pos.y; r.z = pos.z; } });
    return;
  }
  if (d.openPlaced !== undefined && d.el) { setTab('placed'); }

  // placed rows
  if (d.elToggle) return ACTIONS.elementToggle({ dataset: { id: d.elToggle } });
  if (d.elSolo) return ACTIONS.elementSolo({ dataset: { id: d.elSolo } });
  if (d.el) {
    const e = S.elements.find((x) => x.id === d.el);
    if (!e) return;
    if (S.edit && S.edit.id !== e.id) nui('element:endLive', { id: S.edit.id });
    S.edit = clone(e);
    nui('element:focus', { id: e.id });
    render();
    requestAnimationFrame(() => { const det = $('#detail'); if (det) det.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    return;
  }

  // doors
  if (d.doorTest) return nui('doorTest', { key: d.doorTest });
  if (d.doorDetect) { const r = await action('doorDetect', { key: d.doorDetect }); if (r && r.detected) toast('success', t('ui_door_detected', t('ui_kind_' + r.detected))); return; }
  if (d.placementDel !== undefined) {
    S.interior.placements = arr(S.interior.placements).filter((_, n) => n !== +d.placementDel);
    if (S.analysis) S.analysis.placements = arr(S.analysis.placements).filter((_, n) => n !== +d.placementDel);
    markDirty(0); return render();
  }
  if (d.doorDel) { delete S.interior.doors[d.doorDel]; markDirty(0); return render(); }

  // portals / map / checks
  if (d.togglePortal !== undefined) {
    const idx = +d.togglePortal;
    S.expanded[idx] = !S.expanded[idx];
    S.portal = idx;
    nui('debug', { selected: idx }).then(updateDebug); if (window.JDT_OVERLAY) window.JDT_OVERLAY.highlight(idx);
    return render();
  }
  if (d.mapRoom !== undefined) { S.room = +d.mapRoom; return setTab('rooms'); }
  if (d.mapPortal !== undefined) return gotoPortal(+d.mapPortal);
  if (d.gotoRoom !== undefined) { S.room = +d.gotoRoom; return setTab('rooms'); }
  if (d.gotoPortal !== undefined) return gotoPortal(+d.gotoPortal);
  if (d.previewFile) {
    const res = await nui('preview', { edits: buildEdits(), kind: d.previewFile, comments: S.output.comments });
    S.preview = { kind: d.previewFile, text: (res && res.text) || '' };
    return render();
  }
  if (d.accent) { S.prefs.accent = d.accent; applyPrefs(); savePrefs(); return render(); }
  if (d.loadSave) { await action('loadSave', { file: d.loadSave }); return; }
  if (d.uninstall) {
    const g = d.uninstall;
    modal(`<h2>${esc(t('ui_uninstall'))}</h2><p class="muted">${esc(t('ui_uninstall_confirm', g))}</p>
      <div class="row end"><button class="btn ghost" data-close-modal>${esc(t('ui_cancel'))}</button><button class="btn primary danger" data-modal-ok>${esc(t('ui_uninstall'))}</button></div>`,
    async () => { await nui('uninstall', { group: g }); S.exportStatus = await nui('exportStatus'); render(); });
  }
});

function gotoPortal(idx) {
  S.portal = idx;
  S.expanded[idx] = true;
  S.portalFilter = '';
  nui('debug', { selected: idx }).then(updateDebug); if (window.JDT_OVERLAY) window.JDT_OVERLAY.highlight(idx);
  setTab('portals');
  requestAnimationFrame(() => { const c = $(`#portal-${idx}`); if (c) c.scrollIntoView({ block: 'center' }); });
}

function setTab(tab) {
  if (!TABS.includes(tab)) return;
  if (S.edit && tab !== 'placed') { nui('element:endLive', { id: S.edit.id }); S.edit = null; }
  S.tab = tab;
  savePrefs();
  $('#view').scrollTop = 0;
  if (tab === 'placed') refreshActive().then(render);
  if (tab === 'export') nui('exportStatus').then((s) => { S.exportStatus = obj(s); if (S.tab === 'export') render(); });
  render();
  const v = $('#view');
  v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter');
  const ttl = $('#title'); ttl.classList.remove('swap'); void ttl.offsetWidth; ttl.classList.add('swap');
  clearTimeout(setTab._t); setTab._t = setTimeout(() => v.classList.remove('enter'), 450);
}

$('#btn-save').addEventListener('click', () => ACTIONS.save());
$('#btn-close').addEventListener('click', () => closeUI());

/* ------------------------------------------------------------- utilities */

function copyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('success', t('ui_copied')); } catch (e) { /* ignore */ }
  ta.remove();
}

let modalCb = null;
function modal(html, onOk) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  modalCb = onOk || null;
  const first = $('textarea, input, button.primary', m);
  if (first) first.focus();
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; modalCb = null; }

$('#modal').addEventListener('click', async (ev) => {
  const card = $('.modal-card');
  if (ev.target.id === 'modal' || ev.target.closest('[data-close-modal]')) return closeModal();
  if (ev.target.closest('[data-modal-select]')) { $$('input[type=checkbox]', card).forEach((c) => { c.checked = true; }); return; }
  if (ev.target.closest('[data-copy-export]')) return copyText($('#export-text').value);
  if (ev.target.closest('[data-modal-ok]')) {
    const cb = modalCb;
    closeModal();
    if (cb) await cb(card);
  }
});

const TOAST_IC = {
  success: '<path d="M3 8.5l3.2 3L13 4.5"/>',
  error: '<path d="M4 4l8 8M12 4l-8 8"/>',
  warning: '<path d="M8 3v6.5M8 12.6v.4"/>',
  info: '<path d="M8 7v5.5M8 3.6v.4"/>',
};
const TOAST_MAX = 4;
// one card per message: the same message again bumps a ×n count and restarts its timer instead of stacking
function toast(kind, title, text) {
  kind = TOAST_IC[kind] ? kind : 'info';
  const box = $('#toasts');
  placeToasts();
  const key = `${kind}|${title}|${text || ''}`;
  const life = kind === 'error' ? 7000 : kind === 'warning' ? 5500 : 4200;
  let el = [...box.children].find((c) => c.dataset.key === key && !c.classList.contains('out'));
  if (el) {
    el._n = (el._n || 1) + 1;
    el.querySelector('.toast-n').textContent = `×${el._n}`;
    el.querySelector('.toast-n').hidden = false;
    const bar = el.querySelector('.toast-bar i'); bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = '';
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  } else {
    el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.dataset.key = key;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status'); el.title = 'Click to dismiss';
    el.style.setProperty('--life', `${life}ms`);
    el.innerHTML = `<div class="toast-ic"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">${TOAST_IC[kind]}</svg></div>
      <div class="toast-body"><b>${esc(title)}<em class="toast-n" hidden></em></b>${text ? `<span>${esc(text)}</span>` : ''}</div>
      <div class="toast-bar"><i></i></div>`;
    el.addEventListener('click', () => dropToast(el));
    // the bar is the timer: hovering pauses both
    el.querySelector('.toast-bar i').addEventListener('animationend', () => dropToast(el));
    if (box.classList.contains('under')) box.prepend(el); else box.appendChild(el);   // newest nearest the panel
    // keep the stack on screen: the oldest go first when there are too many or no room left below the panel
    const under = box.classList.contains('under');
    const room = under ? innerHeight - box.getBoundingClientRect().top - 10 : innerHeight - 30;
    let live = [...box.children].filter((c) => !c.classList.contains('out'));
    let h = live.reduce((t, c) => t + c.offsetHeight + 8, 0);
    while (live.length > 1 && (live.length > TOAST_MAX || h > room)) {
      const old = under ? live.pop() : live.shift();
      h -= old.offsetHeight + 8; dropToast(old);
    }
  }
}
function dropToast(el) {
  if (!el || el.classList.contains('out')) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 200);
}

// notifications sit just below the panel, centred on it (wherever it was moved); bottom-right when it is closed
function placeToasts() {
  const box = $('#toasts'), shell = $('#shell');
  const open = shell && !$('#app').classList.contains('closed');
  box.classList.toggle('under', !!open);
  if (!open) { box.style.top = box.style.left = ''; return; }
  const r = shell.getBoundingClientRect();
  box.style.left = `${Math.round(r.left + r.width / 2)}px`;
  box.style.top = `${Math.round(Math.min(r.bottom + 12, innerHeight - 70))}px`;
}
window.addEventListener('resize', () => { if ($('#toasts').children.length) placeToasts(); });

/* ------------------------------------------------------------------ HUD */

function renderHud(d) {
  const hud = $('#hud');
  const what = d.moving ? t('ui_hud_moving', d.moving) : (d.template || t('ui_hud_nothing'));
  hud.innerHTML = `
    <div class="hud-top"><span class="dot ${d.type || ''}"></span><b>${esc(what)}</b></div>
    <div class="hud-meta">${esc(t('ui_group'))} <b>${esc(d.group)}</b>${d.room ? ` · ${esc(t('ui_room'))} <b>${esc(d.room)}</b>` : d.inside ? '' : ` · <span class="warn-text">${esc(t('ui_hud_outside'))}</span>`}</div>
    <div class="hud-stats">
      <div><span>${esc(d.type === 'zone' ? t('ui_zone_size') : t('ui_range'))}</span><b>${Number(d.type === 'zone' ? d.range * 2 : d.range).toFixed(1)} m</b></div>
      <div><span>${esc(t('ui_height'))}</span><b>${d.height >= 0 ? '+' : ''}${Number(d.height).toFixed(1)} m</b></div>
      ${d.showHeading ? `<div><span>${esc(t('ui_rotation'))}</span><b>${Math.round(d.heading)}°</b></div>` : ''}
    </div>
    ${d.hover ? `<div class="hud-hover">${esc(t('ui_hud_aimed'))}: <b>${esc(d.hover.label)}</b> <span class="muted">${esc(d.hover.what)}</span></div>` : ''}
    <div class="keys">
      <span><kbd>E</kbd>${esc(d.moving ? t('ui_key_confirm') : t('ui_key_place'))}</span>
      <span><kbd>Q</kbd>${esc(d.previewing ? t('ui_key_stop') : t('ui_key_listen'))}</span>
      <span><kbd>${esc(t('ui_key_wheel'))}</kbd>${esc(d.type === 'zone' ? t('ui_zone_size') : t('ui_range'))}</span>
      <span><kbd>⇧+${esc(t('ui_key_wheel'))}</kbd>${esc(t('ui_height'))}</span>
      ${d.showHeading ? `<span><kbd>← →</kbd>${esc(t('ui_rotation'))}</span>` : ''}
      <span><kbd>G</kbd>${esc(t('ui_move'))}</span>
      <span><kbd>H</kbd>${esc(t('ui_key_edit'))}</span>
      <span><kbd>X</kbd>${esc(t('ui_delete'))}</span>
      <span><kbd>TAB</kbd>${esc(t('ui_key_panel'))}</span>
      <span><kbd>⌫</kbd>${esc(t('ui_key_back'))}</span>
    </div>`;
}

/* -------------------------------------------------------------- open/close */

function showPanel(data) {
  S.visible = true;
  S.aiming = false;
  $('#hud').hidden = true;
  if (data.group) S.group = data.group;
  if (data.range) S.range = data.range;
  if (data.elements) S.elements = arr(data.elements);
  if (data.previews) S.previews = arr(data.previews);
  if (data.exportStatus) S.exportStatus = obj(data.exportStatus);
  if (data.doorSamples) S.doorSamples = obj(data.doorSamples);
  if (data.customSounds) { S.custom = obj(data.customSounds); Object.keys(S.custom).forEach((g) => { S.custom[g] = arr(S.custom[g]); }); }
  if (data.debug) updateDebug(data.debug);
  if (data.opened) {
    S.preview = { kind: 'ymt', text: '' };
    S.saves = null;
    S.lastResult = null;
    S.dirty = false;
    S.sel = null;
    S.edit = null;
    if (typeof data.roomIndex === 'number' && data.roomIndex >= 0) { S.room = data.roomIndex; S.hereRoom = data.roomIndex; }
    if (data.interior === false && NEEDS_INTERIOR.includes(S.tab)) S.tab = S.outsideTab || 'library';
  }
  if (data.editId) {
    const e = S.elements.find((x) => x.id === data.editId);
    if (e) { S.tab = 'placed'; S.edit = clone(e); }
  }
  if (data.interior !== undefined) {
    if (data.interior === false) { S.interior = null; S.analysis = null; }
    else {
      S.analysis = data.analysis;
      if (S.analysis) { S.analysis.issues = arr(S.analysis.issues); if (S.analysis.summary) S.analysis.summary.reach = arr(S.analysis.summary.reach); }
      S.doorSpots = obj(data.doorSpots);
      S.interior = normalize(data.interior);
      if (S.room >= S.interior.rooms.length) S.room = 0;
    }
  }
  const app = $('#app');
  app.classList.remove('closed');
  app.setAttribute('aria-hidden', 'false');
  refreshActive().then(render);
  render();
  $('#view').focus({ preventScroll: true });
}

function hidePanel() {
  S.visible = false;
  $('#app').classList.add('closed');
  $('#app').setAttribute('aria-hidden', 'true');
  closeModal();
}

function closeUI() {
  clearTimeout(syncTimer);
  hidePanel();
  setFreeMove(false);
  S.edit = null;
  nui('close', { edits: buildEdits() });
}

/* --------------------------------------------------------------- keyboard */

document.addEventListener('keydown', (ev) => {
  if (!S.visible) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
  if (ev.key === 'Escape') {
    ev.preventDefault();
    if (!$('#modal').hidden) return closeModal();
    const mw = $$('.modal-wrap.open');
    if (mw.length) { mw[mw.length - 1].click(); return; }
    return closeUI();
  }
  if (window.JDT_KEYBIND && window.JDT_KEYBIND(ev, typing)) return;   // Settings > Keybinds
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); return ACTIONS.save(); }
  if (ev.altKey && /^[0-9]$/.test(ev.key)) { ev.preventDefault(); return setTab(TABS[(+ev.key + 9) % 10]); }
  if (ev.altKey && ev.shiftKey && /^Digit[0-9]$/.test(ev.code)) { ev.preventDefault(); return setTab(TABS[10 + ((+ev.code.slice(5) + 9) % 10)] || TABS[TABS.length - 1]); }
  if (ev.key === 'Enter' && ev.target.dataset && ev.target.dataset.togglePortal !== undefined) ev.target.click();
});

/* -------------------------------------------------------------- free move */

let freeMove = false;
function setFreeMove(on) {
  if (freeMove === on) return;
  freeMove = on;
  $('#freemove-tip').hidden = !on;
  $('#freemove-tip').textContent = t('ui_freemove_active');
  nui('freeMove', { enabled: on });
}
document.addEventListener('mousedown', (ev) => {
  if (S.visible && ev.button === (S.ui.freeMoveButton ?? 2) && !ev.target.closest('input, textarea, select')) {
    if (ev.button === 0 && ev.target.closest('#app, #modal')) return;
    ev.preventDefault();
    setFreeMove(true);
  }
});
document.addEventListener('mouseup', (ev) => { if (ev.button === (S.ui.freeMoveButton ?? 2)) setFreeMove(false); });
document.addEventListener('contextmenu', (ev) => ev.preventDefault());
window.addEventListener('blur', () => setFreeMove(false));

/* ------------------------------------------------------- drag & drop audio */

document.addEventListener('dragover', (ev) => {
  const dz = ev.target.closest && ev.target.closest('#drop');
  if (dz) { ev.preventDefault(); dz.classList.add('over'); }
});
document.addEventListener('dragleave', (ev) => { const dz = ev.target.closest && ev.target.closest('#drop'); if (dz) dz.classList.remove('over'); });
document.addEventListener('drop', (ev) => {
  const dz = ev.target.closest && ev.target.closest('#drop');
  if (!dz) return;
  ev.preventDefault();
  dz.classList.remove('over');
  uploadFiles([...(ev.dataTransfer && ev.dataTransfer.files ? ev.dataTransfer.files : [])]);
});

/* ----------------------------------------------------------------- resize */

(function windowControls() {
  const shell = $('#shell');
  const handle = $('.resize');
  let mode = null, sx = 0, sy = 0, sw = 0, sh = 0, ox = 0, oy = 0;
  handle.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const r = shell.getBoundingClientRect();
    mode = 'resize'; sx = ev.clientX; sy = ev.clientY; sw = r.width; sh = r.height;
    if (S.prefs.x === null || S.prefs.x === undefined) { S.prefs.x = r.left; S.prefs.y = r.top; placeShell(); }
    ev.preventDefault(); ev.stopPropagation();
  });
  $('#topbar').addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('button')) return;
    const r = shell.getBoundingClientRect();
    mode = 'drag'; ox = ev.clientX - r.left; oy = ev.clientY - r.top;
    S.prefs.x = r.left; S.prefs.y = r.top; placeShell();
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (mode === 'resize') {
      S.prefs.width = Math.round(clamp(sw + ev.clientX - sx, 720, 1600));
      S.prefs.height = Math.round(clamp(sh + ev.clientY - sy, 520, 1100));   // 520: every tab still fits
      applyPrefs();
      $('#rail')._html = null;
      renderRail();   // re-fit the sidebar sections to the new height
    } else if (mode === 'drag') {
      S.prefs.x = ev.clientX - ox; S.prefs.y = ev.clientY - oy;
      placeShell();
    }
  });
  window.addEventListener('mouseup', () => { if (mode) { mode = null; savePrefs(); if (S.tab === 'settings') render(); } });
  window.addEventListener('resize', placeShell);
})();

/* --------------------------------------------------------------- messages */

window.addEventListener('message', (ev) => {
  const { action: name, data } = ev.data || {};
  switch (name) {
    case 'panel':
      if (data && data.visible === false) hidePanel(); else showPanel(data || {});
      break;
    case 'close': hidePanel(); $('#hud').hidden = true; break;
    case 'requestClose': closeUI(); break;
    case 'interior': applyPayload(data); break;
    case 'elements':
      S.elements = arr(data);
      if (S.edit && !S.elements.find((e) => e.id === S.edit.id)) S.edit = null;
      if (S.visible && ['placed', 'overview', 'library', 'checks'].includes(S.tab)) refreshActive().then(render);
      else renderRail();
      break;
    case 'previews':
      S.previews = arr(data).map((p) => ({ ...p, tone: toneIds.has(p.id) }));
      if (S.visible) { renderNowPlaying(); if (S.tab === 'rooms') render(); }
      break;
    case 'exportStatus': S.exportStatus = obj(data); if (S.visible) { renderRail(); if (S.tab === 'export') render(); } break;
    case 'soundCheck':
      S.check = { bad: new Set(arr(data.bad)), hidden: new Set(arr(data.hidden)), checked: data.checked || 0, at: data.at || null };
      if (S.visible && S.tab === 'library') render();
      break;
    case 'scanProgress':
      S.scan = data.finished ? null : data;
      if (data.finished && data.aborted) toast('info', t('ui_scan_stopped'));
      if (S.visible && S.tab === 'library') {
        if (data.finished) render();
        else { const b = $('#banner'); if (b) b.innerHTML = checkBanner(); }
      }
      break;
    case 'soundFailed':
      S.failed.add((data.set || '') + '|' + data.name);
      toast('warning', t('ui_sound_failed'), data.name);
      if (S.visible && S.tab === 'library') render();
      break;
    case 'aim':
      S.aiming = !!data.active;
      $('#hud').hidden = !S.aiming;
      if (S.aiming) { hidePanel(); renderHud({ group: S.group, range: S.range, height: 0, heading: 0 }); }
      break;
    case 'hud': renderHud(data); break;
    case 'customSounds':
      S.custom = obj(data);
      Object.keys(S.custom).forEach((g) => { S.custom[g] = arr(S.custom[g]); });
      if (S.csel && !arr(S.custom[S.csel.group]).some((c) => c.key === S.csel.key)) S.csel = null;
      if (S.visible && ['library', 'rooms', 'overview', 'export', 'placed'].includes(S.tab) && !S.upload) render();
      break;
    case 'voice':
      if (!window.JDT_AUDIO) break;
      if (data.op === 'play') window.JDT_AUDIO.play(data); else window.JDT_AUDIO.stop(data.id);
      break;
    case 'listener': if (window.JDT_AUDIO) window.JDT_AUDIO.listener(data); break;
    case 'doorSamples': S.doorSamples = obj(data); break;
    case 'soundData': {
      const f = fetches[data.requestId];
      if (!f) break;
      f.parts[data.index - 1] = data.data;
      if (f.parts.filter((x) => x !== undefined).length === f.count) {
        delete fetches[data.requestId];
        try { f.resolve(window.JDT_AUDIO.fromBase64(f.parts.join(''))); } catch (e) { f.reject(e); }
      }
      break;
    }
    case 'toast': toast(data.kind, data.title, data.text); break;
    case 'requestSync': nui('sync', { edits: buildEdits(), autosave: true }).then((p) => applyPayload(p, true, S.editVersion)); break;
    default: break;
  }
});

/* Keep "playing" states truthful while the panel is open */
setInterval(async () => {
  if (!S.visible) return;
  const before = [...S.active].sort().join();
  await refreshActive();
  if ([...S.active].sort().join() === before) return;
  renderNowPlaying();
  const a = document.activeElement;
  const typing = a && /INPUT|TEXTAREA|SELECT/.test(a.tagName);
  if (S.tab === 'placed' && !typing) render();
}, 1500);

/* ------------------------------------------------------------------- boot */

(async function boot() {
  const cfg = await nui('ready');
  if (cfg) {
    S.locales = cfg.locales && !Array.isArray(cfg.locales) ? cfg.locales : {};
    S.presets = arr(cfg.presets);
    S.fields = arr(cfg.fields);
    S.doorSounds = arr(cfg.doorSounds);
    S.doorCustomSounds = arr(cfg.doorCustomSounds);
    S.doorTunings = arr(cfg.doorTunings);
    if (cfg.sounds) S.soundsCfg = { ...S.soundsCfg, ...cfg.sounds };
    S.ui = cfg.ui || {};
    S.player = cfg.player !== false;
    S.openKey = cfg.openKey || 'F5';
    S.keybinds = arr(cfg.keybinds);
    S.version = cfg.version || '';
    S.resource = cfg.resource || S.resource;
    S.outsideTab = cfg.outsideTab || 'library';
    S.inspectCfg = cfg.inspect || {};
    if (cfg.output) S.output = { ...S.output, ...cfg.output };
    if (cfg.place) { S.place = cfg.place; S.range = cfg.place.defaultRange || 15; S.group = cfg.place.defaultGroup || 'default'; }
    S.prefs = defaultPrefs();
  }
  loadPrefs();
  applyPrefs();
  loadCatalogs();
  $$('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  renderHeader();
  renderRail();
})();

/* ------------------------------------------------ suggestions for text fields
   FiveM's browser never draws a <datalist> popup, so every input with a `list` gets this
   dropdown instead: it filters the datalist's options as you type (all words must match). */
(function () {
  const pop = document.createElement('div');
  pop.className = 'picker ac-pop';
  pop.hidden = true;
  document.body.appendChild(pop);
  let input = null;
  let active = -1;

  const optionsOf = (el) => {
    const dl = document.getElementById(el.dataset.ac || '');
    return dl ? [...dl.options].map((o) => ({ v: o.value, l: o.label && o.label !== o.value ? o.label : '' })) : [];
  };

  function place() {
    const r = input.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    pop.style.width = `${Math.max(r.width, 220)}px`;
    const below = window.innerHeight - r.bottom;
    if (below < 200 && r.top > below) { pop.style.top = ''; pop.style.bottom = `${window.innerHeight - r.top + 4}px`; }
    else { pop.style.bottom = ''; pop.style.top = `${r.bottom + 4}px`; }
  }

  function show() {
    if (!input || !document.body.contains(input)) return hide();
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = optionsOf(input).filter((o) => words.every((w) => o.v.toLowerCase().includes(w) || o.l.toLowerCase().includes(w))).slice(0, 60);
    if (!hits.length || (hits.length === 1 && hits[0].v === input.value)) return hide();
    active = -1;
    pop.innerHTML = hits.map((o, i) => `<div class="pick" data-i="${i}" data-v="${esc(o.v)}"><span class="name">${esc(o.v)}</span>${o.l ? `<span class="tag">${esc(o.l)}</span>` : ''}</div>`).join('');
    place();
    pop.hidden = false;
  }

  function hide() { pop.hidden = true; active = -1; }

  function choose(v) {
    if (!input) return;
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    hide();
  }

  function mark(i) {
    const rows = [...pop.querySelectorAll('.pick')];
    if (!rows.length) return;
    active = (i + rows.length) % rows.length;
    rows.forEach((r, k) => r.classList.toggle('on', k === active));
    rows[active].scrollIntoView({ block: 'nearest' });
  }

  document.addEventListener('focusin', (ev) => {
    const el = ev.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (el.hasAttribute('list')) { el.dataset.ac = el.getAttribute('list'); el.removeAttribute('list'); }
    if (!el.dataset.ac) return;
    input = el;
    show();
  });
  document.addEventListener('focusout', (ev) => { if (ev.target === input) setTimeout(() => { if (document.activeElement !== input) hide(); }, 150); });
  document.addEventListener('input', (ev) => { if (ev.target === input && ev.isTrusted) show(); });
  document.addEventListener('keydown', (ev) => {
    if (pop.hidden || ev.target !== input) return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); mark(active + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); mark(active - 1); }
    else if (ev.key === 'Enter' && active >= 0) { ev.preventDefault(); choose(pop.querySelectorAll('.pick')[active].dataset.v); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); hide(); }
  }, true);
  pop.addEventListener('mousedown', (ev) => {
    const row = ev.target.closest('.pick');
    ev.preventDefault();
    if (row) choose(row.dataset.v);
  });
  document.addEventListener('scroll', () => { if (!pop.hidden && input) place(); }, true);
})();
