// On-device voice: a thin wrapper around the vendored Pocket TTS WebAssembly worker
// (vendor/pocket-tts-wasm/worker.js). The worker loads the model on first use and then
// streams Float32 frames for one request at a time.
//
// Exposes window.DeviceTTS:
//   DeviceTTS.VOICES                          voices this build can speak
//   DeviceTTS.load(onProgress) -> Promise     downloads and initialises the model once
//   DeviceTTS.generate(text, voice) -> Promise<{ chunks: Float32Array[], sampleRate }>
(function () {
  'use strict';

  const WORKER_URL = './vendor/pocket-tts-wasm/worker.js';
  // Voices that the vendored worker loads (its VOICE_NAMES list).
  const VOICES = ['alba', 'azelma', 'cosette', 'eponine', 'fantine', 'javert', 'marius'];
  const QUANT = 'q8'; // ~146 MB download; f32 is ~240 MB
  const TEMPERATURE = 0.7; // the demo's default

  // A 37-byte module whose only instruction is f32x4.relaxed_madd (a relaxed-SIMD opcode).
  // Browsers without relaxed SIMD, such as iOS WebKit, reject the voice build outright.
  const RELAXED_SIMD_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x01, 0x60, 0x03, 0x7b, 0x7b, 0x7b,
    0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x0d, 0x01, 0x0b, 0x00, 0x20, 0x00, 0x20, 0x01, 0x20,
    0x02, 0xfd, 0x85, 0x02, 0x0b,
  ]);
  const UNSUPPORTED = 'This browser cannot run the on-device voice (it lacks WebAssembly relaxed SIMD). Use the server engine instead.';

  // True when this browser can load the on-device voice build.
  function supported() {
    return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && WebAssembly.validate(RELAXED_SIMD_PROBE);
  }

  let worker = null;
  let ready = null; // { sampleRate } once the model is loaded
  let loadPromise = null; // shared by every caller while the model loads
  let loadWaiter = null; // { resolve, reject } while loading
  let genWaiter = null; // { chunks, resolve, reject } while generating
  let progressListener = null; // called with worker status/progress messages while loading

  function failAll(err) {
    if (loadWaiter) {
      const w = loadWaiter;
      loadWaiter = null;
      w.reject(err);
    }
    if (genWaiter) {
      const w = genWaiter;
      genWaiter = null;
      w.reject(err);
    }
  }

  function onMessage(e) {
    const msg = e.data;
    switch (msg.type) {
      case 'status':
      case 'progress':
        if (progressListener) progressListener(msg);
        return;
      case 'loaded': {
        ready = { sampleRate: msg.sampleRate };
        const w = loadWaiter;
        loadWaiter = null;
        if (w) w.resolve(ready);
        return;
      }
      case 'chunk':
        if (genWaiter) genWaiter.chunks.push(msg.data);
        return;
      case 'done': {
        const w = genWaiter;
        genWaiter = null;
        if (w) w.resolve({ chunks: w.chunks, sampleRate: ready.sampleRate });
        return;
      }
      case 'error': {
        // A browser without relaxed SIMD fails inside the module, with a "simd" message.
        const text = /simd/i.test(msg.message || '') ? UNSUPPORTED : (msg.message || 'The on-device voice failed.');
        failAll(new Error(text));
        return;
      }
      default:
        // 'progress_done' and 'gen_start' need no action.
    }
  }

  function ensureWorker() {
    if (worker) return worker;
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
      throw new Error('This browser cannot run the voice on the device. Use the server engine instead.');
    }
    worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessage = onMessage;
    worker.onerror = (e) => failAll(new Error(e.message || 'The voice worker failed to start.'));
    return worker;
  }

  // Concurrent callers share one load. The newest progress listener receives updates.
  function load(onProgress) {
    if (onProgress) progressListener = onProgress;
    if (ready) return Promise.resolve(ready);
    if (!supported()) return Promise.reject(new Error(UNSUPPORTED));
    if (!loadPromise) {
      loadPromise = new Promise((resolve, reject) => {
        loadWaiter = { resolve, reject };
        try {
          ensureWorker().postMessage({ type: 'load', quant: QUANT });
        } catch (err) {
          loadWaiter = null;
          reject(err);
        }
      }).catch((err) => {
        loadPromise = null;
        throw err;
      });
    }
    return loadPromise;
  }

  function generate(text, voice) {
    if (!ready) return Promise.reject(new Error('The voice model is not loaded yet.'));
    if (!VOICES.includes(voice)) return Promise.reject(new Error(`This build has no voice "${voice}".`));
    if (genWaiter) return Promise.reject(new Error('The on-device voice is busy with another paragraph.'));
    return new Promise((resolve, reject) => {
      genWaiter = { chunks: [], resolve, reject };
      worker.postMessage({ type: 'generate', text, voiceName: voice, temperature: TEMPERATURE });
    });
  }

  window.DeviceTTS = { VOICES, supported, load, generate };
})();
