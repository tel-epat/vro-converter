// Minimal streaming ZIP writer (store only — video is already compressed).
// Sizes and CRCs are known up front, so the exact archive length is known before
// streaming (proper download progress) and no data descriptors are needed.
// ZIP64 records are added only when an entry or offset exceeds 4 GB, which keeps
// ordinary archives maximally compatible (e.g. macOS Archive Utility).

import { createReadStream } from 'node:fs';
import zlib from 'node:zlib';

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32Update(crc, buf) {
  if (zlib.crc32) return zlib.crc32(buf, crc);
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** CRC-32 of a file, streamed. */
export async function crc32File(file) {
  let crc = 0;
  for await (const chunk of createReadStream(file)) crc = crc32Update(crc, chunk);
  return crc >>> 0;
}

export function crc32(buf) {
  return crc32Update(0, buf) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) && date.getFullYear() >= 1980 ? date : new Date(1980, 0, 1);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/**
 * Lay out the archive. entries: [{ name, path, size, crc, mtime }]
 * Returns { size, parts } where parts is an ordered list of Buffers and { path } file refs.
 */
export function layoutZip(entries, { forceZip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime);
    const big = forceZip64 || e.size >= MAX32;
    const far = forceZip64 || offset >= MAX32;

    const localExtra = big ? Buffer.concat([Buffer.from([1, 0, 16, 0]), u64(e.size), u64(e.size)]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(big ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 file names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(e.crc >>> 0, 14);
    local.writeUInt32LE(big ? MAX32 : e.size, 18);
    local.writeUInt32LE(big ? MAX32 : e.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, name, localExtra, { path: e.path, size: e.size });

    const cdFields = [];
    if (big) cdFields.push(u64(e.size), u64(e.size));
    if (far) cdFields.push(u64(offset));
    const cdExtraBody = Buffer.concat(cdFields);
    const cdExtra = cdExtraBody.length
      ? Buffer.concat([Buffer.from([1, 0, cdExtraBody.length, 0]), cdExtraBody])
      : Buffer.alloc(0);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, spec 4.5
    cd.writeUInt16LE(big || far ? 45 : 20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(e.crc >>> 0, 16);
    cd.writeUInt32LE(big ? MAX32 : e.size, 20);
    cd.writeUInt32LE(big ? MAX32 : e.size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(cdExtra.length, 30);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    cd.writeUInt32LE(far ? MAX32 : offset, 42);
    central.push(cd, name, cdExtra);

    offset += local.length + name.length + localExtra.length + e.size;
  }

  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  const cdSize = cdBuf.length;
  parts.push(cdBuf);
  offset += cdSize;

  const needZip64 = forceZip64 || entries.length >= MAX16 || cdOffset >= MAX32 || cdSize >= MAX32;
  if (needZip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE((3 << 8) | 45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(rec, loc);
    offset += rec.length + loc.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(needZip64 ? MAX16 : entries.length, 8);
  end.writeUInt16LE(needZip64 ? MAX16 : entries.length, 10);
  end.writeUInt32LE(needZip64 ? MAX32 : cdSize, 12);
  end.writeUInt32LE(needZip64 ? MAX32 : cdOffset, 16);
  parts.push(end);
  offset += end.length;

  return { size: offset, parts };
}

/** Stream a laid-out archive into a writable (e.g. an HTTP response). */
export async function writeZip(layout, out) {
  for (const part of layout.parts) {
    if (out.destroyed) return;
    if (Buffer.isBuffer(part)) {
      if (!out.write(part)) await waitDrain(out);
    } else {
      for await (const chunk of createReadStream(part.path)) {
        if (out.destroyed) return;
        if (!out.write(chunk)) await waitDrain(out);
      }
    }
  }
  out.end();
}

function waitDrain(out) {
  return new Promise((resolve) => {
    const done = () => { out.off('drain', done); out.off('close', done); resolve(); };
    out.on('drain', done);
    out.on('close', done);
  });
}
