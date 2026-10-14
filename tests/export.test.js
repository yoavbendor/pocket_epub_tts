// Run with: node --test tests/export.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../export.js');
const R = require('../reader.js');

// A part is `size` samples of value `index`, so the output can be checked sample by sample.
const part = (index, size) => new Int16Array(size).fill(index);

async function blobBytes(blob) {
  return Buffer.from(await blob.arrayBuffer());
}

test('run cuts files once they reach the part length and keeps the last partial file', async () => {
  const files = [];
  const count = 5;
  const result = await E.run({
    count, startIndex: 0, sampleRate: 24000, partSamples: 250,
    readPcm: async (i) => part(i, 100),
    makeSink: () => {
      const got = [];
      return { add: (p) => got.push(p), finish: () => ({ got }) };
    },
    onFile: (blob, n) => files.push({ n, parts: blob.got.map((p) => p[0]) }),
    isStopped: () => false,
  });
  assert.deepEqual(files, [
    { n: 1, parts: [0, 1, 2] },
    { n: 2, parts: [3, 4] },
  ]);
  assert.equal(result.files, 2);
  assert.equal(result.stopped, false);
});

test('run starts at startIndex and reports progress per part', async () => {
  const progress = [];
  const seen = [];
  await E.run({
    count: 6, startIndex: 4, sampleRate: 24000, partSamples: 10_000,
    readPcm: async (i) => { seen.push(i); return part(i, 50); },
    makeSink: () => ({ add() {}, finish: () => 'x' }),
    onFile: () => {},
    onProgress: (p) => progress.push(p.done),
    isStopped: () => false,
  });
  assert.deepEqual(seen, [4, 5]);
  assert.deepEqual(progress, [1, 2]);
});

test('a stop drops the unfinished file and keeps the finished ones', async () => {
  const files = [];
  let stop = false;
  const result = await E.run({
    count: 10, startIndex: 0, sampleRate: 24000, partSamples: 250,
    readPcm: async (i) => part(i, 100),
    makeSink: () => ({ parts: 0, add() { this.parts++; }, finish() { return this.parts; } }),
    onFile: (n) => files.push(n),
    onProgress: (p) => { if (p.done === 3) stop = true; }, // the first file (3 parts) is complete
    isStopped: () => stop,
  });
  assert.deepEqual(files, [3]);
  assert.equal(result.stopped, true);
});

test('wavFromPcm writes a header that the WAV reader reads back exactly', async () => {
  const a = Int16Array.from([0, 1, -1, 32767, -32768]);
  const b = Int16Array.from([7, 8]);
  const blob = E.wavFromPcm([a, b], 24000);
  const bytes = await blobBytes(blob);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.readUInt32LE(24), 24000);
  assert.equal(bytes.readUInt32LE(40), 7 * 2);
  const back = R.wavPcm(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.deepEqual(Array.from(back), [0, 1, -1, 32767, -32768, 7, 8]);
});

test('wavPcm trusts the real length when a streamed header claims too much', () => {
  const samples = Int16Array.from([10, 20, 30]);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(0xffffffff, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(2_000_000_000, 40);
  const buf = Buffer.concat([header, Buffer.from(samples.buffer)]);
  assert.deepEqual(Array.from(R.wavPcm(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))), [10, 20, 30]);
  assert.throws(() => R.wavPcm(new ArrayBuffer(20)), /no data chunk/);
});

test('mp3Sink feeds 1152-sample frames to the encoder and returns an mp3 blob', async () => {
  const calls = [];
  const fakeLame = {
    Mp3Encoder: class {
      encodeBuffer(pcm) { calls.push(pcm.length); return new Int8Array([1, 2, 3]); }
      flush() { return new Int8Array([9]); }
    },
  };
  const sink = E.mp3Sink(fakeLame, 24000, 64);
  sink.add(new Int16Array(2500));
  const blob = sink.finish();
  assert.deepEqual(calls, [1152, 1152, 196]);
  assert.equal(blob.type, 'audio/mpeg');
  assert.equal(blob.size, 3 * 3 + 1);
});
