// Module worker for the small on-device voice (KittenTTS nano, ONNX). Speaks the same messages
// as vendor/pocket-tts-wasm/worker.js, so device-tts.js drives either one.
// Libraries come from jsDelivr: ONNX Runtime Web (MIT) and espeak-ng (GPL-3.0-or-later).
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs';
import ESpeakNg from 'https://cdn.jsdelivr.net/npm/espeak-ng@1.0.2/dist/espeak-ng.js';
import { readNpz, speakText, SAMPLE_RATE } from './tts.mjs';

const MODEL_BASE = 'https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8/resolve/main';
const MODEL_URL = `${MODEL_BASE}/kitten_tts_nano_v0_8.onnx`;
const VOICES_URL = `${MODEL_BASE}/voices.npz`;

// GitHub Pages cannot send the headers that threads need, so run ONNX Runtime on one thread.
ort.env.wasm.numThreads = 1;

let session = null;
let voices = null;

function post(type, data = {}, transferables = []) {
  self.postMessage({ type, ...data }, transferables);
}

async function fetchBytes(url, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Could not download ${label} (${resp.status}).`);
  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  const reader = resp.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    post('progress', {
      label,
      pct: total > 0 ? Math.round((received / total) * 100) : -1,
      detail: `${(received / 1e6).toFixed(1)} MB`,
    });
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

// One espeak run per piece of text. Punctuation is split off and put back, because espeak
// would otherwise turn it into line breaks. The result matches the Python phonemizer
// (preserve_punctuation) for ordinary prose.
const PUNCT = /([;:,.!?¡¿—…"«»])/;

async function espeakPiece(piece) {
  const espeak = await ESpeakNg({ arguments: ['--phonout', 'out', '-q', '-b=1', '--ipa=3', '-v', 'en-us', piece] });
  return espeak.FS.readFile('out', { encoding: 'utf8' });
}

async function phonemize(text) {
  let out = '';
  for (const part of text.split(PUNCT)) {
    if (part.length === 1 && PUNCT.test(part)) {
      out = out.trimEnd() + part + ' ';
    } else if (part.trim()) {
      // Zero-width joiners in espeak's diphthongs are not in the Python output.
      const ph = (await espeakPiece(part.trim())).replace(/‍/g, '').replace(/\s+/g, ' ').trim();
      out += ph + ' ';
    }
  }
  return out;
}

async function handleLoad() {
  post('status', { message: 'Downloading the voice model (about 25 MB)...' });
  const modelBytes = await fetchBytes(MODEL_URL, 'Voice model');
  post('status', { message: 'Downloading the voice list...' });
  const voiceBytes = await fetchBytes(VOICES_URL, 'Voice list');
  post('status', { message: 'Starting the voice...' });
  session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
  voices = readNpz(voiceBytes);
  post('status', { message: 'Starting the pronunciation engine...' });
  await espeakPiece('ready');
  post('loaded', { sampleRate: SAMPLE_RATE });
}

async function handleGenerate(text, voiceName) {
  if (!session) throw new Error('The voice model is not loaded.');
  post('gen_start', { numTokens: 0 });
  await speakText({
    ort,
    session,
    voices,
    phonemize,
    text,
    voiceName,
    onPiece: (samples) => post('chunk', { data: samples }, [samples.buffer]),
  });
  post('done', {});
}

self.onmessage = async (e) => {
  const { type, ...data } = e.data;
  try {
    if (type === 'load') {
      await handleLoad();
    } else if (type === 'generate') {
      await handleGenerate(data.text, data.voiceName);
    }
  } catch (err) {
    post('error', { message: err.message });
    console.error(err);
  }
};
