// Performance log for one listening run: from Play until Pause or the end of the book.
// Keeps the last runs in localStorage so CPU and WebGPU (or two speeds) can be compared.
//
// Exposes window.PerfLog:
//   start(info)          begin a run; info = { backend, voice, rate }
//   addGeneration(audioSec, wallSec)   one part synthesised
//   addWait(ms)         time spent waiting for a part during playback
//   addLoad(ms)         time spent loading the voice model during the run
//   markFirstSound()     call once, when the first part starts playing
//   stop() -> summary    end the run, save it, return the summary (or null)
//   runs() -> summary[]  saved runs, newest first
//   format(summary) -> string  plain text for copying
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PerfLog = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'pet.runs';
  const MAX_RUNS = 20;
  let current = null;

  // Pure: builds the numbers from a raw run record.
  function summarize(run) {
    const wallSec = (run.endedAt - run.startedAt) / 1000;
    const genAudio = run.gens.reduce((a, g) => a + g.audioSec, 0);
    const genWall = run.gens.reduce((a, g) => a + g.wallSec, 0);
    const stalls = run.waits.filter((w) => w.ms >= 100);
    return {
      startedAt: new Date(run.startedAt).toISOString(),
      backend: run.info.backend,
      voice: run.info.voice,
      rate: run.info.rate,
      device: run.info.device || '',
      wallSec: round(wallSec, 1),
      firstSoundSec: run.firstSoundMs == null ? null : round(run.firstSoundMs / 1000, 2),
      loadSec: run.loadMs ? round(run.loadMs / 1000, 1) : 0,
      parts: run.gens.length,
      generatedSec: round(genAudio, 1),
      // Audio generated per second of synthesis: above 1 means generation outruns playback.
      generationRtf: genWall > 0 ? round(genAudio / genWall, 2) : null,
      waits: stalls.length,
      waitSec: round(stalls.reduce((a, w) => a + w.ms, 0) / 1000, 2),
      longestWaitSec: stalls.length ? round(Math.max(...stalls.map((w) => w.ms)) / 1000, 2) : 0,
    };
  }

  function round(x, digits) {
    const f = Math.pow(10, digits);
    return Math.round(x * f) / f;
  }

  // Pure: the text a person can paste back to compare runs.
  function format(s) {
    const lines = [
      `${s.startedAt.slice(0, 16).replace('T', ' ')}  ${s.backend}  ${s.voice}  speed ${s.rate}x`,
      `  listened ${s.wallSec}s, first sound after ${s.firstSoundSec == null ? '-' : s.firstSoundSec + 's'}` +
        (s.loadSec ? ` (model load ${s.loadSec}s included)` : ''),
      `  parts ${s.parts}, generated ${s.generatedSec}s of audio, generation ${s.generationRtf == null ? '-' : s.generationRtf + 'x'} real time`,
      `  waits during playback: ${s.waits} (total ${s.waitSec}s, longest ${s.longestWaitSec}s)`,
    ];
    if (s.device) lines.push(`  device: ${s.device}`);
    return lines.join('\n');
  }

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function save(summary) {
    try {
      const runs = [summary, ...load()].slice(0, MAX_RUNS);
      localStorage.setItem(KEY, JSON.stringify(runs));
    } catch (_) {
      // Storage can be unavailable (private mode); the run still shows on screen.
    }
  }

  function start(info) {
    current = {
      startedAt: Date.now(),
      info: { ...info, device: deviceText() },
      gens: [],
      waits: [],
      firstSoundMs: null,
    };
  }

  function deviceText() {
    if (typeof navigator === 'undefined') return '';
    const cores = navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} cores` : '';
    return [navigator.platform || '', cores, (navigator.userAgent || '').slice(0, 120)].filter(Boolean).join(', ');
  }

  function addGeneration(audioSec, wallSec) {
    if (current) current.gens.push({ audioSec, wallSec });
  }

  function addLoad(ms) {
    if (current) current.loadMs = (current.loadMs || 0) + ms;
  }

  function addWait(ms) {
    if (current) current.waits.push({ ms });
  }

  // Time from Play to the first sound, measured from the start of the run.
  function markFirstSound() {
    if (current && current.firstSoundMs == null) current.firstSoundMs = Date.now() - current.startedAt;
  }

  function stop() {
    if (!current) return null;
    const run = { ...current, endedAt: Date.now() };
    current = null;
    if (run.gens.length === 0 && run.firstSoundMs == null) return null;
    const summary = summarize(run);
    save(summary);
    return summary;
  }

  function runs() {
    return load();
  }

  return { start, addGeneration, addWait, addLoad, markFirstSound, stop, runs, format, summarize };
});
