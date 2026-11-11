/* JDT | server/ytyp.js - finds the entity sets of an MLO.

   GTA has no native that lists an interior's entity sets, but every MLO's .ytyp does. On request this
   reads the .ytyp files of the started resources (binary RSC7 meta, or CodeWalker .ytyp.xml),
   finds the MLO archetype by its name hash and returns its entity sets.

   A binary .ytyp stores set names as hashes, so they are matched against a dictionary:
   catalog/entitysets.json (GTA's own set names), names in .ytyp.xml files, and every word found in
   the text files (lua / js / json / xml / cfg / md ...) of the started resources - MLO resources and
   set managers usually name their sets there. A set nobody names is returned with its hash, and the
   panel lets you type the name (it is checked against the hash).

   Work happens once, lazily, off the main thread (async fs), and is cached until a resource starts
   or stops. */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const RES = GetCurrentResourceName();
const MLO_ARCHETYPE = 0x10506455;     // CMloArchetypeDef, 240 bytes; entitySets array at +200
const TEXT_EXT = new Set(['.lua', '.js', '.ts', '.json', '.xml', '.cfg', '.txt', '.md', '.meta', '.html', '.ini', '.yaml', '.yml']);
const SKIP_DIR = new Set(['node_modules', '.git', 'cache', '.vscode', 'dist-ssr']);
const MAX_TEXT = 1.5 * 1024 * 1024, MAX_YTYP = 32 * 1024 * 1024;

const joaat = (s) => {
  let h = 0;
  s = String(s).toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h = (h + s.charCodeAt(i)) >>> 0;
    h = (h + ((h << 10) >>> 0)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + ((h << 3) >>> 0)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + ((h << 15) >>> 0)) >>> 0;
  return h >>> 0;
};

/* ---------- .ytyp readers ---------- */

// binary RSC7 meta: [{ arch, sets: [hash] }]
function readBinary(buf) {
  if (buf.length < 32 || buf.readUInt32LE(0) !== 0x37435352) return [];
  const d = zlib.inflateRawSync(buf.subarray(16));
  const off = (p) => Number(p & 0x0FFFFFFFn);
  const dbp = off(d.readBigUInt64LE(0x30)), dbc = d.readUInt16LE(0x4C);
  const blocks = [];
  for (let i = 0; i < dbc; i++) {
    const o = dbp + i * 16;
    blocks.push({ h: d.readUInt32LE(o), len: d.readInt32LE(o + 4), o: off(d.readBigUInt64LE(o + 8)) });
  }
  const out = [];
  blocks.filter((b) => b.h === MLO_ARCHETYPE).forEach((b) => {
    for (let a = b.o; a + 240 <= b.o + b.len; a += 240) {
      const arch = d.readUInt32LE(a + 88);
      const ptr = d.readUInt32LE(a + 200), count = d.readUInt16LE(a + 208);
      const sets = [];
      const sb = blocks[(ptr & 0xFFF) - 1];
      if (count && sb) {
        for (let i = 0; i < count; i++) {
          const o = sb.o + (ptr >>> 12) + i * 48;           // CMloEntitySet, 48 bytes; name hash at +8
          if (o + 12 <= d.length) sets.push(d.readUInt32LE(o + 8));
        }
      }
      out.push({ arch, sets });
    }
  });
  return out;
}

// CodeWalker .ytyp.xml: names are plain text here
function readXml(text, names) {
  const out = [];
  const re = /<Item type="CMloArchetypeDef">([\s\S]*?)<\/Item>\s*(?=<Item type=|<\/archetypes>)/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const nm = /<name>([^<]+)<\/name>/.exec(body);
    if (!nm) continue;
    const sets = [];
    const es = /<entitySets>([\s\S]*?)<\/entitySets>/.exec(body);
    if (es) {
      const sre = /<Item>\s*<name>([^<]+)<\/name>/g;
      let s;
      while ((s = sre.exec(es[1]))) { const n = s[1].trim(); names.set(joaat(n), n); sets.push(joaat(n)); }
    }
    out.push({ arch: joaat(nm[1].trim()), sets });
  }
  return out;
}

