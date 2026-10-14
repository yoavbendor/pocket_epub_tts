// Pocket EPUB TTS: UI, storage and playback.
//
// Everything persistent lives in IndexedDB so that a book, its reading position and
// its generated audio survive closing the tab or restarting the phone:
//   books   { id, title, author, count, position, offset, updatedAt }
//   chunks  { id, chunks: string[] }            the book text, split into TTS requests
//   audio   { key, bookId, voice, index, blob } short-lived cache of generated WAVs
(function () {
  'use strict';

  const R = window.PocketReader;
  const DB_NAME = 'pocket-epub-tts';
  const LOOKAHEAD = 4; // parts generated ahead of the one playing
  const DEFAULT_VOICE = 'alba';
  // Built-in English voices from the pocket-tts README.
  const VOICES = [
    'alba', 'anna', 'azelma', 'bill_boerst', 'caro_davy', 'charles', 'cosette', 'eponine', 'eve',
    'fantine', 'george', 'jane', 'javert', 'jean', 'marius', 'mary', 'michael', 'paul',
    'peter_yearsley', 'stuart_bell', 'vera',
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    settings: $('settings-card'),
    engine: $('engine'),
    serverField: $('server-field'),
    prepare: $('prepare'),
    rate: $('rate'),
    perfText: $('perf-text'),
    perfCopy: $('perf-copy'),
    exportPart: $('export-part'),
    exportFrom: $('export-from'),
    exportStart: $('export-start'),
    exportStop: $('export-stop'),
    exportStatus: $('export-status'),
    exportFiles: $('export-files'),
    perfMsg: $('perf-msg'),
    backendField: $('backend-field'),
    tempField: $('temp-field'),
    temp: $('temp'),
    backend: $('backend'),
    server: $('server'),
    voice: $('voice'),
    testServer: $('test-server'),
    serverMsg: $('server-msg'),
    library: $('library-card'),
    file: $('file'),
    importMsg: $('import-msg'),
    logText: $('log-text'),
    logCopy: $('log-copy'),
    logMsg: $('log-msg'),
    bookList: $('book-list'),
    reader: $('reader-card'),
    back: $('back'),
    title: $('title'),
    author: $('author'),
    position: $('position'),
    prev: $('prev'),
    toggle: $('toggle'),
    next: $('next'),
    status: $('status'),
    currentText: $('current-text'),
    audio: $('player'),
  };
  // Two elements alternate. The active one plays; the spare holds the next part, loaded, so the
  // switch at the end of a part has no gap. Handlers only act for the active element.
  const elementA = els.audio;
  const elementB = new Audio();
  elementB.preload = 'auto';
  let audio = elementA;
  let spare = elementB;
  let gapStart = null; // when the previous part ended, while the next one is still starting
  let preloaded = null; // { key, url } of the part waiting in the spare element
  let preloadToken = 0;

  // Attaches a handler to both elements; it runs only when the event is from the active one.
  function onEach(type, handler) {
    for (const el of [elementA, elementB]) {
      el.addEventListener(type, (e) => {
        if (e.currentTarget === audio) handler(e);
      });
    }
  }

  const state = {
    book: null, // metadata record of the open book
    chunks: null, // text of the open book, one string per TTS request
    index: 0, // paragraph (chunk) being read
    offset: 0, // seconds into that paragraph
    playing: false,
    gen: 0, // bumped by every user action, so stale async work can stop itself
    loaded: null, // cache key of the audio currently loaded in the player
    objectUrl: null,
    pendingSeek: 0,
    silentUrl: null,
    lastSave: 0,
    soundStarted: false, // first part of the current run is playing
  };

  // ---------- Storage (IndexedDB) ----------

  let dbPromise = null;
  function openDb() {
    dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('books', { keyPath: 'id' });
        db.createObjectStore('chunks', { keyPath: 'id' });
        db.createObjectStore('audio', { keyPath: 'key' }).createIndex('bookId', 'bookId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
    return dbPromise;
  }

  function txDone(t) {
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('The browser stopped the storage write without a reason'));
    });
  }

  async function run(storeName, mode, makeRequest) {
    const db = await openDb();
    const t = db.transaction(storeName, mode);
    const req = makeRequest(t.objectStore(storeName));
    await txDone(t);
    return req?.result;
  }

  const idbGet = (store, key) => run(store, 'readonly', (s) => s.get(key));
  const idbGetAll = (store) => run(store, 'readonly', (s) => s.getAll());
  const idbPut = (store, value) => run(store, 'readwrite', (s) => s.put(value));

  // The cover image is kept in the chunks store under its own key, so the book record stays
  // small and saving progress does not rewrite the image.
  const coverKey = (bookId) => `${bookId}:cover`;

  async function deleteBookData(id) {
    const db = await openDb();
    const t = db.transaction(['books', 'chunks', 'audio'], 'readwrite');
    t.objectStore('books').delete(id);
    t.objectStore('chunks').delete(id);
    t.objectStore('chunks').delete(coverKey(id));
    const cursor = t.objectStore('audio').index('bookId').openCursor(IDBKeyRange.only(id));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) {
        c.delete();
        c.continue();
      }
    };
    await txDone(t);
  }

  // Removes cached audio of this book that is behind the reader or from another engine/voice.
  async function evictAudio(bookId, variant, before) {
    const db = await openDb();
    const t = db.transaction('audio', 'readwrite');
    const cursor = t.objectStore('audio').index('bookId').openCursor(IDBKeyRange.only(bookId));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if (c.value.voice !== variant || c.value.index < before) c.delete();
      c.continue();
    };
    await txDone(t);
  }

  // ---------- Settings (per-device, kept in localStorage) ----------

  const storage = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch (_) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch (_) {
        // Private mode can block storage; the setting then lasts for this page only.
      }
    },
  };

  function serverUrl() {
    return els.server.value.trim().replace(/\/+$/, '');
  }

  function currentVoice() {
    return els.voice.value;
  }

  // Cache key of the small model's audio (its pace is part of the key).
  const NANO_VARIANT = 'nano-natural';
  // 'browser' runs the full model on this device, 'nano' the small one; 'server' calls a pocket-tts server.
  function currentEngine() {
    const value = els.engine.value;
    return value === 'server' || value === 'nano' ? value : 'browser';
  }

  // Cached audio depends on the engine (and, on this phone, the CPU or WebGPU build) and the
  // voice, so all three are part of its key. Otherwise a WebGPU run plays CPU audio.
  function currentVariant() {
    // The nano key names the pace it was made at, so audio made at an older pace is not reused.
    // The small model's key names its pace and backend (WebGPU and CPU can differ slightly).
    const engine = currentEngine() === 'server'
      ? 'server'
      : currentEngine() === 'nano'
        ? `${NANO_VARIANT}-${window.DeviceTTS.getBackend()}`
        : `browser-${window.DeviceTTS.getBackend()}-t${window.DeviceTTS.getTemperature()}`;
    return `${engine}:${currentVoice()}`;
  }

  function checkServerUrl() {
    const url = serverUrl();
    if (!url) return 'Enter the pocket-tts URL first.';
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return 'That is not a valid URL.';
    }
    if (location.protocol === 'https:' && parsed.protocol !== 'https:') {
      return 'This page is https, so the server must be https too. iOS blocks http:// requests from it.';
    }
    return null;
  }

  // ---------- Synthesis ----------

  // Synthesis runs one request at a time (the model is single-threaded). Higher priority
  // jumps the line: the part being played outranks lookahead, so a jump or a stall never
  // waits behind audio that is only prefetched.
  const PRIORITY_NOW = 2;
  const PRIORITY_AHEAD = 1;
  const jobs = [];
  let pumping = false;
  function serial(task, priority = PRIORITY_AHEAD) {
    return new Promise((resolve, reject) => {
      jobs.push({ task, priority, resolve, reject });
      jobs.sort((a, b) => b.priority - a.priority);
      pump();
    });
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (jobs.length) {
      const job = jobs.shift();
      try {
        job.resolve(await job.task());
      } catch (err) {
        job.reject(err);
      }
    }
    pumping = false;
  }

  async function synthesizeOnServer(text, voice) {
    const problem = checkServerUrl();
    if (problem) throw new Error(problem);
    const body = new FormData();
    body.append('text', text);
    body.append('voice_url', voice);
    const res = await fetch(serverUrl() + '/tts', { method: 'POST', body });
    if (!res.ok) throw new Error(`pocket-tts returned HTTP ${res.status}`);
    const wav = R.fixWavHeader(await res.arrayBuffer());
    return new Blob([wav], { type: 'audio/wav' });
  }

  // ---------- On-device engine (window.DeviceTTS, see device-tts.js) ----------

  // Downloads the model once per page load. The worker's weights are fetched from Hugging Face.
  function loadDeviceEngine() {
    if (!window.DeviceTTS) throw new Error('The on-device voice did not load. Reload the page, or use the server engine.');
    window.DeviceTTS.setModel(currentEngine() === 'nano' ? 'nano' : 'pocket');
    const t = performance.now();
    diag.add(`voice: loading ${window.DeviceTTS.getModel()} model, speed setting ${window.DeviceTTS.getBackend()}`);
    return window.DeviceTTS.load((msg) => {
      if (msg.type === 'progress' && msg.pct >= 0) setStatus(`Downloading ${msg.label}: ${msg.pct}%`);
      else if (msg.type === 'status') setStatus(msg.message);
      if (msg.type === 'status') diag.add(`voice: ${msg.message}`);
    }).then((ready) => {
      window.PerfLog.addLoad(performance.now() - t);
      diag.add(`voice: ready after ${Math.round(performance.now() - t)} ms`);
      return ready;
    }, (err) => {
      diag.add('voice: load failed: ' + describeFailure(err));
      throw err;
    });
  }

  async function synthesizeOnDevice(text, voice) {
    await loadDeviceEngine();
    const t = performance.now();
    diag.add(`voice: making a part of ${text.length} characters`);
    const { chunks, sampleRate } = await window.DeviceTTS.generate(text, voice);
    diag.add(`voice: part made in ${Math.round(performance.now() - t)} ms`);
    if (!chunks.length) throw new Error('The on-device voice produced no audio for this part.');
    return new Blob([R.encodeWav(chunks, sampleRate)], { type: 'audio/wav' });
  }

  // `variant` is 'browser-<backend>-t<temp>:<voice>', 'nano:<voice>' or 'server:<voice>', as built by currentVariant().
  function synthesize(text, variant) {
    const sep = variant.indexOf(':');
    const engine = variant.slice(0, sep);
    const voice = variant.slice(sep + 1);
    if (engine === 'server') return synthesizeOnServer(text, voice);
    if (window.DeviceTTS) window.DeviceTTS.setModel(engine.startsWith(NANO_VARIANT) ? 'nano' : 'pocket');
    return synthesizeOnDevice(text, voice);
  }

  const inflight = new Map();
  const chunkKey = (bookId, variant, index) => `${bookId}|${variant}|${index}`;

  // Returns the WAV for one paragraph, from the IndexedDB cache when possible.
  function getChunkBlob(bookId, variant, index, text, priority = PRIORITY_AHEAD) {
    const key = chunkKey(bookId, variant, index);
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      // The cache is an optimisation: if it cannot be read, the part is made again.
      let cached = null;
      try {
        cached = await idbGet('audio', key);
      } catch (err) {
        diag.add('audio cache read failed (making the part again): ' + describeFailure(err));
      }
      if (cached) return cached.bytes ? new Blob([cached.bytes], { type: 'audio/wav' }) : cached.blob;
      const blob = await serial(async () => {
        const t = performance.now();
        const made = await synthesize(text, variant);
        const wall = (performance.now() - t) / 1000;
        const sec = wavSeconds(made);
        window.PerfLog.addGeneration(sec, wall);
        if (wall > 0) lastGenRtf = sec / wall;
        return made;
      }, priority);
      // Stored as bytes: the cache write failed with no reason on some phone browsers when it
      // held a Blob. A failed write only costs a regeneration later, so playback goes on.
      try {
        await idbPut('audio', { key, bookId, voice: variant, index, bytes: await blob.arrayBuffer() });
      } catch (err) {
        diag.add('audio cache write failed (playback continues): ' + describeFailure(err));
      }
      return blob;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  // Speed of the most recent generation, in audio seconds per second of synthesis. Used to
  // decide whether playback can start after one part instead of two.
  let lastGenRtf = null;
  const FAST_RTF = 1.5;

  // Both engines return 16-bit mono WAV at 24 kHz: 44 header bytes, then 2 bytes per sample.
  const PCM_RATE = 24000;
  function wavSeconds(blob) {
    return Math.max(0, blob.size - 44) / (2 * PCM_RATE);
  }

  function prefetch() {
    const { book, chunks, index } = state;
    const variant = currentVariant();
    const last = Math.min(index + LOOKAHEAD, chunks.length - 1);
    for (let i = index + 1; i <= last; i++) {
      getChunkBlob(book.id, variant, i, chunks[i]).catch(() => {});
    }
    evictAudio(book.id, variant, index - 1).catch(() => {});
  }

  // ---------- Playback ----------

  // A tiny silent clip. Starting it inside the Play tap unlocks the audio element on
  // iOS, so the real paragraph can start after the server responds.
  function silentUrl() {
    if (state.silentUrl) return state.silentUrl;
    const rate = 8000;
    const samples = 800;
    const buf = new ArrayBuffer(44 + samples * 2);
    const v = new DataView(buf);
    const ascii = (offset, s) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
    ascii(0, 'RIFF');
    v.setUint32(4, 36 + samples * 2, true);
    ascii(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    ascii(36, 'data');
    v.setUint32(40, samples * 2, true);
    state.silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    return state.silentUrl;
  }

  function isCurrentSource() {
    return state.objectUrl !== null && audio.src === state.objectUrl;
  }

  function setSource(blob, key) {
    const old = state.objectUrl;
    state.objectUrl = URL.createObjectURL(blob);
    audio.src = state.objectUrl;
    if (old) URL.revokeObjectURL(old);
    state.loaded = key;
  }

  function describeError(err) {
    if (err === null || err === undefined) {
      return 'The import failed without an error message. Copy the diagnostic log below.';
    }
    if (err instanceof TypeError) {
      return 'Could not reach the pocket-tts server. Check the URL, that it is https, and that it allows this page (see README).';
    }
    if (err && err.name === 'NotAllowedError') return 'The browser blocked playback. Tap Play again.';
    return (err && err.message) || String(err);
  }

  // `buffer` (set when playback starts from a stop) also waits for the next part, so that
  // the first sentence is not followed by a wait for synthesis.
  async function startCurrent(buffer = false) {
    const gen = ++state.gen;
    const { book, chunks, index } = state;
    const variant = currentVariant();
    const key = chunkKey(book.id, variant, index);
    try {
      if (state.loaded !== key) {
        setStatus(`Loading part ${index + 1} of ${chunks.length}…`);
        const waitStart = performance.now();
        const blob = await getChunkBlob(book.id, variant, index, chunks[index], PRIORITY_NOW);
        if (gen !== state.gen) return;
        const fast = lastGenRtf !== null && lastGenRtf >= FAST_RTF;
        if (buffer && index + 1 < chunks.length && !fast) {
          setStatus(`Buffering part ${index + 2} of ${chunks.length}…`);
          await getChunkBlob(book.id, variant, index + 1, chunks[index + 1], PRIORITY_NOW);
          if (gen !== state.gen) return;
        }
        if (state.soundStarted) window.PerfLog.addWait(performance.now() - waitStart);
        setSource(blob, key);
        audio.playbackRate = currentRate();
        audio.preservesPitch = true;
        state.pendingSeek = state.offset;
      }
      await audio.play();
      if (gen !== state.gen) return;
      setStatus('Playing');
      if (!state.soundStarted) {
        state.soundStarted = true;
        window.PerfLog.markFirstSound();
      }
      preloadNext();
    } catch (err) {
      if (gen !== state.gen) return;
      state.playing = false;
      reportError(err);
      render();
      return;
    }
    prefetch();
  }

  const RATES = ['1', '1.05', '1.1', '1.15', '1.2', '1.25', '1.3'];

  function currentRate() {
    return parseFloat(els.rate.value) || 1;
  }

  // A run is one listening session: from Play until Pause or the end of the book.
  function startRun() {
    state.soundStarted = false;
    window.PerfLog.start({
      backend: currentEngine() === 'server' ? 'server' : (currentEngine() === 'nano' ? 'nano-' : '') + window.DeviceTTS.getBackend(),
      voice: currentVoice(),
      rate: currentRate(),
    });
  }

  function finishRun() {
    const summary = window.PerfLog.stop();
    if (summary) sessionRuns.unshift(summary);
    renderPerf();
  }

  function play() {
    if (!state.book) return;
    if (!state.playing) startRun();
    state.playing = true;
    render();
    if (state.loaded !== chunkKey(state.book.id, currentVariant(), state.index)) {
      // Unlock inside the tap, before any await. The silent clip is not the current source,
      // so its events are ignored by the handlers below.
      state.loaded = null;
      audio.src = silentUrl();
      audio.play().catch(() => {});
      spare.src = silentUrl();
      spare.play().catch(() => {});
      return startCurrent(true);
    }
    return startCurrent();
  }

  function pause() {
    state.gen++;
    state.playing = false;
    gapStart = null;
    audio.pause();
    setStatus('Paused');
    render();
    saveProgress();
    finishRun();
  }

  function jump(delta) {
    if (!state.book) return;
    // Read the play intent before any await, so rapid taps keep playing.
    const wasPlaying = state.playing;
    state.gen++;
    state.playing = false;
    audio.pause();
    state.index = Math.min(Math.max(state.index + delta, 0), state.chunks.length - 1);
    state.offset = 0;
    saveProgress();
    if (wasPlaying) return play();
    render();
    setStatus('Paused');
  }

  // Loads the part after the current one into the spare element.
  function preloadNext() {
    const { book, chunks, index } = state;
    if (!book || index + 1 >= chunks.length) return;
    const variant = currentVariant();
    const next = index + 1;
    const key = chunkKey(book.id, variant, next);
    const token = ++preloadToken;
    getChunkBlob(book.id, variant, next, chunks[next], PRIORITY_NOW)
      .then((blob) => {
        if (token !== preloadToken) return; // a jump or a new part superseded this one
        if (preloaded) URL.revokeObjectURL(preloaded.url);
        const url = URL.createObjectURL(blob);
        preloaded = { key, url };
        spare.src = url;
        spare.load();
      })
      .catch(() => {});
  }

  // Starts the preloaded part on the spare element. Returns false when it is not ready.
  function swapToPreloaded() {
    if (!state.book) return false;
    const want = chunkKey(state.book.id, currentVariant(), state.index);
    if (!preloaded || preloaded.key !== want) return false;
    const old = state.objectUrl;
    [audio, spare] = [spare, audio];
    state.objectUrl = preloaded.url;
    state.loaded = want;
    preloaded = null;
    if (old) URL.revokeObjectURL(old);
    audio.playbackRate = currentRate();
    audio.preservesPitch = true;
    audio.currentTime = 0;
    audio.play().then(() => setStatus('Playing')).catch((err) => {
      if (!state.playing) return;
      state.playing = false;
      reportError(err);
      render();
    });
    preloadNext();
    prefetch();
    return true;
  }

  onEach('loadedmetadata', () => {
    if (!isCurrentSource() || !state.pendingSeek) return;
    if (isFinite(audio.duration)) audio.currentTime = Math.min(state.pendingSeek, audio.duration - 0.5);
    state.offset = audio.currentTime;
    state.pendingSeek = 0;
  });

  onEach('timeupdate', () => {
    if (!isCurrentSource()) return;
    state.offset = audio.currentTime;
    if (Date.now() - state.lastSave > 5000) saveProgress();
  });

  onEach('ended', () => {
    if (!state.playing || !isCurrentSource()) return;
    if (state.index + 1 >= state.chunks.length) {
      // Finished: the next Play starts the book again.
      state.playing = false;
      state.index = 0;
      state.offset = 0;
      setStatus('Finished. Tap Play to read it again.');
      render();
      saveProgress();
      finishRun();
      return;
    }
    // Start the next part first; saving progress and redrawing wait until it is playing.
    state.index++;
    state.offset = 0;
    gapStart = performance.now();
    if (!swapToPreloaded()) startCurrent();
    saveProgress();
    render();
  });

  // The next part has started: record how long the switch took.
  onEach('playing', () => {
    if (gapStart === null) return;
    window.PerfLog.addGap(performance.now() - gapStart);
    gapStart = null;
  });

  // The system paused us (phone call, Siri, lock screen). Keep the UI honest.
  onEach('pause', () => {
    const atEnd = audio.ended || (isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.05);
    if (!state.playing || !isCurrentSource() || atEnd) return;
    state.gen++;
    state.playing = false;
    setStatus('Paused');
    render();
    saveProgress();
    finishRun();
  });

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => play(),
      pause: () => pause(),
      previoustrack: () => jump(-1),
      nexttrack: () => jump(1),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (_) {
        // This browser does not support the action; the on-screen button still works.
      }
    }
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !state.book) return;
    navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
    if (typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.book.title,
      artist: state.book.author || 'Pocket EPUB TTS',
      album: `Part ${state.index + 1} of ${state.chunks.length}`,
    });
  }

  // ---------- Saving progress ----------

  function saveProgress() {
    const book = state.book;
    if (!book) return Promise.resolve();
    book.position = state.index;
    book.offset = state.offset;
    book.updatedAt = Date.now();
    state.lastSave = Date.now();
    return idbPut('books', { ...book }).catch(() => {});
  }

  // ---------- UI ----------

  function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.className = isError ? 'error' : '';
  }

  function percent(book) {
    return Math.floor((book.position / Math.max(book.count, 1)) * 100);
  }

  function render() {
    const book = state.book;
    els.toggle.textContent = state.playing ? '❚❚ Pause' : '▶ Play';
    els.prev.disabled = !book || state.index === 0;
    els.next.disabled = !book || state.index >= (state.chunks ? state.chunks.length - 1 : 0);
    if (book) {
      els.title.textContent = book.title;
      els.author.textContent = book.author || '';
      els.position.textContent =
        `Part ${state.index + 1} of ${state.chunks.length} · ${Math.floor(((state.index + 1) / state.chunks.length) * 100)}%`;
      els.currentText.textContent = state.chunks[state.index];
    }
    updateMediaSession();
  }

  // Runs from this page visit only: the panel starts empty each time the page opens.
  const sessionRuns = [];

  function renderPerf() {
    els.perfText.textContent = sessionRuns.length
      ? sessionRuns.slice(0, 5).map(window.PerfLog.format).join('\n\n')
      : 'No runs yet. Listen for a while, then pause to see the numbers here.';
    els.perfCopy.disabled = sessionRuns.length === 0;
    els.perfMsg.textContent = '';
  }

  // ---------- Audio export ----------
  // Makes the rest of the book as files for saving. Parts are made the same way as for playback
  // (same engine, same voice) but are not written to the audio cache, so the cache stays small.
  const AE = window.AudioExport;
  const LAME_URL = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
  const EXPORT_KBPS = 64;
  let exporting = null; // { stop } while an export runs
  let exportUrls = []; // object URLs of finished files, released when the next export starts

  function setExportStatus(text) {
    els.exportStatus.textContent = text;
  }

  function loadLame() {
    if (window.lamejs) return Promise.resolve(window.lamejs);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = LAME_URL;
      script.onload = () => (window.lamejs ? resolve(window.lamejs) : reject(new Error('The MP3 encoder loaded but cannot be used.')));
      script.onerror = () => reject(new Error('The MP3 encoder could not be downloaded. Check the connection, or choose WAV.'));
      document.head.append(script);
    });
  }

  // One part as 16-bit samples: from the cache when it is there, otherwise made now (not cached).
  async function exportPart(bookId, variant, index, text, timing) {
    let cached = null;
    try {
      cached = await idbGet('audio', chunkKey(bookId, variant, index));
    } catch (err) {
      diag.add('audio cache read failed during export: ' + describeFailure(err));
    }
    if (cached) return R.wavPcm(cached.bytes || (await cached.blob.arrayBuffer()));
    const t = performance.now();
    const blob = await serial(() => synthesize(text, variant), PRIORITY_AHEAD);
    timing.wall += (performance.now() - t) / 1000;
    timing.audio += wavSeconds(blob);
    return R.wavPcm(await blob.arrayBuffer());
  }

  function safeFileName(title) {
    return (title || 'book').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'book';
  }

  function addExportFile(blob, name) {
    const url = URL.createObjectURL(blob);
    exportUrls.push(url);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    const mb = (blob.size / 1048576).toFixed(1);
    link.textContent = `Save ${name} (${mb} MB)`;
    els.exportFiles.append(link);
  }

  function clearExportFiles() {
    for (const url of exportUrls) URL.revokeObjectURL(url);
    exportUrls = [];
    els.exportFiles.replaceChildren();
  }

  function formatMinutes(seconds) {
    const m = Math.floor(seconds / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  }

  async function startExport() {
    if (!state.book || !state.chunks || exporting) return;
    const partSeconds = Number(els.exportPart.value) * 60;
    const bookId = state.book.id;
    const title = safeFileName(state.book.title);
    const chunks = state.chunks;
    const variant = currentVariant();
    const startIndex = els.exportFrom.value === 'here' ? state.index : 0;
    const job = { stop: false };
    exporting = job;
    if (state.playing) pause();
    clearExportFiles();
    els.exportStart.disabled = true;
    els.exportStop.disabled = false;
    const timing = { wall: 0, audio: 0 };
    const began = performance.now();
    let wake = null;
    try {
      setExportStatus('Preparing…');
      const rate = 24000;
      const lamejs = await loadLame();
      const makeSink = () => AE.mp3Sink(lamejs, rate, EXPORT_KBPS);
      try {
        wake = await navigator.wakeLock?.request('screen');
      } catch (_) {
        // Optional: the page still works with the screen allowed to dim.
      }
      diag.add(`export: mp3, ${partSeconds / 60} min files, from part ${startIndex + 1} of ${chunks.length}, ${variant}`);
      const result = await AE.run({
        count: chunks.length,
        startIndex,
        sampleRate: rate,
        partSamples: partSeconds * rate,
        readPcm: (i) => exportPart(bookId, variant, i, chunks[i], timing),
        makeSink,
        onFile: (blob, n) => {
          const name = `${title} - ${String(n).padStart(2, '0')}.mp3`;
          diag.add(`export file ready: ${name}, ${blob.size} bytes`);
          addExportFile(blob, name);
        },
        onProgress: ({ done, total, audioSec, files }) => {
          const elapsed = (performance.now() - began) / 1000;
          const left = (total - done) * (elapsed / done);
          const speed = timing.wall > 0 ? (timing.audio / timing.wall).toFixed(2) : '–';
          setExportStatus(`Part ${done} of ${total} paragraphs · ${formatMinutes(audioSec)} of audio · ` +
            `generation ${speed}x realtime · ${files} file(s) ready · about ${formatMinutes(left)} left`);
        },
        isStopped: () => job.stop,
      });
      const speed = timing.wall > 0 ? (timing.audio / timing.wall).toFixed(2) : '–';
      const stopped = result.stopped ? 'Stopped. ' : 'Done. ';
      setExportStatus(`${stopped}${result.files} file(s) from ${formatMinutes(result.audioSec)} of audio, generation ${speed}x realtime.`);
      diag.add(`export ${result.stopped ? 'stopped' : 'finished'}: ${result.files} files, generation ${speed}x`);
    } catch (err) {
      reportError(err);
      setExportStatus('The export stopped because of an error (see the log).');
    } finally {
      exporting = null;
      els.exportStart.disabled = false;
      els.exportStop.disabled = true;
      try {
        await wake?.release();
      } catch (_) {
        // Nothing to release.
      }
    }
  }

  function stopExport() {
    if (!exporting) return;
    exporting.stop = true;
    setExportStatus('Stopping after the current paragraph…');
  }

  async function copyPerf() {
    const text = els.perfText.textContent;
    try {
      await navigator.clipboard.writeText(text);
      els.perfMsg.textContent = 'Copied.';
    } catch (_) {
      const range = document.createRange();
      range.selectNodeContents(els.perfText);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      els.perfMsg.textContent = 'Press and hold the text to copy.';
    }
  }

  function showLibrary() {
    state.gen++;
    els.reader.hidden = true;
    els.library.hidden = false;
    els.settings.hidden = false;
    renderLibrary();
  }

  async function showReader(id) {
    let meta = await idbGet('books', id);
    let data = await idbGet('chunks', id);
    if (!meta || !data) throw new Error('That book is no longer stored on this device.');
    if (meta.chunkVersion !== R.CHUNK_VERSION) {
      // Older books were split into longer parts. Re-split them, keep the place roughly
      // where it was, and drop audio cut for the old parts.
      const paragraphs = data.paragraphs || data.chunks;
      const chunks = R.chunkText(paragraphs);
      const fraction = meta.position / Math.max(meta.count, 1);
      meta = {
        ...meta,
        count: chunks.length,
        position: Math.min(Math.floor(fraction * chunks.length), chunks.length - 1),
        offset: 0,
        chunkVersion: R.CHUNK_VERSION,
      };
      data = { id, paragraphs, chunks };
      await idbPut('chunks', data);
      await idbPut('books', meta);
      await evictAudio(id, '', Infinity);
    }
    state.book = meta;
    state.chunks = data.chunks;
    state.index = Math.min(meta.position, data.chunks.length - 1);
    state.offset = meta.offset || 0;
    state.playing = false;
    state.loaded = null;
    els.library.hidden = true;
    els.settings.hidden = true;
    els.reader.hidden = false;
    renderPerf();
    setStatus(state.index || state.offset ? 'Ready. Tap Play to continue where you stopped.' : 'Ready. Tap Play to start.');
    render();
  }

  async function closeReader() {
    if (state.book) {
      if (state.playing) finishRun();
      state.gen++;
      state.playing = false;
      audio.pause();
      await saveProgress();
    }
    state.book = null;
    state.chunks = null;
    state.loaded = null;
    showLibrary();
  }

  // Object URLs for the cover thumbnails currently shown; revoked when the list is redrawn.
  let coverUrls = [];

  async function loadCover(book) {
    if (!book.hasCover) return null;
    try {
      const rec = await idbGet('chunks', coverKey(book.id));
      return rec ? rec.blob : null;
    } catch (err) {
      diag.add(`cover of "${book.title}" could not be read: ` + describeFailure(err));
      return null;
    }
  }

  async function renderLibrary() {
    for (const url of coverUrls) URL.revokeObjectURL(url);
    coverUrls = [];
    let books = [];
    try {
      books = (await idbGetAll('books')).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
      els.importMsg.textContent = 'Storage is unavailable: ' + describeError(err);
      els.importMsg.className = 'muted error';
    }
    els.bookList.replaceChildren();
    if (!books.length) {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'No books yet. Upload an EPUB to start.';
      els.bookList.append(empty);
      return;
    }
    for (const book of books) {
      const li = document.createElement('li');
      const coverBlob = await loadCover(book);
      const cover = document.createElement(coverBlob ? 'img' : 'div');
      cover.className = 'cover';
      if (coverBlob) {
        const url = URL.createObjectURL(coverBlob);
        coverUrls.push(url);
        cover.src = url;
        cover.alt = '';
      } else {
        cover.classList.add('placeholder');
        cover.textContent = (book.title || '?').trim().charAt(0).toUpperCase();
        cover.setAttribute('aria-hidden', 'true');
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = book.title;
      const detail = document.createElement('div');
      detail.className = 'muted';
      detail.textContent = `${percent(book)}% · part ${book.position + 1} of ${book.count}`;
      meta.append(title, detail);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const open = document.createElement('button');
      open.className = 'small';
      open.type = 'button';
      open.textContent = book.position || book.offset ? 'Resume' : 'Open';
      open.addEventListener('click', () => showReader(book.id).catch(showImportError));
      const remove = document.createElement('button');
      remove.className = 'small danger';
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => removeBook(book));
      actions.append(open, remove);

      li.append(cover, meta, actions);
      els.bookList.append(li);
    }
  }

  async function removeBook(book) {
    if (!confirm(`Delete "${book.title}" and its cached audio from this device?`)) return;
    if (state.book && state.book.id === book.id) {
      state.gen++;
      state.playing = false;
      audio.pause();
      state.book = null;
      state.chunks = null;
      state.loaded = null;
    }
    await deleteBookData(book.id);
    renderLibrary();
  }

  // Shows an error on the status line and records it in the diagnostic log.
  function reportError(err) {
    diag.add('error: ' + describeFailure(err));
    setStatus(describeError(err), true);
  }

  function showImportError(err) {
    els.importMsg.textContent = describeError(err);
    els.importMsg.className = 'muted error';
    diag.add('import failed: ' + describeFailure(err));
  }

  // Diagnostic log under the book list. Each import step and any uncaught error is recorded,
  // so a failure can be copied from the phone even when the browser shows no message.
  // The log is also kept in local storage, so it survives the page being reloaded after a crash.
  const LOG_KEY = 'pet.log';
  const logStore = () => {
    try {
      return window.localStorage;
    } catch (_) {
      return null;
    }
  };
  const diag = {
    lines: [],
    add(text) {
      const stamp = new Date().toTimeString().slice(0, 8);
      this.lines.push(`${stamp} ${text}`);
      if (this.lines.length > 200) this.lines.shift();
      try {
        logStore()?.setItem(LOG_KEY, JSON.stringify(this.lines));
      } catch (_) {
        // Storage can be unavailable; the on-screen log still works.
      }
      if (els.logText) els.logText.textContent = this.lines.join('\n');
    },
    restore() {
      // Lines from before a reload, shown first and marked, so a crash leaves a trace.
      try {
        const previous = JSON.parse(logStore()?.getItem(LOG_KEY) || '[]');
        if (Array.isArray(previous) && previous.length) {
          this.lines = ['--- the page was reloaded; log from before the reload ---', ...previous];
          logStore().removeItem(LOG_KEY);
        }
      } catch (_) {
        // Nothing to restore.
      }
    },
  };
  diag.restore();

  // Turns whatever was thrown (an Error, a DOMException, a string, null) into readable text.
  function describeFailure(err, depth = 0) {
    if (err === null || err === undefined) return `no error object (${err})`;
    if (typeof err !== 'object') return `${typeof err}: ${String(err)}`;
    const parts = [err.name || 'object'];
    if (err.message) parts.push(String(err.message));
    if (err.code !== undefined) parts.push(`code ${err.code}`);
    if (err.stack && depth === 0) parts.push(String(err.stack).split('\n').slice(0, 4).join(' | '));
    if (err.cause && depth < 2) parts.push('caused by ' + describeFailure(err.cause, depth + 1));
    return parts.join(': ');
  }

  // A short, user-facing reason for an error. The full detail goes to the diagnostic log.
  function wrapFailure(message, err) {
    const wrapped = new Error(message + ' ' + (err && err.message ? err.message : String(err)));
    wrapped.cause = err;
    return wrapped;
  }

  async function copyLog() {
    const text = els.logText.textContent;
    try {
      await navigator.clipboard.writeText(text);
      els.logMsg.textContent = 'Copied.';
    } catch (_) {
      const range = document.createRange();
      range.selectNodeContents(els.logText);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      els.logMsg.textContent = 'Press and hold the text, then choose Copy.';
    }
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // The cover is optional: a broken or missing image must not stop the import.
  async function readCover(zip, cover) {
    if (!cover) return null;
    const entry = zip.file(cover.path);
    if (!entry) return null;
    try {
      const bytes = await entry.async('uint8array');
      return new Blob([bytes], { type: cover.mediaType });
    } catch (_) {
      return null;
    }
  }

  async function importEpub(file) {
    diag.add(`import: ${file.name || '(no name)'}, ${file.size} bytes, type "${file.type || ''}"`);
    if (typeof JSZip === 'undefined') throw new Error('The EPUB reader library did not load. Check your connection and reload.');
    els.importMsg.className = 'muted';
    els.importMsg.textContent = `Reading ${file.name}…`;
    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch (err) {
      throw wrapFailure('This file could not be opened as an EPUB (zip) archive.', err);
    }
    diag.add(`zip: ${Object.keys(zip.files).length} entries`);
    const readText = async (path) => {
      const entry = zip.file(path);
      if (!entry) throw new Error(`Missing ${path} in the EPUB`);
      return entry.async('string');
    };
    let epub;
    try {
      epub = await R.parseEpub(readText, window.DOMParser);
    } catch (err) {
      throw wrapFailure('The EPUB structure could not be read.', err);
    }
    diag.add(`parsed: "${epub.title}", ${epub.paragraphs.length} paragraphs, ${epub.chunks.length} parts, cover ${epub.cover ? epub.cover.path : 'none'}`);
    if (!epub.chunks.length) throw new Error('No readable text found in this EPUB.');
    const cover = await readCover(zip, epub.cover);
    const id = newId();
    try {
      await idbPut('chunks', { id, paragraphs: epub.paragraphs, chunks: epub.chunks });
    } catch (err) {
      throw wrapFailure('Saving the book text on this phone failed.', err);
    }
    diag.add('saved text');
    // The cover is saved first, and only then flagged on the book. If saving it fails, the
    // book is still stored and simply shows a letter instead.
    let hasCover = false;
    if (cover) {
      try {
        await idbPut('chunks', { id: coverKey(id), blob: cover });
        hasCover = true;
        diag.add('saved cover');
      } catch (err) {
        diag.add('cover not saved (the book is kept without it): ' + describeFailure(err));
      }
    }
    await idbPut('books', {
      id,
      title: epub.title || file.name.replace(/\.epub$/i, ''),
      author: epub.author,
      hasCover,
      count: epub.chunks.length,
      position: 0,
      offset: 0,
      chunkVersion: R.CHUNK_VERSION,
      updatedAt: Date.now(),
    });
    diag.add('saved book');
    els.importMsg.textContent = '';
    await showReader(id);
  }

  async function testServer() {
    const problem = checkServerUrl();
    if (problem) {
      els.serverMsg.textContent = problem;
      return;
    }
    els.serverMsg.className = 'muted';
    els.serverMsg.textContent = 'Testing…';
    try {
      const res = await fetch(serverUrl() + '/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      els.serverMsg.textContent = 'Server is reachable.';
    } catch (err) {
      els.serverMsg.className = 'muted error';
      els.serverMsg.textContent = describeError(err);
    }
  }

  // The on-device build speaks fewer voices than the server, so the list follows the engine.
  function voicesFor(engine) {
    if (engine === 'server' || !window.DeviceTTS) return VOICES;
    return window.DeviceTTS.voicesFor(engine === 'nano' ? 'nano' : 'pocket');
  }

  function populateVoices() {
    const list = voicesFor(currentEngine());
    const keep = els.voice.value || storage.get('pet.voice');
    els.voice.replaceChildren();
    for (const name of list) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      els.voice.append(option);
    }
    els.voice.value = list.includes(keep) ? keep : (list.includes(DEFAULT_VOICE) ? DEFAULT_VOICE : list[0]);
  }

  function showEngineFields() {
    const server = currentEngine() === 'server';
    els.serverField.hidden = !server;
    els.testServer.hidden = !server;
    els.serverMsg.textContent = '';
    els.prepare.hidden = server;
    // The WebGPU option only appears where the browser offers WebGPU.
    // The small model has no sampling temperature. WebGPU is offered for both models where available.
    const nano = currentEngine() === 'nano';
    els.backendField.hidden = server || !(window.DeviceTTS && window.DeviceTTS.gpuOffered(nano ? 'nano' : 'pocket'));
    els.tempField.hidden = server || nano;
  }

  async function prepareDevice() {
    els.prepare.disabled = true;
    try {
      await loadDeviceEngine();
      setStatus('Voice model ready on this device.');
    } catch (err) {
      reportError(err);
    } finally {
      els.prepare.disabled = false;
    }
  }

  function init() {
    // First visit: use the phone only if this browser can run the on-device build.
    const savedEngine = storage.get('pet.engine');
    const deviceOk = Boolean(window.DeviceTTS && window.DeviceTTS.supported());
    const engine = ['server', 'nano', 'browser'].includes(savedEngine) ? savedEngine : (deviceOk ? 'browser' : 'server');
    els.engine.value = engine;
    populateVoices();
    els.engine.addEventListener('change', () => {
      storage.set('pet.engine', currentEngine());
      populateVoices();
      storage.set('pet.voice', currentVoice());
      showEngineFields();
    });
    els.prepare.addEventListener('click', prepareDevice);
    const savedTemp = storage.get('pet.temp');
    els.temp.value = ['0.3', '0.5', '0.7', '1'].includes(savedTemp) ? savedTemp : '0.7';
    window.DeviceTTS.setTemperature(els.temp.value);
    els.temp.addEventListener('change', () => {
      storage.set('pet.temp', els.temp.value);
      window.DeviceTTS.setTemperature(els.temp.value);
      setStatus('Expressiveness changed. Tap Play to hear it.');
    });
    const savedBackend = storage.get('pet.backend') === 'gpu' ? 'gpu' : 'cpu';
    els.backend.value = savedBackend;
    if (window.DeviceTTS) window.DeviceTTS.setBackend(savedBackend);
    els.backend.addEventListener('change', () => {
      storage.set('pet.backend', els.backend.value);
      window.DeviceTTS.setBackend(els.backend.value);
      setStatus('Speed setting changed. Tap Download voice model or Play to load it.');
    });
    els.server.value = storage.get('pet.server') || '';
    els.server.addEventListener('change', () => storage.set('pet.server', serverUrl()));
    // Settings are only shown in the library, so the voice never changes under a playing book.
    els.voice.addEventListener('change', () => storage.set('pet.voice', currentVoice()));
    els.testServer.addEventListener('click', testServer);
    showEngineFields();

    els.file.addEventListener('change', async () => {
      const file = els.file.files[0];
      els.file.value = '';
      if (!file) return;
      try {
        await importEpub(file);
      } catch (err) {
        showImportError(err);
      }
    });
    els.logCopy.addEventListener('click', copyLog);
    diag.add(`page loaded; ${navigator.userAgent}`);
    diag.add(`JSZip ${typeof JSZip}, DOMParser ${typeof window.DOMParser}, indexedDB ${typeof indexedDB}, File ${typeof File}`);
    window.addEventListener('error', (e) => diag.add(`error: ${e.message || '(no message)'} at ${e.filename || '?'}:${e.lineno || '?'}`));
    window.addEventListener('unhandledrejection', (e) => diag.add('unhandled rejection: ' + describeFailure(e.reason)));

    els.toggle.addEventListener('click', () => (state.playing ? pause() : play()));
    els.rate.value = RATES.includes(storage.get('pet.rate')) ? storage.get('pet.rate') : '1';
    els.rate.addEventListener('change', () => {
      storage.set('pet.rate', els.rate.value);
      audio.playbackRate = currentRate();
      audio.preservesPitch = true;
    });
    els.perfCopy.addEventListener('click', copyPerf);
    els.exportStart.addEventListener('click', startExport);
    els.exportStop.addEventListener('click', stopExport);
    els.prev.addEventListener('click', () => jump(-1));
    els.next.addEventListener('click', () => jump(1));
    els.back.addEventListener('click', closeReader);

    // Save whenever the page may be closed, so the position is current on the next visit.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveProgress();
    });
    window.addEventListener('pagehide', saveProgress);

    setupMediaSession();
    try {
      navigator.storage?.persist?.();
    } catch (_) {
      // Optional: asks the browser to keep the cached audio under storage pressure.
    }
    showLibrary();
  }

  init();
})();
