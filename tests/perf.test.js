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
  assert.match(text, /generation 2x real time/);
});
