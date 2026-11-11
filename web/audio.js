/* JDT - custom sounds in the panel: file conversion for uploads and 3D playback
   of sounds the game has not loaded yet (the client sends the camera every frame). */
'use strict';

(function () {
  let ctx = null;
  const buffers = new Map();   // 'group/key' -> Promise<AudioBuffer>
  const voices = new Map();    // id -> { src, gain, panner }
  let fetcher = null;          // (group, key) => Promise<ArrayBuffer>
  let onEnded = null;          // (id) => void

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  /* GTA is z-up, Web Audio is y-up: (x, y, z) -> (x, z, -y) */
  const toWeb = (x, y, z) => [x, z, -y];

  function setParam(p, v) {
    if (!p) return;
    try { p.setTargetAtTime(v, ctx.currentTime, 0.02); } catch (e) { p.value = v; }
  }

  function listener(m) {
    if (!ctx) return;
    const L = ctx.listener;
    const [px, py, pz] = toWeb(m.x, m.y, m.z);
    const [fx, fy, fz] = toWeb(m.fx, m.fy, m.fz);
    const [ux, uy, uz] = toWeb(m.ux, m.uy, m.uz);
    if (L.positionX) {
      setParam(L.positionX, px); setParam(L.positionY, py); setParam(L.positionZ, pz);
      setParam(L.forwardX, fx); setParam(L.forwardY, fy); setParam(L.forwardZ, fz);
      setParam(L.upX, ux); setParam(L.upY, uy); setParam(L.upZ, uz);
    } else {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  function decode(arrayBuffer) {
    const c = ensureCtx();
    return new Promise((resolve, reject) => c.decodeAudioData(arrayBuffer.slice(0), resolve, reject));
  }

  function getBuffer(group, key) {
    const id = `${group}/${key}`;
    if (!buffers.has(id)) {
      if (!fetcher) return Promise.reject(new Error('no fetcher'));
      const p = fetcher(group, key).then(decode);
      p.catch(() => buffers.delete(id));
      buffers.set(id, p);
    }
    return buffers.get(id);
  }

  function putBuffer(group, key, audioBuffer) { buffers.set(`${group}/${key}`, Promise.resolve(audioBuffer)); }
  function forget(group, key) { buffers.delete(`${group}/${key}`); }

  async function play(m) {
    const c = ensureCtx();
    let buf;
    try { buf = await getBuffer(m.group, m.key); } catch (e) { if (onEnded) onEnded(m.id); return; }
    if (voices.has(m.id)) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = !!m.loop;
    const gain = c.createGain();
    gain.gain.value = Math.pow(10, (Number(m.volume) || 0) / 20);
    let last = gain;
    let panner = null;
    if (m.x !== undefined && m.x !== null) {
      panner = c.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'linear';
      panner.refDistance = 1;
      panner.maxDistance = Math.max(2, Number(m.range) || 20);
      panner.rolloffFactor = 1;
      const [px, py, pz] = toWeb(m.x, m.y, m.z);
      if (panner.positionX) { panner.positionX.value = px; panner.positionY.value = py; panner.positionZ.value = pz; } else panner.setPosition(px, py, pz);
      gain.connect(panner);
      last = panner;
    }
    src.connect(gain);
    last.connect(c.destination);
    src.onended = () => { voices.delete(m.id); if (onEnded) onEnded(m.id); };
    voices.set(m.id, { src, gain, panner });
    src.start();
  }

  function stop(id) {
    const v = voices.get(id);
    if (!v) return;
    voices.delete(id);
    try { v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03); v.src.stop(ctx.currentTime + 0.12); } catch (e) { /* already stopped */ }
  }

  /* ---------------------------------------------------- upload conversion */

  /* Any audio file the browser can decode -> mono 16-bit WAV at `rate`. */
  async function convertFile(file, rate) {
    const data = await file.arrayBuffer();
    const decoded = await decode(data);
    const targetRate = Math.min(48000, Math.max(8000, Math.round(rate || decoded.sampleRate)));
    const length = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const off = new OfflineAudioContext(1, length, targetRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);   // channels are mixed down to mono by the 1-channel destination
    src.start();
    const mono = await off.startRendering();
    const ch = mono.getChannelData(0);
    let peak = 0;
    const pcm = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      const a = Math.abs(v);
      if (a > peak) peak = a;
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
    }
    const wav = new Uint8Array(44 + pcm.length * 2);
    const dv = new DataView(wav.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) wav[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, targetRate, true); dv.setUint32(28, targetRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    wav.set(new Uint8Array(pcm.buffer), 44);
    return {
      wav, buffer: mono, seconds: mono.duration, peak, rate: targetRate,
      sourceRate: decoded.sampleRate, channels: decoded.numberOfChannels,
    };
  }

  function toBase64(bytes) {
    let s = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    return btoa(s);
  }

  function fromBase64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out.buffer;
  }

  /* Min / max pairs for drawing a waveform `width` columns wide. */
  function waveform(buffer, width) {
    const d = buffer.getChannelData(0);
    const per = Math.max(1, Math.floor(d.length / width));
    const out = [];
    for (let x = 0; x < width; x++) {
      let lo = 1, hi = -1;
      const start = x * per;
      for (let i = start; i < Math.min(d.length, start + per); i += Math.max(1, Math.floor(per / 64))) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out.push([lo > hi ? 0 : lo, lo > hi ? 0 : hi]);
    }
    return out;
  }

  window.JDT_AUDIO = {
    listener, play, stop, getBuffer, putBuffer, forget, convertFile, toBase64, fromBase64, waveform,
    setFetcher(fn) { fetcher = fn; },
    setOnEnded(fn) { onEnded = fn; },
  };
})();
