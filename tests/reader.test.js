// Run with: node --test tests/reader.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../reader.js');

test('resolvePath resolves relative hrefs against the OPF folder', () => {
  assert.equal(R.resolvePath('OEBPS/content.opf', 'text/ch1.xhtml'), 'OEBPS/text/ch1.xhtml');
  assert.equal(R.resolvePath('OEBPS/content.opf', '../shared/a.xhtml#frag'), 'shared/a.xhtml');
  assert.equal(R.resolvePath('content.opf', 'ch%201.xhtml?x=1'), 'ch 1.xhtml');
  assert.equal(R.resolvePath('OEBPS/content.opf', '/root.xhtml'), 'root.xhtml');
});

test('parseContainer finds the package document', () => {
  const xml = `<?xml version="1.0"?><container><rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles></container>`;
  assert.equal(R.parseContainer(xml), 'OEBPS/content.opf');
  assert.throws(() => R.parseContainer('<container/>'), /not a valid EPUB/);
});

test('parseOpf reads title, author and spine order from the manifest', () => {
  const opf = `<?xml version="1.0"?>
  <package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <metadata>
      <dc:title>Tom &amp; Jerry</dc:title>
      <dc:creator id="c1">Jane Doe</dc:creator>
    </metadata>
    <manifest>
      <item href="text/b.xhtml" id="b" media-type="application/xhtml+xml"/>
      <item media-type="application/xhtml+xml" id="a" href="text/a.xhtml"/>
      <item id="css" href="style.css" media-type="text/css"/>
    </manifest>
    <spine>
      <itemref idref="a"/>
      <itemref idref="b" linear="yes"/>
      <itemref idref="missing"/>
    </spine>
  </package>`;
  const parsed = R.parseOpf(opf);
  assert.equal(parsed.title, 'Tom & Jerry');
  assert.equal(parsed.author, 'Jane Doe');
  assert.deepEqual(parsed.spine, ['text/a.xhtml', 'text/b.xhtml']);
});

test('parseOpf finds the cover image from EPUB 3 or EPUB 2 metadata', () => {
  const epub3 = `<package><manifest>
      <item id="cov" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
      <item id="p" href="cover.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="p"/></spine></package>`;
  assert.deepEqual(R.parseOpf(epub3).cover, { href: 'images/cover.jpg', mediaType: 'image/jpeg' });
  const epub2 = `<package><metadata><meta name="cover" content="img1"/></metadata><manifest>
      <item id="img1" href="art/front.png" media-type="image/png"/></manifest><spine/></package>`;
  assert.deepEqual(R.parseOpf(epub2).cover, { href: 'art/front.png', mediaType: 'image/png' });
  // A cover that is not an image (for example an XHTML page) is ignored.
  const page = `<package><manifest><item id="p" href="cover.xhtml" media-type="application/xhtml+xml" properties="cover-image"/></manifest><spine/></package>`;
  assert.equal(R.parseOpf(page).cover, null);
  assert.equal(R.parseOpf('<package><manifest/><spine/></package>').cover, null);
});

test('sentencesOf splits on sentence ends and cuts overlong sentences at spaces', () => {
  assert.deepEqual(R.sentencesOf('One. Two! Three?', 100), ['One.', 'Two!', 'Three?']);
  assert.deepEqual(R.sentencesOf('He said "Stop." Then left.', 100), ['He said "Stop."', 'Then left.']);
  const long = 'word '.repeat(10).trim();
  const pieces = R.sentencesOf(long, 12);
  assert.ok(pieces.every((p) => p.length <= 12), JSON.stringify(pieces));
  assert.equal(pieces.join(' '), long);
});

test('sentencesOf breaks long sentences at commas before falling back to spaces', () => {
  const pieces = R.sentencesOf('When the rain finally stopped, the village came out, blinking, into the square and talked for hours', 40);
  assert.ok(pieces.every((p) => p.length <= 40), JSON.stringify(pieces));
  assert.equal(pieces[0], 'When the rain finally stopped,');
  assert.equal(pieces[1], 'the village came out, blinking,');
});

test('normalizeText drops quote marks and turns dashes into pauses', () => {
  assert.equal(R.normalizeText('\u201CHello,\u201D she said \u2014 softly.'), 'Hello, she said, softly.');
  assert.equal(R.normalizeText('It\u2019s "fine" \u2013 really'), "It's fine, really");
});

test('chunkText keeps every chunk within the limit and loses no words', () => {
  const paragraphs = [
    'Short intro.',
    'A longer paragraph that has several sentences. Each one adds some length. We keep going for a while.',
    'Ends here',
  ];
  const chunks = R.chunkText(paragraphs, 50);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 50), JSON.stringify(chunks));
  assert.equal(chunks.join(' ').split(/\s+/).join(' '), paragraphs.join(' '));
});

