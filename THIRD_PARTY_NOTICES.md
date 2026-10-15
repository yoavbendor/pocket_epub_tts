# Third-party notices

The code written for this project is under the MIT License (see `LICENSE`). The
components below are not ours. Each one keeps its own license, listed here with where
it comes from and how this project uses it.

## Voice model: Pocket TTS (Kyutai)

- **What:** the speech model and its voices. The page downloads them from Hugging Face at
  run time, so they are not in this repository.
- **Source:** https://huggingface.co/kyutai/pocket-tts-without-voice-cloning (model card) and
  https://github.com/kyutai-labs/pocket-tts (code).
- **License:** the model and voices are **CC BY 4.0**. Credit Kyutai, link to the license,
  and say if the material was changed. The code of Pocket TTS is **MIT**.
- **Quantized weights:** the page's on-device voice uses `tts_b6369a24.gguf` from
  https://huggingface.co/lmz/pocket-tts-without-voice-cloning-q8. That repository states no
  license. It is a quantized copy of the Kyutai weights, so the Kyutai attribution applies,
  but the terms of this copy are **not confirmed**.

## Browser build of the voice (vendor/)

- **What:** `vendor/pocket-tts-wasm/` and `vendor/pocket-tts-wasm-gpu/` hold a WebAssembly build
  of the voice, made from our wrapper in `wrapper-src/` (our code, MIT).
- **Rust libraries used:** `ptts` 0.2.3 and `xn` 0.2.11 by Laurent Mazare, from
  https://github.com/LaurentMazare/xn-ptts. Their code is **MIT OR Apache-2.0**; the
  repository has both license texts. `wasm-bindgen`, `js-sys`, `getrandom` and the other
  crates in `Cargo.lock` are under their own licenses, most often MIT OR Apache-2.0. We have
  not checked each one.
- **Demo worker:** `vendor/pocket-tts-wasm/worker.js` (and the worker derived from it in
  `vendor/pocket-tts-wasm-gpu/`) comes from the demo page at
  https://laurentmazare.github.io/pocket-tts/. **Its license is not confirmed.** Its source
  repository could not be read from here, so this needs checking before the page is shared
  more widely. See `vendor/*/VENDORED.txt`.

## Libraries loaded from cdnjs

- **JSZip 3.10.2** (https://github.com/Stuk/jszip), reads the EPUB file. **MIT OR GPL-3.0-or-later**;
  this project uses it under the MIT option.
- **lamejs 1.2.1** (https://github.com/zhuker/lamejs), encodes MP3 for the audio export. **LGPL-3.0**.
  It is loaded unmodified, and only when you export MP3.

## Removed

- KittenTTS nano (KittenML, Apache-2.0 model) and espeak-ng (GPL-3.0-or-later) were used by an
  earlier small voice. Both were removed from the project. The commit history still contains them.
