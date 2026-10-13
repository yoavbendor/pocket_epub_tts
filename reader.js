// Pure helpers for Pocket EPUB TTS: EPUB structure, text extraction, chunking
// and WAV header repair. No DOM access except where a DOMParser is passed in,
// so the logic can be unit-tested in Node (see tests/reader.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PocketReader = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Chunk size in characters, about one or two sentences. Bump CHUNK_VERSION when the
  // chunking changes, so books stored with the old chunks are re-split on open.
  const CHUNK_CHARS = 160;
  const CHUNK_VERSION = 4;

  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
      }
      return NAMED_ENTITIES[body] ?? all;
    });
  }

  function normalizeSpace(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  // Resolve an href from a manifest/spine entry against the file that contains it.
  // e.g. resolvePath('OEBPS/content.opf', 'text/ch1.xhtml#x') -> 'OEBPS/text/ch1.xhtml'
  function resolvePath(baseFile, href) {
    let clean = href.split('#')[0].split('?')[0];
    try {
      clean = decodeURIComponent(clean);
    } catch (_) {
      // Keep the raw href if it is not valid percent-encoding.
    }
    if (clean.startsWith('/')) return clean.slice(1);
    const dir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : '';
    const parts = [];
    for (const seg of (dir + clean).split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }

  function attr(attrString, name) {
    const m = attrString.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`));
    return m ? decodeEntities(m[1]) : null;
  }

  function tagText(xml, localName) {
    const m = xml.match(new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`));
    return m ? normalizeSpace(decodeEntities(m[1].replace(/<[^>]*>/g, ''))) : '';
  }

  // Returns the path of the OPF package document named in META-INF/container.xml.
  function parseContainer(containerXml) {
    const m = containerXml.match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/);
    if (!m) throw new Error('This is not a valid EPUB (no rootfile in container.xml)');
    return decodeEntities(m[1]);
  }

  // Reads metadata and the reading order (spine) from an OPF package document.
  function parseOpf(opfXml) {
    const manifest = new Map();
    for (const m of opfXml.matchAll(/<(?:[\w.-]+:)?item\b([^>]*?)\/?>/g)) {
      const id = attr(m[1], 'id');
      const href = attr(m[1], 'href');
      if (id && href) manifest.set(id, href);
    }
    const spine = [];
    for (const m of opfXml.matchAll(/<(?:[\w.-]+:)?itemref\b([^>]*?)\/?>/g)) {
      const idref = attr(m[1], 'idref');
      if (idref && manifest.has(idref)) spine.push(manifest.get(idref));
    }
    return {
      title: tagText(opfXml, 'title'),
      author: tagText(opfXml, 'creator'),
      spine,
    };
  }

  // Elements whose text is read as its own block, and elements whose content is skipped.
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CENTER', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'HTML', 'LI',
    'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL', 'BR',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'SVG', 'IMG', 'AUDIO', 'VIDEO', 'NOSCRIPT', 'TEMPLATE']);

  // Walks a DOM node and pushes one string per visual block of text, in reading order.
  function collectBlocks(node, out) {
    let run = '';
    const flush = () => {
      const text = normalizeSpace(run);
      if (text) out.push(text);
      run = '';
    };
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        run += child.nodeValue;
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toUpperCase();
        if (SKIP_TAGS.has(tag)) continue;
        if (BLOCK_TAGS.has(tag)) {
          flush();
          collectBlocks(child, out);
          flush();
        } else {
          run += ' ' + child.textContent + ' ';
        }
      }
    }
    flush();
    return out;
  }

  // Extracts the readable paragraphs of one XHTML content document.
  // `DOMParserImpl` is the DOMParser constructor (window.DOMParser in browsers).
  function paragraphsFromXhtml(xhtml, DOMParserImpl) {
    const parser = new DOMParserImpl();
    let doc = parser.parseFromString(xhtml, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) {
      // Not well-formed XML: fall back to the forgiving HTML parser.
      doc = new DOMParserImpl().parseFromString(xhtml, 'text/html');
    }
    const body = doc.body || doc.documentElement;
    return collectBlocks(body, []);
  }

  // Splits text into sentences; sentences longer than maxLen are cut at a space.
  function sentencesOf(text, maxLen) {
    const out = [];
    for (const m of text.matchAll(/[^.!?…]*[.!?…]+["'”’)\]]*|[^.!?…]+$/g)) {
      let s = m[0].trim();
      while (s.length > maxLen) {
        // Prefer a clause break (comma, semicolon, colon, dash) that keeps at least 40%
        // of the limit; otherwise break at a space. Never cut inside a word if avoidable.
        const head = s.slice(0, maxLen + 1);
        const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' — '));
        const clauseCut = clause >= maxLen * 0.4 ? clause + 1 : -1;
        const spaceCut = head.lastIndexOf(' ');
        const at = clauseCut > 0 ? clauseCut : spaceCut > 0 ? spaceCut : maxLen;
        out.push(s.slice(0, at).trim());
        s = s.slice(at).trim();
      }
      if (s) out.push(s);
    }
    return out;
  }

  // Groups sentences into chunks of at most maxLen characters. Each chunk is one
  // TTS request: smaller chunks mean the first sound comes sooner.
  // Makes text easier for the voice: quote marks are dropped (the model reads them as odd
  // emphasis), curly apostrophes become plain ones, and dashes become a short pause.
  function normalizeText(text) {
    return text
      .replace(/["\u201C\u201D\u201E\u00AB\u00BB]/g, '')
      .replace(/[\u2018\u2019\u201A]/g, "'")
      .replace(/\s*[\u2014\u2013]\s*/g, ', ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function chunkText(paragraphs, maxLen = CHUNK_CHARS) {
    const chunks = [];
    let current = '';
    for (const raw of paragraphs) {
      const paragraph = normalizeText(raw);
      for (const sentence of sentencesOf(paragraph, maxLen)) {
        if (current && current.length + 1 + sentence.length > maxLen) {
          chunks.push(current);
          current = sentence;
        } else {
          current = current ? current + ' ' + sentence : sentence;
        }
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // pocket-tts streams WAV from a non-seekable output, so the RIFF and data sizes
  // are placeholders (about 1e9 frames). Rewrite them from the real byte count so
  // that browsers, and iOS in particular, see a complete file.
  function fixWavHeader(buffer) {
    const bytes = new Uint8Array(buffer.slice(0));
    const view = new DataView(bytes.buffer);
    const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return buffer;
    let p = 12;
    while (p + 8 <= bytes.length) {
      if (tag(p) === 'data') {
        view.setUint32(p + 4, bytes.length - (p + 8), true);
        view.setUint32(4, bytes.length - 8, true);
        return bytes.buffer;
      }
      const size = view.getUint32(p + 4, true);
      p += 8 + size + (size & 1);
    }
    return buffer;
  }

  // Joins mono Float32 chunks and encodes them as a 16-bit PCM WAV file.
  function encodeWav(chunks, sampleRate) {
    let samples = 0;
    for (const c of chunks) samples += c.length;
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
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, c[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
    }
    return buffer;
  }

  // Reads a whole EPUB. `readText(path)` returns a file's text, or throws if it is missing.
  async function parseEpub(readText, DOMParserImpl) {
    const opfPath = parseContainer(await readText('META-INF/container.xml'));
    const opf = parseOpf(await readText(opfPath));
    const paragraphs = [];
    for (const href of opf.spine) {
      let xhtml;
      try {
        xhtml = await readText(resolvePath(opfPath, href));
      } catch (_) {
        continue; // A spine item missing from the archive should not stop the whole book.
      }
      paragraphs.push(...paragraphsFromXhtml(xhtml, DOMParserImpl));
    }
    return { title: opf.title, author: opf.author, paragraphs, chunks: chunkText(paragraphs) };
  }

  return {
    resolvePath,
    parseContainer,
    parseOpf,
    paragraphsFromXhtml,
    sentencesOf,
    chunkText,
    normalizeText,
    CHUNK_CHARS,
    CHUNK_VERSION,
    fixWavHeader,
    encodeWav,
    parseEpub,
  };
});
