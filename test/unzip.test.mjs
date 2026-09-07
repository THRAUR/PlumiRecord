/**
 * The zip reader, checked against archives built here rather than fixtures.
 *
 * These are the cases that decide whether somebody's design bundle unpacks at all,
 * and the two that are easy to get wrong — a name that is not ASCII, and a name
 * that is trying to escape the directory — are the reason this is not trusted to
 * a five-line implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { listEntries, safeName, unzip } from '../src/unzip.mjs';

/** A minimal but real zip, so the tests do not depend on a zip program being installed. */
function makeZip(files, { store = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.from(text);
    const data = store ? body : deflateRawSync(body);
    const crc = crc32(body);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);            // names are UTF-8
    lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(body.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const scratch = () => mkdtemp(path.join(tmpdir(), 'plumirecord-test-'));

test('reads a deflated archive back byte for byte', async () => {
  const dir = await scratch();
  const zip = makeZip({ 'a/index.html': '<h1>hi</h1>', 'a/style.css': 'body{color:red}' });
  const written = await unzip(zip, dir);
  assert.deepEqual(written.sort(), ['a/index.html', 'a/style.css']);
  assert.equal(await readFile(path.join(dir, 'a', 'index.html'), 'utf8'), '<h1>hi</h1>');
  await rm(dir, { recursive: true, force: true });
});

test('reads a stored (uncompressed) archive', async () => {
  const dir = await scratch();
  await unzip(makeZip({ 'x.html': 'plain' }, { store: true }), dir);
  assert.equal(await readFile(path.join(dir, 'x.html'), 'utf8'), 'plain');
  await rm(dir, { recursive: true, force: true });
});

test('keeps non-ASCII names intact', async () => {
  const dir = await scratch();
  await unzip(makeZip({ '簡報/第一頁.html': '<b>中文</b>' }), dir);
  assert.equal(await readFile(path.join(dir, '簡報', '第一頁.html'), 'utf8'), '<b>中文</b>');
  await rm(dir, { recursive: true, force: true });
});

test('a name cannot escape the directory it is unpacked into', () => {
  assert.equal(safeName('../../../etc/passwd'), 'etc/passwd');
  assert.equal(safeName('/absolute/x'), 'absolute/x');
  assert.equal(safeName('C:\\Windows\\System32\\x.dll'), 'Windows/System32/x.dll');
  assert.equal(safeName('a/../../b'), 'a/b');
  assert.equal(safeName('..'), null);
  assert.equal(safeName('/'), null);
});

test('skip() keeps the Mac resource-fork tree out', async () => {
  const dir = await scratch();
  const zip = makeZip({ 'slide.html': 'x', '__MACOSX/._slide.html': 'junk' });
  const written = await unzip(zip, dir, { skip: rel => rel.startsWith('__MACOSX/') });
  assert.deepEqual(written, ['slide.html']);
  await rm(dir, { recursive: true, force: true });
});

test('says so plainly when the bytes are not a zip', async () => {
  await assert.rejects(() => unzip(Buffer.from('not a zip at all'), '/tmp'), /not a zip file/);
});

test('the entry list survives a stray signature in the data', () => {
  /* "PK\x05\x06" is four ordinary bytes and can occur inside compressed data. The
     record that is really the end is the one whose comment length reaches the end
     of the file, which is what stops the backward scan stopping early. */
  const zip = makeZip({ 'a.html': 'PK\x05\x06' + 'x'.repeat(400) }, { store: true });
  assert.deepEqual(listEntries(zip).map(e => e.name), ['a.html']);
});
