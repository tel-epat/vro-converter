// Parser for DVD-VR VR_MANGR.IFO — the index that sits next to VR_MOVIE.VRO.
//
// It lists every recording ("program") with its byte range inside the VRO,
// recording date/time, start/end presentation time, video format and labels.
// All values are big-endian. Layout knowledge comes from studying the open
// DVD-VR format documentation in Pádraig Brady's dvd-vr tool; this is an
// independent implementation.

const SECTOR = 2048;
const MAGIC = 'DVD_RTR_VMG0';

// Sizes of fixed records (bytes)
const PGITI_SIZE = 8;        // u16 reserved, u8 pgi count, u8 vob-format count, u32 end address
const VOB_FORMAT_SIZE = 60;  // u16 video attr, u8 audio count, u8, 2× 3-byte audio attr, 50 bytes
const VVOB_SIZE = 21;        // u16 attr, 5-byte timestamp, u8, u8 format id, 2× (u32 ptm + u16 ext)
const ADJ_VOB_SIZE = 12;
const VOBU_MAP_SIZE = 10;    // u16 time-info count, u16 vobu count, u16 time offset, u32 start sector
const TIME_INFO_SIZE = 7;
const VOBU_INFO_SIZE = 3;    // u8, u16 size in sectors (low 10 bits)
const PSI_GI_SIZE = 4;       // u8, u8 set count, u16 program count
const PSI_SIZE = 142;        // u8, u8, u16 programs, 64 label, 64 title, u16 set id, u16 first program, 6

class Reader {
  constructor(buf) {
    this.buf = buf;
  }

  check(off, len, what) {
    if (!Number.isInteger(off) || off < 0 || off + len > this.buf.length) {
      throw new Error(`VR_MANGR.IFO is truncated or corrupt (reading ${what} at offset ${off})`);
    }
  }

  u8(off, what = 'u8') { this.check(off, 1, what); return this.buf.readUInt8(off); }
  u16(off, what = 'u16') { this.check(off, 2, what); return this.buf.readUInt16BE(off); }
  u32(off, what = 'u32') { this.check(off, 4, what); return this.buf.readUInt32BE(off); }

  text(off, len, encoding) {
    this.check(off, len, 'text');
    let raw = this.buf.subarray(off, off + len);
    const nul = raw.indexOf(0);
    if (nul >= 0) raw = raw.subarray(0, nul);
    // latin1 is a lossless byte→char mapping; ISO-8859-1 discs decode exactly, ASCII too.
    const str = encoding === 'shift_jis' ? decodeShiftJis(raw) : raw.toString('latin1');
    return str.replace(/[\x00-\x1f\x7f]/g, '').trim();
  }
}

function decodeShiftJis(bytes) {
  try {
    return new TextDecoder('shift_jis').decode(bytes);
  } catch {
    return Buffer.from(bytes).toString('latin1');
  }
}

const TEXT_ENCODINGS = { 0x00: 'ascii', 0x01: 'ascii', 0x11: 'latin1', 0x12: 'shift_jis' };

/** 40-bit packed date: year(14) month(4) day(5) hour(5) min(6) sec(6). Local time, no zone. */
function decodeTimestamp(b) {
  const year = ((b[0] << 8) | b[1]) >> 2;
  if (!year) return null;
  const month = ((b[1] & 0x03) << 2) | (b[2] >> 6);
  const day = (b[2] & 0x3e) >> 1;
  const hour = ((b[2] & 0x01) << 4) | (b[3] >> 4);
  const minute = ((b[3] & 0x0f) << 2) | (b[4] >> 6);
  const second = b[4] & 0x3f;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const p = (n) => String(n).padStart(2, '0');
  return {
    year, month, day, hour, minute, second,
    // ISO-like local time string, no timezone: what the camcorder clock said.
    text: `${year}-${p(month)}-${p(day)} ${p(hour)}:${p(minute)}:${p(second)}`,
  };
}