test('chunkText returns nothing for empty input', () => {
  assert.deepEqual(R.chunkText([]), []);
  assert.deepEqual(R.chunkText(['   ']), []);
});

// Builds a WAV the way pocket-tts does for a non-seekable stream: the RIFF and data
// sizes are placeholders for about one billion frames.
function streamingWav(sampleCount) {
  const data = Buffer.alloc(sampleCount * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(1_000_000_000 * 2, 40);
  return Buffer.concat([header, data]);
}

test('fixWavHeader rewrites placeholder sizes to the real length', () => {
  const wav = streamingWav(1000);
  const fixed = Buffer.from(R.fixWavHeader(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength)));
  assert.equal(fixed.length, wav.length);
  assert.equal(fixed.readUInt32LE(4), wav.length - 8);
  assert.equal(fixed.readUInt32LE(40), 2000);
  assert.equal(fixed.toString('ascii', 36, 40), 'data');
});

test('fixWavHeader leaves non-WAV data alone', () => {
  const junk = Buffer.from('not a wav file at all');
  const out = R.fixWavHeader(junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.byteLength));
  assert.equal(Buffer.from(out).toString(), 'not a wav file at all');
});

test('encodeWav writes a valid 16-bit mono header and clamped samples', () => {
  const buf = R.encodeWav([new Float32Array([0, 1, -1]), new Float32Array([0.5, 2])], 24000);
  const v = Buffer.from(buf);
  assert.equal(v.toString('ascii', 0, 4), 'RIFF');
  assert.equal(v.toString('ascii', 8, 12), 'WAVE');
  assert.equal(v.readUInt16LE(22), 1); // mono
  assert.equal(v.readUInt32LE(24), 24000); // sample rate
  assert.equal(v.readUInt16LE(34), 16); // bits per sample
  assert.equal(v.readUInt32LE(40), 5 * 2); // data bytes
  assert.equal(v.readUInt32LE(4), v.length - 8); // RIFF size
  assert.equal(v.readInt16LE(44), 0);
  assert.equal(v.readInt16LE(46), 32767);
  assert.equal(v.readInt16LE(48), -32768);
  assert.equal(v.readInt16LE(52), 32767); // 2 is clamped to 1
});

test('parseEpub reads the spine in order and skips missing items', async () => {
  const files = {
    'META-INF/container.xml': '<container><rootfile full-path="OEBPS/content.opf"/></container>',
    'OEBPS/content.opf': `<package><metadata><title>Book</title></metadata>
      <manifest><item id="cov" href="img/cover.png" media-type="image/png" properties="cover-image"/><item id="c1" href="text/one.xhtml"/><item id="c2" href="two.xhtml"/><item id="c3" href="gone.xhtml"/></manifest>
      <spine><itemref idref="c2"/><itemref idref="c1"/><itemref idref="c3"/></spine></package>`,
    'OEBPS/two.xhtml': 'SECOND',
    'OEBPS/text/one.xhtml': 'FIRST',
  };
  const readText = async (path) => {
    if (!(path in files)) throw new Error('missing ' + path);
    return files[path];
  };
  // Stand-in for DOMParser (only available in browsers): the whole document is one text node.
  class FakeDOMParser {
    parseFromString(xhtml) {
      return {
        getElementsByTagName: () => [],
        body: { childNodes: [{ nodeType: 3, nodeValue: xhtml }] },
      };
    }
  }
  const book = await R.parseEpub(readText, FakeDOMParser);
  assert.equal(book.title, 'Book');
  assert.deepEqual(book.paragraphs, ['SECOND', 'FIRST']);
  assert.deepEqual(book.chunks, ['SECOND FIRST']);
  assert.deepEqual(book.cover, { path: 'OEBPS/img/cover.png', mediaType: 'image/png' });
});

test('chunkText groups whole sentences up to a longer part length', () => {
  const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} ends here.`);
  const paragraphs = [sentences.join(' ')];
  const short = R.chunkText(paragraphs, R.PART_LENGTHS.short);
  const long = R.chunkText(paragraphs, R.PART_LENGTHS.long);
  assert.ok(long.length < short.length, `${long.length} parts vs ${short.length}`);
  assert.ok(long.every((c) => c.length <= R.PART_LENGTHS.long), JSON.stringify(long));
  // Every part starts and ends at a sentence boundary.
  assert.ok(long.every((c) => /^Sentence number \d+ ends here\.( Sentence number \d+ ends here\.)*$/.test(c)), JSON.stringify(long));
  assert.equal(long.join(' '), paragraphs[0]);
});
