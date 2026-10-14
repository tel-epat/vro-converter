// Test-only: writes a minimal but structurally valid VR_MANGR.IFO for given recordings.
// Mirrors the layout read by src/ifo.js, so tests can build discs of any shape.

const SECTOR = 2048;

function encodeTimestamp(d) {
  if (!d) return Buffer.alloc(5);
  const { year, month, day, hour, minute, second } = d;
  const b = Buffer.alloc(5);
  b[0] = (year >> 6) & 0xff;
  b[1] = ((year & 0x3f) << 2) | ((month >> 2) & 0x03);
  b[2] = ((month & 0x03) << 6) | ((day & 0x1f) << 1) | ((hour >> 4) & 0x01);
  b[3] = ((hour & 0x0f) << 4) | ((minute >> 2) & 0x0f);
  b[4] = ((minute & 0x03) << 6) | (second & 0x3f);
  return b;
}

/**
 * programs: [{ sector, sectors, recorded?: {year,...}, seconds? }]
 * options: { aspect: '4:3'|'16:9', tv: 'PAL'|'NTSC', label, cprm }
 */
export function buildIfo(programs, { aspect = '16:9', tv = 'PAL', label = '', cprm = false, discInfo = 'DVD VR' } = {}) {
  const chunks = [];
  const header = Buffer.alloc(512);
  header.write('DVD_RTR_VMG0', 0, 'latin1');
  header.writeUInt16BE(0x0010, 32); // version 1.0
  header[67] = 0x11; // ISO-8859-1
  header.write(discInfo, 98, 'latin1');
  header.write(discInfo, 162, 'latin1');
  header[267] = cprm ? 1 : 0;
  chunks.push(header);

  const pgit = 512;
  const pgiti = Buffer.alloc(8);
  pgiti[2] = 1; // one program info table
  pgiti[3] = 1; // one video format
  chunks.push(pgiti);

  const fmt = Buffer.alloc(60);
  const videoAttr = (1 << 14) | ((tv === 'PAL' ? 1 : 0) << 12) | ((aspect === '16:9' ? 1 : 0) << 10);
  fmt.writeUInt16BE(videoAttr, 0);
  fmt[2] = 1; // audio streams
  fmt[4] = 0 << 5; // AC3
  fmt[5] = 1; // 2 channels
  chunks.push(fmt);

  const count = Buffer.alloc(2);
  count.writeUInt16BE(programs.length);
  chunks.push(count);

  const tableAt = pgit + 8 + 60 + 2;
  let cursor = tableAt + programs.length * 4;
  const table = Buffer.alloc(programs.length * 4);
  const records = [];
  programs.forEach((p, i) => {
    table.writeUInt32BE(cursor - pgit, i * 4);
    const vobuSizes = [];
    for (let left = p.sectors; left > 0; left -= Math.min(left, 1000)) vobuSizes.push(Math.min(left, 1000));
    const rec = Buffer.alloc(21 + 2 + 10 + vobuSizes.length * 3);
    encodeTimestamp(p.recorded).copy(rec, 2);
    rec[8] = 1; // format id
    const start = 0x1000;
    rec.writeUInt32BE(start, 9);
    rec.writeUInt32BE(start + Math.round((p.seconds ?? 0) * 90000), 15);
    rec.writeUInt16BE(0, 23); // time infos
    rec.writeUInt16BE(vobuSizes.length, 25);
    rec.writeUInt32BE(p.sector, 29);
    vobuSizes.forEach((s, k) => rec.writeUInt16BE(s, 33 + k * 3 + 1));
    records.push(rec);
    cursor += rec.length;
  });
  chunks.push(table, ...records);

  const psiAt = cursor;
  const psi = Buffer.alloc(4 + 142);
  psi[1] = 1;
  psi.writeUInt16BE(programs.length, 2);
  psi.writeUInt16BE(programs.length, 4 + 2);
  psi.write(label, 4 + 4, 'latin1');
  psi.write(label, 4 + 68, 'latin1');
  chunks.push(psi);

  const buf = Buffer.concat(chunks);
  buf.writeUInt32BE(buf.length - 1, 12);
  buf.writeUInt32BE(pgit, 256);
  buf.writeUInt32BE(psiAt, 304);
  return buf;
}

export { SECTOR };
