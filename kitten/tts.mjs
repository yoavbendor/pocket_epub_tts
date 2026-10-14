// KittenTTS nano (ONNX, int8) for the browser: the steps of kittenml's KittenTTS_1_Onnx, with
// phonemes from espeak-ng supplied by the caller. Text in, Float32 samples at 24 kHz out.
// Ported from kittenml 0.8 (Apache-2.0). Checked against it in tests/kitten.test.mjs.

const SYMBOLS = ["$", ";", ":", ",", ".", "!", "?", "\u00a1", "\u00bf", "\u2014", "\u2026", "\"", "\u00ab", "\u00bb", "\"", "\"", " ", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "\u0251", "\u0250", "\u0252", "\u00e6", "\u0253", "\u0299", "\u03b2", "\u0254", "\u0255", "\u00e7", "\u0257", "\u0256", "\u00f0", "\u02a4", "\u0259", "\u0258", "\u025a", "\u025b", "\u025c", "\u025d", "\u025e", "\u025f", "\u0284", "\u0261", "\u0260", "\u0262", "\u029b", "\u0266", "\u0267", "\u0127", "\u0265", "\u029c", "\u0268", "\u026a", "\u029d", "\u026d", "\u026c", "\u026b", "\u026e", "\u029f", "\u0271", "\u026f", "\u0270", "\u014b", "\u0273", "\u0272", "\u0274", "\u00f8", "\u0275", "\u0278", "\u03b8", "\u0153", "\u0276", "\u0298", "\u0279", "\u027a", "\u027e", "\u027b", "\u0280", "\u0281", "\u027d", "\u0282", "\u0283", "\u0288", "\u02a7", "\u0289", "\u028a", "\u028b", "\u2c71", "\u028c", "\u0263", "\u0264", "\u028d", "\u03c7", "\u028e", "\u028f", "\u0291", "\u0290", "\u0292", "\u0294", "\u02a1", "\u0295", "\u02a2", "\u01c0", "\u01c1", "\u01c2", "\u01c3", "\u02c8", "\u02cc", "\u02d0", "\u02d1", "\u02bc", "\u02b4", "\u02b0", "\u02b1", "\u02b2", "\u02b7", "\u02e0", "\u02e4", "\u02de", "\u2193", "\u2191", "\u2192", "\u2197", "\u2198", "'", "\u0329", "'", "\u1d7b"];
// Later duplicates win, as in the Python dict this mirrors.
const SYMBOL_INDEX = new Map();
SYMBOLS.forEach((ch, i) => SYMBOL_INDEX.set(ch, i));

// The model's voice names map to its internal voices, each with a speed correction.
const ALIASES = {
  Bella: 'expr-voice-2-f', Jasper: 'expr-voice-2-m', Luna: 'expr-voice-3-f', Bruno: 'expr-voice-3-m',
  Rosie: 'expr-voice-4-f', Hugo: 'expr-voice-4-m', Kiki: 'expr-voice-5-f', Leo: 'expr-voice-5-m',
};
export const VOICE_NAMES = Object.keys(ALIASES);
const SPEED_PRIORS = {
  'expr-voice-2-f': 0.8, 'expr-voice-2-m': 0.8, 'expr-voice-3-m': 0.8, 'expr-voice-3-f': 0.8,
  'expr-voice-4-m': 0.9, 'expr-voice-4-f': 0.8, 'expr-voice-5-m': 0.8, 'expr-voice-5-f': 0.8,
};
export const SAMPLE_RATE = 24000;
// The model's speed prior (0.8 for Bella) already slows every voice, so a plain 1.0 sounds slow.
// 1.25 times the prior is the natural pace; the playback speed control then works on top of it.
export const SPEECH_SPEED = 1.25;
const TRIM_TAIL = 5000; // the model's last 5000 samples are dropped (kittenml does the same)

// Python's re.findall(r"\w+|[^\w\s]") on the phonemes, then the symbol lookup. Unknown symbols are skipped.
export function tokenIds(phonemes) {
  const pieces = phonemes.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu) || [];
  const ids = [];
  for (const ch of pieces.join(' ')) {
    const id = SYMBOL_INDEX.get(ch);
    if (id !== undefined) ids.push(id);
  }
  return [0, ...ids, 10, 0];
}

const NON_BOUNDARY = new Set(['dr', 'prof', 'mr', 'mrs', 'ms', 'fig', 'figs', 'pp', 'p', 'ch', 'sec',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'al']);

// kittenml's ensure_punctuation: a piece that ends without prosodic punctuation gets a comma.
function ensurePunctuation(text) {
  const t = text.trim();
  if (!t) return t;
  return '.!?,;:'.includes(t[t.length - 1]) ? t : t + ',';
}

// kittenml's _is_sentence_boundary, on an array of code points.
function isBoundary(cps, index) {
  const ch = cps[index];
  if (ch !== '.' && ch !== '!' && ch !== '?') return false;
  if (ch === '.') {
    if (index > 0 && index < cps.length - 1 && /\d/.test(cps[index - 1]) && /\d/.test(cps[index + 1])) return false;
    const before = cps.slice(0, index).join('');
    const m = before.match(/([A-Za-z]+)$/);
    const token = m ? m[1].toLowerCase() : '';
    if (NON_BOUNDARY.has(token)) return false;
    if ((token === 'a' || token === 'p') && index + 1 < cps.length && cps[index + 1].toLowerCase() === 'm') return false;
    if (token === 'm' && /\b[ap]\.m$/i.test(before)) {
      const next = cps.slice(index + 1).join('').trim();
      return !next || (next[0] === next[0].toUpperCase() && next[0] !== next[0].toLowerCase());
    }
  }
  const next = cps.slice(index + 1).join('');
  return !next || /\s/.test(next[0]);
}

