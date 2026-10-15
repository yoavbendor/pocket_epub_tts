// Performance log for one listening run: from Play until Pause or the end of the book.
// Keeps the last runs in localStorage so CPU and WebGPU (or two speeds) can be compared.
//
// Exposes window.PerfLog:
//   start(info)          begin a run; info = { backend, voice, rate }
//   addGeneration(audioSec, wallSec)   one part synthesised
//   sampleBattery(which)  'start' or 'end'; reads charging and level where the browser allows it
//   addInfo(key, value)   a note kept with the run (e.g. the part length)
//   addWait(ms)         time spent waiting for a part during playback
//   addLoad(ms)         time spent loading the voice model during the run
//   addGap(ms)          time between one part ending and the next starting
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

  // Generation speed of a set of parts (audio made per second of synthesis).
  function rtfOf(gens) {
    const wall = gens.reduce((a, g) => a + g.wallSec, 0);
    return wall > 0 ? round(gens.reduce((a, g) => a + g.audioSec, 0) / wall, 2) : null;
  }

  // Pure: builds the numbers from a raw run record.
  function summarize(run) {
    const wallSec = (run.endedAt - run.startedAt) / 1000;
    const genAudio = run.gens.reduce((a, g) => a + g.audioSec, 0);
    const genWall = run.gens.reduce((a, g) => a + g.wallSec, 0);
    const stalls = run.waits.filter((w) => w.ms >= 100);
    const gaps = run.gaps || [];
    // A phone that heats up slows generation over a long run, so compare the first and last quarters.
    const quarter = Math.max(1, Math.floor(run.gens.length / 4));
    const notes = run.notes || {};
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
      gaps: gaps.length,
      avgGapMs: gaps.length ? Math.round(gaps.reduce((x, g) => x + g, 0) / gaps.length) : 0,
      longestGapMs: gaps.length ? Math.round(Math.max(...gaps)) : 0,
      partLength: run.info.partLength || '',
      rtfFirstQuarter: rtfOf(run.gens.slice(0, quarter)),
      rtfLastQuarter: rtfOf(run.gens.slice(-quarter)),
      // The first few stalls with when they happened and which part was being waited for.
      stallDetail: stalls.slice(0, 5).map((w) => `at ${round((w.at || 0) / 1000, 0)}s, part ${(w.part || 0) + 1}: ${round(w.ms / 1000, 2)}s`),
      hiddenCount: notes.hiddenCount || 0,
      hiddenSec: round((notes.hiddenMs || 0) / 1000, 1),
      batteryStart: run.battery && run.battery.start ? describeBattery(run.battery.start) : 'not readable here',
      batteryEnd: run.battery && run.battery.end ? describeBattery(run.battery.end) : 'not readable here',
      heapStartMB: notes.heapStartMB == null ? null : notes.heapStartMB,
      heapEndMB: notes.heapEndMB == null ? null : notes.heapEndMB,
    };
  }

  function describeBattery(b) {
    return `${b.charging ? 'charging' : 'on battery'}, ${b.level}%`;
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
      `  parts ${s.parts}, generated ${s.generatedSec}s of audio; generation ${s.generationRtf == null ? '-' : s.generationRtf + 'x'} (audio made per second of synthesis, not affected by playback speed; playback stays smooth while it is above your speed)`,
      `  waits during playback: ${s.waits} (total ${s.waitSec}s, longest ${s.longestWaitSec}s)`,
      `  gaps between parts: ${s.gaps} (average ${s.avgGapMs}ms, longest ${s.longestGapMs}ms)`,
    ];
    lines.push(
      `  part length ${s.partLength || '-'}; generation first quarter ${s.rtfFirstQuarter == null ? '-' : s.rtfFirstQuarter + 'x'}, last quarter ${s.rtfLastQuarter == null ? '-' : s.rtfLastQuarter + 'x'}`,
      `  charging: start ${s.batteryStart}, end ${s.batteryEnd}`,
      `  page hidden during the run: ${s.hiddenCount} time(s), ${s.hiddenSec}s`,
    );
    if (s.heapStartMB != null) lines.push(`  memory in use: ${s.heapStartMB} MB at start, ${s.heapEndMB} MB at end`);
    if (s.stallDetail && s.stallDetail.length) lines.push(`  stalls: ${s.stallDetail.join('; ')}`);
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
      gaps: [],
      firstSoundMs: null,
      battery: {},
      notes: { hiddenCount: 0, hiddenMs: 0, hiddenSince: null, heapStartMB: heapMB() },
    };
    sampleBattery('start');
  }

  function addInfo(key, value) {
    if (current) current.info[key] = value;
  }

  // Memory in use, where the browser reports it (Chrome does; iPhone Safari does not).
  function heapMB() {
    const used = typeof performance !== 'undefined' && performance.memory ? performance.memory.usedJSHeapSize : null;
    return used == null ? null : round(used / 1048576, 1);
  }

  // Charging and battery level, where the browser reports them (not iPhone Safari).
  function sampleBattery(which) {
    if (typeof navigator === 'undefined' || !navigator.getBattery) return;
    navigator.getBattery().then((b) => {
      if (!current) return;
      const sample = { charging: b.charging, level: Math.round(b.level * 100) };
      if (which === 'start') current.battery.start = sample;
      current.battery.end = sample;
    }).catch(() => {});
  }

  // Counts how often the page was hidden during a run (locked screen, switched app) and for how long.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!current) return;
      const n = current.notes;
      if (document.visibilityState === 'hidden') {
        n.hiddenCount++;
        n.hiddenSince = Date.now();
      } else if (n.hiddenSince) {
        n.hiddenMs += Date.now() - n.hiddenSince;
        n.hiddenSince = null;
      }
    });
  }

  function deviceText() {
    if (typeof navigator === 'undefined') return '';
    const cores = navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} cores` : '';
    return [navigator.platform || '', cores, (navigator.userAgent || '').slice(0, 120)].filter(Boolean).join(', ');
  }

  function addGeneration(audioSec, wallSec) {
    if (current) current.gens.push({ audioSec, wallSec });
    sampleBattery('end');
  }

  function addGap(ms) {
    if (current) current.gaps.push(ms);
  }

  function addLoad(ms) {
    if (current) current.loadMs = (current.loadMs || 0) + ms;
  }

  function addWait(ms) {
    if (current) current.waits.push({ ms, at: Date.now() - current.startedAt, part: current.gens.length });
  }

  // Time from Play to the first sound, measured from the start of the run.
  function markFirstSound() {
    if (current && current.firstSoundMs == null) current.firstSoundMs = Date.now() - current.startedAt;
  }

  function stop() {
    if (!current) return null;
    if (current.notes.hiddenSince) current.notes.hiddenMs += Date.now() - current.notes.hiddenSince;
    current.notes.heapEndMB = heapMB();
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

  return { start, addInfo, addGeneration, addWait, addGap, addLoad, markFirstSound, sampleBattery, stop, runs, format, summarize };
});