function decodeVideoAttr(attr) {
  const tvSystem = (attr & 0x3000) >> 12;
  const res = (attr & 0x0038) >> 3;
  const aspect = (attr & 0x0c00) >> 10;
  const compression = (attr & 0xc000) >> 14;
  let height = { 0: 480, 1: 576 }[tvSystem] ?? null;
  const width = { 0: 720, 1: 704, 2: 352, 3: 352, 4: 544, 5: 480 }[res] ?? null;
  if (res === 3 && height) height /= 2;
  return {
    tvSystem: { 0: 'NTSC', 1: 'PAL' }[tvSystem] ?? null,
    width,
    height,
    aspect: { 0: '4:3', 1: '16:9' }[aspect] ?? null,
    codec: { 0: 'mpeg1', 1: 'mpeg2' }[compression] ?? null,
  };
}

function decodeAudioAttr(bytes) {
  const coding = (bytes[0] & 0xe0) >> 5;
  const ch = bytes[1] & 0x0f;
  return {
    codec: { 0: 'ac3', 2: 'mpeg1', 3: 'mpeg2ext', 4: 'lpcm' }[coding] ?? null,
    channels: ch < 8 ? ch + 1 : ch === 9 ? 2 : null,
  };
}

/**
 * Parse a VR_MANGR.IFO buffer.
 * Returns { version, cprm, discInfo, formats[], programs[] } where each program has
 * { number, offset, size, recorded, startPts, endPts, duration, format, label, title, programSet }.
 * offset/size are byte positions inside VR_MOVIE.VRO.
 */
export function parseIfo(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const r = new Reader(buf);
  r.check(0, 512, 'header');
  if (buf.toString('latin1', 0, 12) !== MAGIC) {
    throw new Error('Not a DVD-VR index: VR_MANGR.IFO should start with "DVD_RTR_VMG0"');
  }

  const versionByte = r.u16(32) & 0xff;
  const encoding = TEXT_ENCODINGS[r.u8(67)] ?? 'latin1';
  const discInfo = [...new Set([r.text(98, 64, encoding), r.text(162, 64, encoding)])]
    .filter((s) => s && !['DVD VR', 'DVD-VR'].includes(s));
  const cprm = r.u8(267) !== 0;

  // ---- Program information table ----
  const pgit = r.u32(256, 'program table address');
  const pgiCount = r.u8(pgit + 2, 'program table count');
  const formatCount = r.u8(pgit + 3, 'format count');
  if (pgiCount === 0) throw new Error('VR_MANGR.IFO lists no recordings');

  const formats = [];
  let off = pgit + PGITI_SIZE;
  for (let i = 0; i < formatCount; i++, off += VOB_FORMAT_SIZE) {
    r.check(off, VOB_FORMAT_SIZE, 'video format');
    formats.push({
      video: decodeVideoAttr(r.u16(off)),
      audioStreams: r.u8(off + 2),
      audio: decodeAudioAttr(buf.subarray(off + 4, off + 7)),
    });
  }

  const programCount = r.u16(off, 'program count');
  const addrTable = off + 2;

  // ---- Default program sets: labels / titles ----
  const sets = [];
  const psiAddr = r.u32(304, 'program set address');
  if (psiAddr) {
    const setCount = r.u8(psiAddr + 1, 'program set count');
    let first = 1;
    for (let s = 0; s < setCount; s++) {
      const p = psiAddr + PSI_GI_SIZE + s * PSI_SIZE;
      r.check(p, PSI_SIZE, 'program set');
      const n = r.u16(p + 2);
      const label = r.text(p + 4, 64, 'latin1');
      const title = r.text(p + 68, 64, encoding);
      sets.push({ number: s + 1, first, last: first + n - 1, label, title });
      first += n;
    }
  }

  const programs = [];
  for (let i = 0; i < programCount; i++) {
    const v = pgit + r.u32(addrTable + i * 4, 'program address');
    r.check(v, VVOB_SIZE, 'program');
    const attr = r.u16(v);
    const recorded = decodeTimestamp(buf.subarray(v + 2, v + 7));
    const formatId = r.u8(v + 8);
    const startPts = r.u32(v + 9);
    const endPts = r.u32(v + 15);

    let m = v + VVOB_SIZE + 2 + (attr & 0x80 ? ADJ_VOB_SIZE : 0);
    r.check(m, VOBU_MAP_SIZE, 'VOBU map');
    const timeInfos = r.u16(m);
    const vobus = r.u16(m + 2);
    const startSector = r.u32(m + 6);
    let sectors = 0;
    let vi = m + VOBU_MAP_SIZE + timeInfos * TIME_INFO_SIZE;
    r.check(vi, vobus * VOBU_INFO_SIZE, 'VOBU sizes');
    for (let k = 0; k < vobus; k++, vi += VOBU_INFO_SIZE) {
      sectors += r.u16(vi + 1) & 0x03ff;
    }

    const set = sets.find((s) => i + 1 >= s.first && i + 1 <= s.last) ?? null;
    const duration = endPts > startPts ? (endPts - startPts) / 90000 : null;
    programs.push({
      number: i + 1,
      offset: startSector * SECTOR,
      size: sectors * SECTOR,
      vobus,
      recorded,
      startPts,
      endPts,
      duration,
      format: formats[formatId - 1] ?? formats[0] ?? null,
      label: set?.label || null,
      title: set?.title && set.title !== set.label ? set.title : null,
      programSet: set?.number ?? null,
    });
  }

  return {
    version: `${versionByte >> 4}.${versionByte & 0x0f}`,
    cprm,
    textEncoding: encoding,
    discInfo,
    formats,
    programSets: sets,
    programs,
  };
}

