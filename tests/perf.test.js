// Run with: node --test tests/perf.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../perf.js');

test('summarize computes generation speed, waits and first sound', () => {
  const s = P.summarize({
    startedAt: 0,
    endedAt: 60000,
    info: { backend: 'gpu', voice: 'alba', rate: 1.1 },
    gens: [{ audioSec: 9, wallSec: 8 }, { audioSec: 10, wallSec: 9 }],
    waits: [{ ms: 50 }, { ms: 850 }],
    firstSoundMs: 16000,
  });
  assert.equal(s.wallSec, 60);
  assert.equal(s.firstSoundSec, 16);
  assert.equal(s.parts, 2);
  assert.equal(s.generatedSec, 19);
  assert.equal(s.generationRtf, 1.12);
  assert.equal(s.waits, 1); // waits under 100 ms are not stalls
  assert.equal(s.waitSec, 0.85);
  assert.equal(s.longestWaitSec, 0.85);
});

test('summarize handles a run with no generation', () => {
  const s = P.summarize({ startedAt: 0, endedAt: 5000, info: { backend: 'cpu', voice: 'alba', rate: 1 }, gens: [], waits: [], firstSoundMs: null });
  assert.equal(s.generationRtf, null);
  assert.equal(s.firstSoundSec, null);
  assert.equal(s.longestWaitSec, 0);
  assert.equal(s.loadSec, 0);
});

test('format produces the lines a person can paste back', () => {
  const text = P.format(P.summarize({ startedAt: 0, endedAt: 1000, info: { backend: 'cpu', voice: 'alba', rate: 1.05 }, gens: [{ audioSec: 2, wallSec: 1 }], waits: [], firstSoundMs: 500 }));
  assert.match(text, /cpu\s+alba\s+speed 1.05x/);
  assert.match(text, /first sound after 0.5s/);
  assert.match(text, /generation 2x \(audio made per second of synthesis/);
});

test('summarize reports part length, the speed trend, stalls with timing, and hidden time', () => {
  const gens = [];
  for (let i = 0; i < 8; i++) gens.push({ audioSec: 10, wallSec: i < 4 ? 4 : 5 }); // slows down in the second half
  const s = P.summarize({
    startedAt: 0,
    endedAt: 120000,
    info: { backend: 'cpu', voice: 'alba', rate: 1.2, partLength: 'long' },
    gens,
    waits: [{ ms: 1900, at: 52000, part: 5 }],
    firstSoundMs: 300,
    battery: { start: { charging: true, level: 80 }, end: { charging: false, level: 75 } },
    notes: { hiddenCount: 2, hiddenMs: 4500, heapStartMB: 120, heapEndMB: 140 },
  });
  assert.equal(s.partLength, 'long');
  assert.equal(s.rtfFirstQuarter, 2.5);
  assert.equal(s.rtfLastQuarter, 2);
  assert.deepEqual(s.stallDetail, ['at 52s, part 6: 1.9s']);
  assert.equal(s.hiddenCount, 2);
  assert.equal(s.hiddenSec, 4.5);
  assert.equal(s.batteryStart, 'charging, 80%');
  assert.equal(s.batteryEnd, 'on battery, 75%');
  const text = P.format(s);
  assert.match(text, /part length long; generation first quarter 2.5x, last quarter 2x/);
  assert.match(text, /stalls: at 52s, part 6: 1.9s/);
  assert.match(text, /charging: start charging, 80%, end on battery, 75%/);
});

test('summarize says when battery and memory are not readable', () => {
  const s = P.summarize({ startedAt: 0, endedAt: 1000, info: { backend: 'cpu', voice: 'alba', rate: 1 }, gens: [{ audioSec: 1, wallSec: 1 }], waits: [], firstSoundMs: 1 });
  assert.equal(s.batteryStart, 'not readable here');
  assert.equal(s.heapStartMB, null);
  assert.match(P.format(s), /charging: start not readable here/);
});
