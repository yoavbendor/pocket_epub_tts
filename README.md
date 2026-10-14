# Pocket EPUB TTS

A static web page for iPhone (Chrome). Upload an EPUB, and it is read aloud by a
[pocket-tts](https://github.com/kyutai-labs/pocket-tts) server. Playback can be stopped
and resumed later, including after you close the tab or restart the phone.

No build step: the whole app is `index.html`, `reader.js` and `app.js`, so it can be
served by GitHub Pages or any static host.

## How it works

1. The page parses the EPUB in the browser (reading order from the OPF spine, text from
   the XHTML), and splits the text into parts of up to 160 characters (about one or two
   sentences).
2. Each paragraph is turned into speech by one of two engines, chosen under **Voice**:
   - **On this phone (default):** the model runs in the browser as WebAssembly with SIMD128
     (no relaxed SIMD, so iOS 16.4 and later can load it). The module is built from
     `vendor/pocket-tts-wasm/wrapper-src/` (see `BUILD.md`) on top of Laurent Mazare's
     xn-ptts library, with the demo's worker. No server is needed. The first use downloads
     about 146 MB of weights from Hugging Face. This build has 4 voices (alba, anna, azelma, jane).
     On a 4-core desktop it generated speech at about 1.1x real time. Phones have not been measured. `device-tts.js` wraps the worker.
     **Speed on this phone** (shown where the browser offers WebGPU) switches to an experimental
     WebGPU build in `vendor/pocket-tts-wasm-gpu/`. It is not measured on a phone yet. See its
     `VENDORED.txt` and `BUILD.md`.
   - **My pocket-tts server:** each paragraph is sent to `POST /tts` on your server (the
     setup below).
   Each part is generated as its own WAV, cached in IndexedDB keyed by engine and voice, and
   the next four parts are generated while the current one plays. Playback starts after the
   first two parts are ready (a short buffer, so waits between parts are rare).
3. Audio plays through an `<audio>` element. Media Session gives lock-screen Play, Pause,
   Previous and Next.
4. The book text, reading position and cached audio all live in IndexedDB on the phone.
   Your position is saved on pause, every few seconds while playing, and when the page
   is hidden or closed. When you come back, the library shows **Resume**.

## What you need

- A machine that runs pocket-tts (CPU is fine). See the pocket-tts README for install.
- That machine reachable from the iPhone **over https**, with CORS set up (see below).
- This page served over https, for example GitHub Pages.

## 1. Run pocket-tts

```bash
uvx pocket-tts serve --host 127.0.0.1 --port 8000
# or: pip install pocket-tts && pocket-tts serve --host 127.0.0.1 --port 8000
```

Keep it on `127.0.0.1` and put a reverse proxy in front of it (step 2).

## 2. Make it reachable over https, with CORS

The iPhone needs an **https** URL: Chrome on iOS, like Safari, blocks plain `http://`
requests from an https page. pocket-tts also only sends CORS headers for its own list of
origins (`localhost:3000`, `kyutai.org`, …), so your page's origin has to be allowed by the
proxy. A Caddy example, with a domain that points at your machine:

```caddyfile
tts.example.com {
    header Access-Control-Allow-Origin "https://yoavbendor.github.io"
    reverse_proxy 127.0.0.1:8000
}
```

Caddy gets the TLS certificate automatically. Any other https tunnel (Cloudflare Tunnel,
Tailscale Funnel, …) works too, as long as it adds the same `Access-Control-Allow-Origin`
header. Use the origin of wherever you host this page: the scheme and host only, with no path.
For a local test in desktop Chrome, use `http://localhost:8080`.

## 3. Host this page

Push this repository and enable GitHub Pages (Settings → Pages → deploy from the branch,
root folder). The page is then at `https://<user>.github.io/<repo>/`.

## 4. Use it on the iPhone

1. Open the page in Chrome. Under **Server**, enter your https URL and tap **Test server**.
   It should say "Server is reachable."
2. Pick a voice (default `alba`).
3. Tap **Upload EPUB** and choose the file (from iCloud Drive, On My iPhone, …).
4. Tap **Play**. Tap **Pause** to stop. Later, open the page, tap **Resume** on the book, and
   tap **Play**. You continue from the paragraph where you stopped.

## Behaviour and limits

- **Resuming** works after closing the tab or restarting the phone, as long as the server is
  reachable again. Only the paragraph and offset are stored, so the audio for the position
  is regenerated if it is no longer cached.
- **Background playback**: iOS does not run web pages in the background. Audio can keep
  playing with the screen locked while it is playing, via the lock-screen controls, but this
  is up to iOS. It stops when the tab is closed. Test it on your own phone.
- **Storage**: about 1.3 MB of audio per paragraph, and only the next few paragraphs are kept.
  Clearing Chrome's website data deletes books and positions. Tapping **Delete** removes a
  book and its audio.
- **Covers**: the book list shows the EPUB's cover image, taken at upload. Books uploaded
  before this change show a letter instead; delete and upload them again to get the cover.
- **Import problems**: each import step and any uncaught error is written to the **Diagnostic
  log** under the book list. Use **Copy log** to send it when an EPUB will not load.
- **Export audio** (reader card) makes the book into MP3 files of 15, 30 or 60 minutes, each
  offered as a Save link. It uses the current voice and engine, takes about as long as the
  audio divided by the generation speed, and needs the page open with the screen on. The MP3
  encoder (lamejs, LGPL) loads from cdnjs only when you export.
- **EPUB support**: text in the spine is read in order. Images, footnote popups and
  DRM-protected books are not handled. Some EPUB 2 quirks may affect the title or author.
- **Expressiveness** (on-device only) sets the sampling temperature: 0.3 is steadier, 1.0 is
  more varied in pitch and emphasis. Default 0.7. Changing it takes effect on the next part,
  and each setting is cached separately.
- **Text clean-up** before speech: quote marks are dropped (they made the voice emphasise
  quoted words), curly apostrophes become plain ones, and dashes become a short pause. Books
  stored before this change are re-split when opened.
- Only the English voices from the pocket-tts README are offered. Other languages would need
  their own model (`pocket-tts serve --language …` on the server) and a different voice list.


## Comparing speed and settings

- **Performance** (under the player): each listening run, from Play to Pause or the end of
  the book, is summarised: first sound, model load, generation speed as a multiple of real
  time, and waits during playback. The panel shows the runs from the current visit; it starts empty each time the page opens. **Copy numbers**
  puts them on the clipboard.
- **Playback speed** (1.0x to 2.0x) speeds up the audio only. Generation is not faster, so
  a higher speed uses audio faster than it is made. The waits in the summary show whether a
  speed holds up on your phone.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout and styles. Loads JSZip from cdnjs. |
| `reader.js` | Pure logic: EPUB structure, text extraction, chunking, WAV header repair. |
| `app.js` | Storage (IndexedDB), synthesis queue, playback, Media Session, UI. |
| `tests/reader.test.js` | Unit tests for `reader.js`. |

Run the unit tests with Node 18 or later:

```bash
node --test tests/reader.test.js
```

## Notes on the implementation

- pocket-tts streams WAV from a non-seekable output, so the header carries placeholder
  sizes. `fixWavHeader` rewrites them from the real byte count, so iOS gets a complete file.
- Requests go to the server one at a time, since the model runs on a small CPU.
- The Play tap starts a silent clip before the first real paragraph is ready. That unlocks
  the audio element on iOS, so playback can begin after the server responds.
