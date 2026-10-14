// Run with: node --test tests/kitten.test.mjs
// Checks the browser port of KittenTTS nano against values taken from kittenml (Python).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tokenIds, modelChunks, buildInputs, readNpz, VOICE_NAMES } from '../kitten/tts.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures_kitten_ref.json', import.meta.url), 'utf8'));

test('modelChunks splits text the way kittenml chunk_text does', () => {
  for (const c of cases) assert.deepEqual(modelChunks(c.text), c.model_chunks);
});

test('tokenIds gives the same token ids as kittenml for every chunk', () => {
  for (const c of cases) {
    for (const piece of c.chunks) {
      assert.deepEqual(tokenIds(piece.phonemes), piece.ids, piece.text);
    }
  }
});

test('buildInputs picks the same style row and speed as kittenml', () => {
  for (const c of cases) {
    for (const piece of c.chunks) {
      // A voices table holding only the row kittenml chose, so the test checks the row index too.
      const rows = 400;
      const data = new Float32Array(rows * 256);
      data.set(piece.style, piece.row * 256);
      const voices = { 'expr-voice-2-f': { shape: [rows, 256], data } };
      const inp = buildInputs(piece.text, piece.phonemes, 'Bella', voices, 1.0);
      assert.deepEqual(Array.from(inp.style), piece.style.map((v) => Math.fround(v)));
      assert.ok(Math.abs(inp.speed - piece.speed) < 1e-6, `speed ${inp.speed} vs ${piece.speed}`);
    }
  }
});

test('the eight kittenml voice names are offered', () => {
  assert.deepEqual(VOICE_NAMES, ['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo']);
});

test('readNpz reads the arrays of a file written by numpy.savez', () => {
  // tests/fixtures_tiny.npz was written by np.savez (zip64 entries, as the voices file is).
  const bytes = new Uint8Array(fs.readFileSync(new URL('./fixtures_tiny.npz', import.meta.url)));
  const voices = readNpz(bytes);
  assert.deepEqual(voices['expr-voice-2-m'].shape, [2, 3]);
  assert.deepEqual(Array.from(voices['expr-voice-2-m'].data), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(voices['expr-voice-2-f'].shape, [4, 3]);
  assert.deepEqual(Array.from(voices['expr-voice-2-f'].data), [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
});
