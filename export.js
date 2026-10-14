// Makes a book into audio files, a part at a time, for saving. Pure logic: the caller says how
// to get a part's samples and how to encode them, so this runs and is tested in Node
// (see tests/export.test.js). Exposes window.AudioExport.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AudioExport = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Writes 16-bit mono PCM (a list of Int16Array parts) as a WAV file.
  function wavFromPcm(parts, sampleRate) {
    let samples = 0;
    for (const p of parts) samples += p.length;
    const dataSize = samples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const ascii = (offset, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    ascii(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, dataSize, true);
    let offset = 44;
    for (const p of parts) {
      for (let i = 0; i < p.length; i++, offset += 2) view.setInt16(offset, p[i], true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  // A sink collects samples for one file and returns the finished Blob from finish().
  function wavSink(sampleRate) {
    const parts = [];
    return {
      add(pcm) { parts.push(pcm); },
      finish() { return wavFromPcm(parts, sampleRate); },
    };
  }

  // `lamejs` is the global from lame.min.js. MP3 frames are 1152 samples.
  function mp3Sink(lamejs, sampleRate, kbps) {
    const enc = new lamejs.Mp3Encoder(1, sampleRate, kbps);
    const out = [];
    const FRAME = 1152;
    return {
      add(pcm) {
        for (let k = 0; k < pcm.length; k += FRAME) {
          const bytes = enc.encodeBuffer(pcm.subarray(k, k + FRAME));
          if (bytes.length) out.push(bytes);
        }
      },
      finish() {
        const end = enc.flush();
        if (end.length) out.push(end);
        return new Blob(out, { type: 'audio/mpeg' });
      },
    };
  }

  // Runs an export. Options:
  //   count, startIndex      parts to make (startIndex up to count)
  //   sampleRate             samples per second of the parts
  //   partSamples            a file is finished once it holds at least this many samples
  //   readPcm(index)         Promise<Int16Array> for one part
  //   makeSink()             a fresh sink for each file
  //   onFile(blob, number)   called with each finished file (may be async)
  //   onProgress(info)       after each part: { done, total, audioSec, files }
  //   isStopped()            true when the user has asked to stop
  // A file cut short by a stop is dropped, so every file delivered is complete.
  async function run(options) {
    const { count, startIndex, sampleRate, partSamples, readPcm, makeSink, onFile, onProgress, isStopped } = options;
    let sink = null;
    let samples = 0;
    let files = 0;
    let audioSec = 0;
    const finishFile = async () => {
      if (!sink || samples === 0) return;
      const blob = sink.finish();
      sink = null;
      samples = 0;
      files++;
      await onFile(blob, files);
    };
    for (let i = startIndex; i < count; i++) {
      if (isStopped()) return { stopped: true, files, audioSec };
      const pcm = await readPcm(i);
      if (isStopped()) return { stopped: true, files, audioSec };
      if (!sink) sink = makeSink();
      sink.add(pcm);
      samples += pcm.length;
      audioSec += pcm.length / sampleRate;
      if (samples >= partSamples) await finishFile();
      if (onProgress) onProgress({ done: i - startIndex + 1, total: count - startIndex, audioSec, files });
    }
    await finishFile();
    return { stopped: false, files, audioSec };
  }

  return { wavFromPcm, wavSink, mp3Sink, run };
});