// kittenml's chunk_text: the pieces the model runs on, one run each (at most 400 characters).
export function modelChunks(text, maxLen = 400) {
  const cps = [...text];
  const sentences = [];
  let start = 0;
  for (let i = 0; i < cps.length; i++) {
    if (isBoundary(cps, i)) {
      sentences.push(cps.slice(start, i + 1).join(''));
      start = i + 1;
    }
  }
  if (start < cps.length) sentences.push(cps.slice(start).join(''));
  const chunks = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if ([...sentence].length <= maxLen) {
      chunks.push(ensurePunctuation(sentence));
    } else {
      let temp = '';
      for (const word of sentence.split(/\s+/)) {
        if ([...temp].length + [...word].length + 1 <= maxLen) {
          temp = temp ? temp + ' ' + word : word;
        } else {
          if (temp) chunks.push(ensurePunctuation(temp.trim()));
          temp = word;
        }
      }
      if (temp) chunks.push(ensurePunctuation(temp.trim()));
    }
  }
  return chunks;
}

// Reads the .npy arrays of a .npz file (np.savez, which stores them uncompressed in zip64 form).
// Sizes and offsets come from the central directory, where zip64 values replace the 0xFFFFFFFF
// placeholders. Returns { [voiceName]: { shape: [rows, width], data: Float32Array } }.
export function readNpz(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const u16 = (o) => view.getUint16(o, true);
  const u32 = (o) => view.getUint32(o, true);
  const u64 = (o) => u32(o) + u32(o + 4) * 0x100000000;

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The voices file is not a zip archive.');
  const count = u16(eocd + 10);
  let c = u32(eocd + 16);

  const voices = {};
  for (let n = 0; n < count; n++) {
    if (u32(c) !== 0x02014b50) throw new Error('The voices file has a damaged directory.');
    const method = u16(c + 10);
    let csize = u32(c + 20);
    let usize = u32(c + 24);
    let local = u32(c + 42);
    const nameLen = u16(c + 28);
    const extraLen = u16(c + 30);
    const commentLen = u16(c + 32);
    const name = decoder.decode(bytes.subarray(c + 46, c + 46 + nameLen));
    // zip64 extra field: 8-byte values, in this order, only for the fields set to 0xFFFFFFFF.
    for (let x = c + 46 + nameLen, end = x + extraLen; x + 4 <= end;) {
      const id = u16(x);
      const size = u16(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = u64(q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(q); q += 8; }
        if (local === 0xffffffff) { local = u64(q); q += 8; }
      }
      x += 4 + size;
    }
    c += 46 + nameLen + extraLen + commentLen;

    if (method !== 0) throw new Error('The voices file is compressed, which this reader does not support.');
    if (!name.endsWith('.npy')) continue;
    const body = local + 30 + u16(local + 26) + u16(local + 28);
    voices[name.replace(/\.npy$/, '')] = parseNpy(bytes.subarray(body, body + csize), decoder);
  }
  return voices;
}

// One .npy array (version 1.x or 2.x, little-endian float32, C order).
function parseNpy(bytes, decoder) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const headerLen = major >= 2 ? view.getUint32(8, true) : view.getUint16(8, true);
  const prefix = major >= 2 ? 12 : 10;
  const header = decoder.decode(bytes.subarray(prefix, prefix + headerLen));
  const shape = header.match(/'shape':\s*\(([^)]*)\)/)[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!header.includes("'<f4'")) throw new Error('The voices file holds an unexpected number type.');
  const start = prefix + headerLen;
  const count = shape.reduce((a, b) => a * b, 1);
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) data[i] = view.getFloat32(start + i * 4, true);
  return { shape, data };
}

// The model inputs for one piece of text, as kittenml builds them.
export function buildInputs(text, phonemes, voiceName, voices, speed = 1.0) {
  const voice = ALIASES[voiceName] || voiceName;
  if (!voices[voice]) throw new Error(`The voice "${voiceName}" is not in this model.`);
  const tokens = tokenIds(phonemes);
  const { shape, data } = voices[voice];
  const row = Math.min([...text].length, shape[0] - 1);
  return {
    tokens,
    style: data.slice(row * shape[1], (row + 1) * shape[1]),
    speed: (SPEED_PRIORS[voice] ?? 1) * speed,
  };
}

// Speaks one paragraph: one model run per kittenml chunk. `phonemize(text)` returns espeak phonemes.
// `onPiece(samples)` gets each run's audio as it is ready. Resolves when all runs are done.
export async function speakText({ ort, session, voices, phonemize, text, voiceName, speed = SPEECH_SPEED, onPiece }) {
  for (const chunk of modelChunks(text)) {
    const inp = buildInputs(chunk, await phonemize(chunk), voiceName, voices, speed);
    const out = await session.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(inp.tokens, BigInt), [1, inp.tokens.length]),
      style: new ort.Tensor('float32', inp.style, [1, inp.style.length]),
      speed: new ort.Tensor('float32', Float32Array.of(inp.speed), [1]),
    });
    const waveform = out[session.outputNames[0]].data;
    const audio = waveform.slice(0, Math.max(0, waveform.length - TRIM_TAIL));
    onPiece(audio);
  }
}