/* ---------- scanning ---------- */

let index = null;        // Promise<Map arch -> { resource, file, sets }>
let dict = null;         // Promise<Map hash -> name>
const xmlNames = new Map();

function startedResources() {
  const out = [];
  for (let i = 0; i < GetNumResources(); i++) {
    const r = GetResourceByFindIndex(i);
    if (r && GetResourceState(r) === 'started') out.push(r);
  }
  return out;
}

async function walk(dir, visit, depth = 0) {
  if (depth > 10) return;
  let list;
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name.toLowerCase())) await walk(p, visit, depth + 1); }
    else if (e.isFile()) await visit(p, e.name.toLowerCase());
  }
}

function buildIndex() {
  return (async () => {
    const map = new Map();
    for (const res of startedResources()) {
      const root = GetResourcePath(res);
      if (!root) continue;
      await walk(root, async (p, lower) => {
        const isXml = lower.endsWith('.ytyp.xml');
        if (!isXml && !lower.endsWith('.ytyp')) return;
        try {
          const st = await fsp.stat(p);
          if (st.size > MAX_YTYP) return;
          const arches = isXml ? readXml(await fsp.readFile(p, 'utf8'), xmlNames) : readBinary(await fsp.readFile(p));
          arches.forEach((a) => {
            const prev = map.get(a.arch);
            if (!prev || (!prev.sets.length && a.sets.length)) map.set(a.arch, { resource: res, file: path.relative(root, p).replace(/\\/g, '/'), sets: a.sets });
          });
        } catch (e) { /* not a readable ytyp: skip */ }
      });
    }
    return map;
  })();
}

function buildDict() {
  return (async () => {
    const map = new Map();
    const add = (w) => { if (w.length >= 2 && w.length <= 64) { const h = joaat(w); if (!map.has(h)) map.set(h, w); } };
    try { JSON.parse(LoadResourceFile(RES, 'catalog/entitysets.json') || '[]').forEach(add); } catch (e) { /* no catalog */ }
    ['tint', 'tints', 'entity_set_tint', 'entity_set_tints'].forEach(add);
    xmlNames.forEach((n) => add(n));
    for (const res of startedResources()) {
      const root = GetResourcePath(res);
      if (!root) continue;
      await walk(root, async (p, lower) => {
        if (!TEXT_EXT.has(path.extname(lower))) return;
        try {
          const st = await fsp.stat(p);
          if (st.size > MAX_TEXT) return;
          const words = (await fsp.readFile(p, 'utf8')).match(/[A-Za-z0-9_][A-Za-z0-9_\-.]{1,63}/g);
          if (words) words.forEach(add);
        } catch (e) { /* unreadable: skip */ }
      });
    }
    return map;
  })();
}

function invalidate(res) { if (res !== RES) { index = null; dict = null; } }
on('onResourceStart', invalidate);
on('onResourceStop', invalidate);

/* ---------- requests ---------- */

async function lookup(arch) {
  arch = Number(arch) >>> 0;
  if (!index) index = buildIndex();
  const hit = (await index).get(arch);
  if (!hit) return { found: false };
  let names = null;
  if (hit.sets.length) { if (!dict) dict = buildDict(); names = await dict; }
  return {
    found: true, resource: hit.resource, file: hit.file,
    sets: hit.sets.map((h) => ({ hash: h, name: (names && names.get(h)) || null })),
  };
}

onNet('jdt:ytypSets', (id, arch) => {
  const src = global.source;
  lookup(arch)
    .then((r) => emitNet('jdt:ytypSetsResult', src, id, r))
    .catch((e) => emitNet('jdt:ytypSetsResult', src, id, { found: false, error: String(e && e.message || e) }));
});

exports('ytypSets', (arch) => lookup(arch));
