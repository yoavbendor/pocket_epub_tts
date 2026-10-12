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
    server: $('server'),
    voice: $('voice'),
    testServer: $('test-server'),
    serverMsg: $('server-msg'),
    library: $('library-card'),
    file: $('file'),
    importMsg: $('import-msg'),
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
  const audio = els.audio;

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
      t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
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

  async function deleteBookData(id) {
    const db = await openDb();
    const t = db.transaction(['books', 'chunks', 'audio'], 'readwrite');
    t.objectStore('books').delete(id);
    t.objectStore('chunks').delete(id);
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

  // 'browser' runs the model on this device; 'server' calls a pocket-tts server.
  function currentEngine() {
    return els.engine.value === 'server' ? 'server' : 'browser';
  }

  // Cached audio depends on both the engine and the voice, so the variant is part of its key.
  function currentVariant() {
    return `${currentEngine()}:${currentVoice()}`;
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
    return window.DeviceTTS.load((msg) => {
      if (msg.type === 'progress' && msg.pct >= 0) setStatus(`Downloading ${msg.label}: ${msg.pct}%`);
      else if (msg.type === 'status') setStatus(msg.message);
    });
  }

  async function synthesizeOnDevice(text, voice) {
    await loadDeviceEngine();
    const { chunks, sampleRate } = await window.DeviceTTS.generate(text, voice);
    if (!chunks.length) throw new Error('The on-device voice produced no audio for this part.');
    return new Blob([R.encodeWav(chunks, sampleRate)], { type: 'audio/wav' });
  }

  // `variant` is 'browser:<voice>' or 'server:<voice>', as built by currentVariant().
  function synthesize(text, variant) {
    const sep = variant.indexOf(':');
    const engine = variant.slice(0, sep);
    const voice = variant.slice(sep + 1);
    return engine === 'server' ? synthesizeOnServer(text, voice) : synthesizeOnDevice(text, voice);
  }

  const inflight = new Map();
  const chunkKey = (bookId, variant, index) => `${bookId}|${variant}|${index}`;

  // Returns the WAV for one paragraph, from the IndexedDB cache when possible.
  function getChunkBlob(bookId, variant, index, text, priority = PRIORITY_AHEAD) {
    const key = chunkKey(bookId, variant, index);
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const cached = await idbGet('audio', key);
      if (cached) return cached.blob;
      const blob = await serial(() => synthesize(text, variant), priority);
      await idbPut('audio', { key, bookId, voice: variant, index, blob });
      return blob;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
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
    if (err instanceof TypeError) {
      return 'Could not reach the pocket-tts server. Check the URL, that it is https, and that it allows this page (see README).';
    }
    if (err && err.name === 'NotAllowedError') return 'The browser blocked playback. Tap Play again.';
    return (err && err.message) || String(err);
  }

  async function startCurrent() {
    const gen = ++state.gen;
    const { book, chunks, index } = state;
    const variant = currentVariant();
    const key = chunkKey(book.id, variant, index);
    try {
      if (state.loaded !== key) {
        setStatus(`Loading part ${index + 1} of ${chunks.length}…`);
        const blob = await getChunkBlob(book.id, variant, index, chunks[index], PRIORITY_NOW);
        if (gen !== state.gen) return;
        setSource(blob, key);
        state.pendingSeek = state.offset;
      }
      await audio.play();
      if (gen !== state.gen) return;
      setStatus('Playing');
    } catch (err) {
      if (gen !== state.gen) return;
      state.playing = false;
      setStatus(describeError(err), true);
      render();
      return;
    }
    prefetch();
  }

  function play() {
    if (!state.book) return;
    state.playing = true;
    render();
    if (state.loaded !== chunkKey(state.book.id, currentVariant(), state.index)) {
      // Unlock inside the tap, before any await. The silent clip is not the current source,
      // so its events are ignored by the handlers below.
      state.loaded = null;
      audio.src = silentUrl();
      audio.play().catch(() => {});
    }
    return startCurrent();
  }

  function pause() {
    state.gen++;
    state.playing = false;
    audio.pause();
    setStatus('Paused');
    render();
    saveProgress();
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

  audio.addEventListener('loadedmetadata', () => {
    if (!isCurrentSource() || !state.pendingSeek) return;
    if (isFinite(audio.duration)) audio.currentTime = Math.min(state.pendingSeek, audio.duration - 0.5);
    state.offset = audio.currentTime;
    state.pendingSeek = 0;
  });

  audio.addEventListener('timeupdate', () => {
    if (!isCurrentSource()) return;
    state.offset = audio.currentTime;
    if (Date.now() - state.lastSave > 5000) saveProgress();
  });

  audio.addEventListener('ended', () => {
    if (!state.playing || !isCurrentSource()) return;
    if (state.index + 1 >= state.chunks.length) {
      // Finished: the next Play starts the book again.
      state.playing = false;
      state.index = 0;
      state.offset = 0;
      setStatus('Finished. Tap Play to read it again.');
      render();
      saveProgress();
      return;
    }
    state.index++;
    state.offset = 0;
    saveProgress();
    render();
    startCurrent();
  });

  // The system paused us (phone call, Siri, lock screen). Keep the UI honest.
  audio.addEventListener('pause', () => {
    const atEnd = audio.ended || (isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.05);
    if (!state.playing || !isCurrentSource() || atEnd) return;
    state.gen++;
    state.playing = false;
    setStatus('Paused');
    render();
    saveProgress();
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
    setStatus(state.index || state.offset ? 'Ready. Tap Play to continue where you stopped.' : 'Ready. Tap Play to start.');
    render();
  }

  async function closeReader() {
    if (state.book) {
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

  async function renderLibrary() {
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

      li.append(meta, actions);
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

  function showImportError(err) {
    els.importMsg.textContent = describeError(err);
    els.importMsg.className = 'muted error';
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  async function importEpub(file) {
    if (typeof JSZip === 'undefined') throw new Error('The EPUB reader library did not load. Check your connection and reload.');
    els.importMsg.className = 'muted';
    els.importMsg.textContent = `Reading ${file.name}…`;
    const zip = await JSZip.loadAsync(file);
    const readText = async (path) => {
      const entry = zip.file(path);
      if (!entry) throw new Error(`Missing ${path} in the EPUB`);
      return entry.async('string');
    };
    const epub = await R.parseEpub(readText, window.DOMParser);
    if (!epub.chunks.length) throw new Error('No readable text found in this EPUB.');
    const id = newId();
    await idbPut('chunks', { id, paragraphs: epub.paragraphs, chunks: epub.chunks });
    await idbPut('books', {
      id,
      title: epub.title || file.name.replace(/\.epub$/i, ''),
      author: epub.author,
      count: epub.chunks.length,
      position: 0,
      offset: 0,
      chunkVersion: R.CHUNK_VERSION,
      updatedAt: Date.now(),
    });
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
    return engine === 'browser' && window.DeviceTTS ? window.DeviceTTS.VOICES : VOICES;
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
    els.voice.value = list.includes(keep) ? keep : DEFAULT_VOICE;
  }

  function showEngineFields() {
    const server = currentEngine() === 'server';
    els.serverField.hidden = !server;
    els.testServer.hidden = !server;
    els.serverMsg.textContent = '';
    els.prepare.hidden = server;
  }

  async function prepareDevice() {
    els.prepare.disabled = true;
    try {
      await loadDeviceEngine();
      setStatus('Voice model ready on this device.');
    } catch (err) {
      setStatus(describeError(err), true);
    } finally {
      els.prepare.disabled = false;
    }
  }

  function init() {
    // First visit: use the phone only if this browser can run the on-device build.
    const savedEngine = storage.get('pet.engine');
    const deviceOk = Boolean(window.DeviceTTS && window.DeviceTTS.supported());
    const engine = savedEngine || (deviceOk ? 'browser' : 'server');
    els.engine.value = engine === 'server' ? 'server' : 'browser';
    populateVoices();
    els.engine.addEventListener('change', () => {
      storage.set('pet.engine', currentEngine());
      populateVoices();
      storage.set('pet.voice', currentVoice());
      showEngineFields();
    });
    els.prepare.addEventListener('click', prepareDevice);
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

    els.toggle.addEventListener('click', () => (state.playing ? pause() : play()));
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
