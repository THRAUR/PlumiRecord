/**
 * Just enough of the ZIP format to unpack a design handoff, with no dependencies.
 *
 * The obvious implementation is to shell out to `unzip`, which is what this did
 * while it only ever ran on one Linux box. Windows has no such program and a Mac's
 * is not guaranteed either, so the format is read directly — it is a few hundred
 * lines and it removes the last thing standing between this tool and a laptop.
 *
 * Only the two compression methods that exist in practice are supported: stored and
 * deflate. Anything else names itself in the error rather than producing a file that
 * is quietly wrong.
 */
import { inflateRawSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CDH_SIG = 0x02014b50;

/**
 * Where the central directory says it is.
 *
 * The end-of-central-directory record is last in the file but variable in length,
 * because a zip may carry a comment after it. So it is found by scanning backwards
 * for the signature — and only through the last 64KB or so, since that is the
 * longest a comment is allowed to be.
 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    /* The signature is four ordinary bytes and can legitimately occur inside
       compressed data. The record that is really the last one is the one whose
       declared comment length reaches exactly the end of the file. */
    if (i + 22 + commentLen !== buf.length) continue;
    return {
      entries: buf.readUInt16LE(i + 10),
      size: buf.readUInt32LE(i + 12),
      offset: buf.readUInt32LE(i + 16),
      at: i,
    };
  }
  throw new Error('not a zip file (no end-of-central-directory record)');
}

/**
 * The 64-bit record, when the 32-bit one has run out of room.
 *
 * A zip past 4GB or 65535 entries stores -1 in the classic fields and puts the real
 * numbers in a second record before them. Design bundles are nowhere near either
 * limit, but a file that silently unpacks as empty is a much worse failure than a
 * hundred lines of parsing, and the check is what makes "empty" impossible.
 */
function widen(buf, eocd) {
  const maxed = eocd.offset === 0xffffffff || eocd.size === 0xffffffff || eocd.entries === 0xffff;
  if (!maxed) return eocd;
  const locAt = eocd.at - 20;
  if (locAt < 0 || buf.readUInt32LE(locAt) !== EOCD64_LOC_SIG) return eocd;
  const at = Number(buf.readBigUInt64LE(locAt + 8));
  if (at < 0 || at + 56 > buf.length || buf.readUInt32LE(at) !== EOCD64_SIG) return eocd;
  return {
    entries: Number(buf.readBigUInt64LE(at + 32)),
    size: Number(buf.readBigUInt64LE(at + 40)),
    offset: Number(buf.readBigUInt64LE(at + 48)),
    at,
  };
}

/* The same three numbers again, this time per entry: a ZIP64 entry stores -1 in the
   header and the truth in an extra field, in the order of whichever ones were maxed. */
function zip64Extra(extra, entry) {
  for (let i = 0; i + 4 <= extra.length;) {
    const id = extra.readUInt16LE(i), len = extra.readUInt16LE(i + 2);
    const body = extra.subarray(i + 4, i + 4 + len);
    i += 4 + len;
    if (id !== 0x0001) continue;
    let o = 0;
    const next = () => { const v = Number(body.readBigUInt64LE(o)); o += 8; return v; };
    if (entry.size === 0xffffffff && o + 8 <= body.length) entry.size = next();
    if (entry.compressed === 0xffffffff && o + 8 <= body.length) entry.compressed = next();
    if (entry.offset === 0xffffffff && o + 8 <= body.length) entry.offset = next();
  }
  return entry;
}

/** Every file in the archive, as {name, offset, compressed, size, method}. */
export function listEntries(buf) {
  const eocd = widen(buf, findEocd(buf));
  const out = [];
  let p = eocd.offset;
  for (let i = 0; i < eocd.entries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const flags = buf.readUInt16LE(p + 8);
    const entry = zip64Extra(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), {
      /* Bit 11 promises the name is UTF-8. Without it the spec says CP437, but every
         tool that matters has written UTF-8 for twenty years, and reading a Chinese
         file name as CP437 mangles it beyond recovery. */
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      compressed: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
      utf8: Boolean(flags & 0x800),
    });
    out.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The bytes of one entry, decompressed. */
function readEntry(buf, e) {
  /* The local header repeats the name and extra field at different lengths from the
     central one, so the data offset can only be computed from the local header. */
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`corrupt entry: ${e.name}`);
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressed);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`${e.name}: unsupported compression method ${e.method}`);
}

/**
 * A path from inside an archive, made safe to join onto a directory.
 *
 * An entry name is attacker-controlled text, and the classic attack is to put
 * `../../.ssh/authorized_keys` in it and have the extractor write there. Absolute
 * paths, drive letters and traversal segments are all removed rather than rejected,
 * so a bundle with one odd name still unpacks instead of failing whole.
 */
export function safeName(name) {
  const parts = name.replace(/\\/g, '/').split('/')
    .filter(s => s && s !== '.' && s !== '..')
    .map(s => s.replace(/^[a-zA-Z]:/, '').replace(/[\x00-\x1f]/g, ''))
    .filter(Boolean);
  return parts.length ? parts.join('/') : null;
}

/**
 * Unpack `buf` into `dir`. Returns the relative paths written.
 *
 * Directory entries are not created for their own sake — an empty directory in a
 * design bundle carries nothing — so only the parents of real files appear.
 */
export async function unzip(buf, dir, { skip = () => false } = {}) {
  const written = [];
  for (const e of listEntries(buf)) {
    if (e.name.endsWith('/')) continue;
    const rel = safeName(e.name);
    if (!rel || skip(rel)) continue;
    const target = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, readEntry(buf, e));
    written.push(rel);
  }
  if (!written.length) throw new Error('that zip is empty');
  return written;
}
