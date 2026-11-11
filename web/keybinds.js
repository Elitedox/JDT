/* JDT | web/keybinds.js - Settings > Keybinds: click a bind, press a key, it is live and saved (per player).
   The game watches the keys while the panel is closed (client/keybinds.lua); while the panel is open
   this file handles the same binds. Esc cancels a capture, Backspace / Delete clears the bind. */
'use strict';

(function () {
  let capturing = null;   // action id waiting for a key

  const NAMES = { 8: 'Backspace', 9: 'Tab', 13: 'Enter', 19: 'Pause', 20: 'CapsLock', 32: 'Space', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
    37: '←', 38: '↑', 39: '→', 40: '↓', 45: 'Insert', 46: 'Delete', 106: 'Num *', 107: 'Num +', 109: 'Num -', 110: 'Num .', 111: 'Num /',
    186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: "'" };
  const vkName = (vk) => {
    if (!vk) return '';
    if (vk >= 112 && vk <= 123) return 'F' + (vk - 111);
    if ((vk >= 48 && vk <= 57) || (vk >= 65 && vk <= 90)) return String.fromCharCode(vk);
    if (vk >= 96 && vk <= 105) return 'Num ' + (vk - 96);
    return NAMES[vk] || `#${vk}`;
  };
  const list = () => (Array.isArray(S.keybinds) ? S.keybinds : []);
  const DESC = {
    toggle: 'Opens the panel, and closes it again (Esc also closes it).',
    noclip: 'Free camera: mouse aims, W flies, Shift boosts, wheel sets the speed.',
    god: 'No damage, no ragdoll, full health and armour.',
    repair: 'Fixes, washes and refuels the vehicle you are in.',
    marker: 'Takes you to the waypoint on the map, on the ground.',
  };

  function rowHTML(b) {
    const cap = capturing === b.id;
    return `<div class="kb-row${cap ? ' capturing' : ''}" data-kb="${b.id}">
      <div class="kb-main"><b>${esc(b.label)}</b><span>${esc(DESC[b.id] || '')}</span></div>
      <button class="kb-key${b.vk ? '' : ' none'}" data-kb-capture="${b.id}" title="Click, then press a key">${cap ? 'Press a key…' : b.vk ? esc(vkName(b.vk)) : 'Not bound'}</button>
      <button class="kb-act" data-kb-default="${b.id}" title="Back to the default (${esc(vkName(b.default) || 'not bound')})"${b.vk === b.default ? ' disabled' : ''}>↺</button>
      <button class="kb-act" data-kb-clear="${b.id}" title="Clear"${b.vk ? '' : ' disabled'}>✕</button>
    </div>`;
  }

  window.keybindsSection = () => {
    const l = list();
    if (!l.length) return '';
    const live = l.every((b) => b.live !== false);
    return `<h3>Keybinds</h3>
      <div class="group kb-group" id="kb-group">
        <p class="muted small">${live ? 'Click a key, then press the new one. It works straight away and is saved on this PC. Esc cancels, Backspace clears.' : 'This FiveM build cannot read keys directly: change these in GTA Settings > Key Bindings > FiveM.'}</p>
        <div class="kb-list" id="kb-list">${l.map(rowHTML).join('')}</div>
        <div class="row end"><button class="btn sm ghost" data-kb-resetall>Reset all keybinds</button></div>
      </div>`;
  };

  function paint() {
    const el = document.getElementById('kb-list');
    if (el) el.innerHTML = list().map(rowHTML).join('');
  }

  async function save(binds, msg) {
    const r = await nui('keys:set', { binds });
    if (r && Array.isArray(r.list)) { S.keybinds = r.list; paint(); if (msg) toast('success', msg[0], msg[1]); }
    else toast('error', 'Keybind not saved', 'Restart jdt so the game loads the latest files.');
  }

  document.addEventListener('click', async (ev) => {
    const c = ev.target.closest('[data-kb-capture]');
    if (c) { capturing = capturing === c.dataset.kbCapture ? null : c.dataset.kbCapture; paint(); return; }
    const d = ev.target.closest('[data-kb-default]');
    if (d) { const b = list().find((x) => x.id === d.dataset.kbDefault); if (b) save({ [b.id]: b.default }, ['Back to default', `${b.label}: ${vkName(b.default) || 'not bound'}`]); return; }
    const x = ev.target.closest('[data-kb-clear]');
    if (x) { save({ [x.dataset.kbClear]: 0 }); return; }
    if (ev.target.closest('[data-kb-resetall]')) {
      const r = await nui('keys:reset');
      if (r && Array.isArray(r.list)) { S.keybinds = r.list; paint(); toast('success', 'Keybinds reset', 'Every key is back to its default.'); }
      return;
    }
    if (capturing && !ev.target.closest('.kb-row')) { capturing = null; paint(); }
  });

  // capture runs before every other key handler
  document.addEventListener('keydown', (ev) => {
    if (!capturing) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    const id = capturing;
    if (ev.keyCode === 27) { capturing = null; paint(); return; }                               // Esc: cancel
    if (ev.keyCode === 8 || ev.keyCode === 46) { capturing = null; save({ [id]: 0 }); return; }   // Backspace / Delete: clear
    if ([16, 17, 18, 91, 92, 93].includes(ev.keyCode)) return;                                  // wait for a real key
    capturing = null;
    const taken = list().find((b) => b.id !== id && b.vk === ev.keyCode);
    const me = list().find((b) => b.id === id);
    save({ [id]: ev.keyCode }, taken ? [`${vkName(ev.keyCode)} moved`, `from ${taken.label} to ${me ? me.label : id}`] : [`${me ? me.label : id}: ${vkName(ev.keyCode)}`, 'Saved, and working right away.']);
  }, true);

  // while the panel is open it has the keyboard: run the binds here
  window.JDT_KEYBIND = (ev, typing) => {
    if (capturing) return false;
    const fkey = ev.keyCode >= 112 && ev.keyCode <= 123;
    if (typing && !fkey) return false;
    const b = list().find((x) => x.vk && x.vk === ev.keyCode);
    if (!b) return false;
    ev.preventDefault();
    if (b.id === 'toggle') { closeUI(); return true; }
    if (b.id === 'noclip') closeUI();   // flying needs the mouse and keyboard back
    nui('keys:run', { id: b.id }).then(() => { if ((window.JDT_UTIL_TABS || []).includes(S.tab) && typeof render === 'function') render(); });
    return true;
  };
  window.JDT_VKNAME = vkName;
})();
