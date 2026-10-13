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

  // Two builds of the same model: CPU (WebAssembly SIMD) and WebGPU (experimental).
  const WORKERS = {
    cpu: './vendor/pocket-tts-wasm/worker.js',
    gpu: './vendor/pocket-tts-wasm-gpu/worker.js',
  };
  let backend = 'cpu';
  // Voices that the vendored worker loads (its VOICE_NAMES list). Each voice is a separate download.
  const VOICES = ['alba', 'anna', 'azelma', 'jane'];
  const QUANT = 'q8'; // ~146 MB download; f32 is ~240 MB
  // Sampling temperature: lower is steadier, higher is more expressive. The demo uses 0.7.
  let temperature = 0.7;

  // A 34-byte module whose only instruction is f32x4.add (WebAssembly SIMD128). Browsers
  // without WebAssembly SIMD, such as iOS before 16.4, cannot load the voice build.
  const SIMD_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01,
    0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x0b, 0x01, 0x09, 0x00, 0x20, 0x00, 0x20, 0x01, 0xfd, 0xe4,
    0x01, 0x0b,
  ]);
  const UNSUPPORTED = 'This browser cannot run the on-device voice (it lacks WebAssembly SIMD). Use the server engine instead.';

  // True when this browser can load the on-device voice build.
  function supported() {
    return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && WebAssembly.validate(SIMD_PROBE);
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
        // A browser without WebAssembly SIMD fails inside the module, with a "simd" message.
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
    worker = new Worker(WORKERS[backend], { type: 'module' });
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
      worker.postMessage({ type: 'generate', text, voiceName: voice, temperature });
    });
  }

  // Switching backends restarts the worker. Any request in flight fails first.
  function setBackend(name) {
    if (!WORKERS[name] || name === backend) return;
    failAll(new Error('The voice engine was switched; try again.'));
    if (worker) worker.terminate();
    worker = null;
    ready = null;
    loadPromise = null;
    backend = name;
  }

  // WebGPU is only offered where the browser exposes navigator.gpu.
  function gpuAvailable() {
    return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
  }

  function setTemperature(t) {
    const v = Number(t);
    if (v >= 0.1 && v <= 1) temperature = v;
  }

  window.DeviceTTS = {
    VOICES, supported, load, generate, setBackend, gpuAvailable,
    setTemperature, getTemperature: () => temperature, getBackend: () => backend,
  };
})();