/** Camcorder wall-clock time as a JS Date in this machine's time zone (the IFO stores no zone). */
export function recordingDate(program) {
  const t = program.recorded;
  if (!t) return null;
  return new Date(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
}

/**
 * Parse a selection like "1,3,5-8" into a Set of program numbers.
 * Throws on malformed input or numbers outside 1..max.
 */
export function parseSelection(spec, max) {
  const picked = new Set();
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Bad recording selection "${part}" (use e.g. 1,3,5-8)`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > max || a > b) throw new Error(`Recording selection "${part}" is outside 1-${max}`);
    for (let n = a; n <= b; n++) picked.add(n);
  }
  if (picked.size === 0) throw new Error('Empty recording selection');
  return picked;
}

/**
 * Check an index against the VRO it supposedly describes. Returns null if fine,
 * otherwise a human-readable reason. Catches an IFO from a different disc.
 */
export function checkAgainstVro(ifo, vroSize) {
  const end = Math.max(0, ...ifo.programs.map((p) => p.offset + p.size));
  if (end > vroSize) {
    const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;
    return `VR_MANGR.IFO doesn't match this VRO: the index describes ${gb(end)} of video but the file is ${gb(vroSize)}. `
      + 'Use the IFO from the same disc (same DVD_RTAV folder).';
  }
  const empty = ifo.programs.filter((p) => p.size === 0);
  if (empty.length === ifo.programs.length) return 'VR_MANGR.IFO lists no video data';
  return null;
}

/** File-system-safe output name for one recording, sortable by recording number. */
export function recordingFileName(program, ext, total = 999) {
  const width = Math.max(3, String(total).length);
  const parts = [String(program.number).padStart(width, '0')];
  const label = program.title || program.label;
  if (label) parts.push(label.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().slice(0, 60));
  if (program.recorded) parts.push(program.recorded.text.replace(/:/g, '-'));
  return `${parts.filter(Boolean).join(' ')}.${ext}`;
}

/**
 * Turn a parsed index into convertible recordings: byte range, aspect, date, file name.
 * `selection` is an optional Set of program numbers.
 */
export function planRecordings(ifo, { ext, selection = null } = {}) {
  const total = ifo.programs.length;
  return ifo.programs
    .filter((p) => p.size > 0 && (!selection || selection.has(p.number)))
    .map((p) => ({
      number: p.number,
      range: { offset: p.offset, size: p.size },
      aspect: p.format?.video?.aspect ?? null,
      recorded: p.recorded?.text ?? null,
      recordedAt: recordingDate(p),
      duration: p.duration,
      label: p.title || p.label || null,
      fileName: recordingFileName(p, ext, total),
    }));
}

/** The aspect ratio to force for the whole VRO, if every recording agrees. */
export function commonAspect(ifo) {
  const aspects = new Set(ifo.programs.map((p) => p.format?.video?.aspect).filter(Boolean));
  return aspects.size === 1 ? [...aspects][0] : null;
}

/** Find VR_MANGR.IFO next to a VRO, case-insensitively. Returns its path or null. */
export async function findIfoFor(vroPath) {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const dir = path.dirname(vroPath);
  const entries = await fs.readdir(dir).catch(() => []);
  const hit = entries.find((e) => e.toUpperCase() === 'VR_MANGR.IFO');
  return hit ? path.join(dir, hit) : null;
}
