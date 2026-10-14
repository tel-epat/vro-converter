import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseIfo, checkAgainstVro, parseSelection, recordingFileName, planRecordings, commonAspect, recordingDate,
} from '../src/ifo.js';
import { buildIfo } from './ifo-writer.js';

const when = (day, hour, minute, second = 0) => ({ year: 2017, month: 12, day, hour, minute, second });

const sample = () => buildIfo([
  { sector: 0, sectors: 1500, recorded: when(11, 22, 46, 1), seconds: 90.2 },
  { sector: 1500, sectors: 300, recorded: when(11, 22, 52, 9), seconds: 20 },
  { sector: 1800, sectors: 2500, recorded: when(13, 0, 56, 5), seconds: 150.5 },
], { aspect: '16:9', tv: 'PAL' });

test('parses recordings: byte ranges, dates, durations, format', () => {
  const ifo = parseIfo(sample());
  assert.equal(ifo.version, '1.0');
  assert.equal(ifo.cprm, false);
  assert.equal(ifo.programs.length, 3);
  assert.deepEqual(ifo.formats[0].video, { tvSystem: 'PAL', width: 720, height: 576, aspect: '16:9', codec: 'mpeg2' });
  assert.deepEqual(ifo.formats[0].audio, { codec: 'ac3', channels: 2 });

  const [a, b, c] = ifo.programs;
  assert.equal(a.offset, 0);
  assert.equal(a.size, 1500 * 2048);
  assert.equal(b.offset, 1500 * 2048);
  assert.equal(c.size, 2500 * 2048, 'VOBU sizes are summed across many entries');
  assert.equal(a.recorded.text, '2017-12-11 22:46:01');
  assert.equal(c.recorded.text, '2017-12-13 00:56:05');
  assert.ok(Math.abs(a.duration - 90.2) < 0.001);
});

test('NTSC and 4:3 are decoded', () => {
  const ifo = parseIfo(buildIfo([{ sector: 0, sectors: 10 }], { aspect: '4:3', tv: 'NTSC' }));
  assert.equal(ifo.formats[0].video.aspect, '4:3');
  assert.equal(ifo.formats[0].video.height, 480);
  assert.equal(ifo.programs[0].recorded, null, 'missing date is null, not garbage');
});

test('rejects files that are not a DVD-VR index', () => {
  assert.throws(() => parseIfo(Buffer.alloc(600)), /DVD_RTR_VMG0/);
  assert.throws(() => parseIfo(Buffer.from('short')), /truncated or corrupt/);
  const truncated = sample().subarray(0, 700);
  assert.throws(() => parseIfo(truncated), /truncated or corrupt/);
});

test('flags an index that belongs to a different (bigger) VRO', () => {
  const ifo = parseIfo(sample());
  assert.equal(checkAgainstVro(ifo, 4300 * 2048), null);
  assert.match(checkAgainstVro(ifo, 1000 * 2048), /doesn't match this VRO/);
});

test('recording selection syntax', () => {
  assert.deepEqual([...parseSelection('1,3,5-7', 10)], [1, 3, 5, 6, 7]);
  assert.throws(() => parseSelection('0', 10), /outside/);
  assert.throws(() => parseSelection('9-12', 10), /outside/);
  assert.throws(() => parseSelection('a', 10), /Bad/);
});

test('planning: names sort by number and carry the date; aspect and Date come along', () => {
  const ifo = parseIfo(sample());
  const plan = planRecordings(ifo, { ext: 'mp4' });
  assert.deepEqual(plan.map((r) => r.fileName), [
    '001 2017-12-11 22-46-01.mp4',
    '002 2017-12-11 22-52-09.mp4',
    '003 2017-12-13 00-56-05.mp4',
  ]);
  assert.equal(plan[0].aspect, '16:9');
  assert.deepEqual(plan[2].range, { offset: 1800 * 2048, size: 2500 * 2048 });
  assert.equal(plan[0].recordedAt.getFullYear(), 2017);
  assert.equal(plan[0].recordedAt.getHours(), 22, 'camcorder wall-clock time is kept as local time');
  assert.equal(planRecordings(ifo, { ext: 'mp4', selection: new Set([2]) }).length, 1);
  assert.equal(commonAspect(ifo), '16:9');
});

test('labels end up in file names, made file-system safe', () => {
  const name = recordingFileName({ number: 4, label: 'Trip: day 1/2', recorded: null }, 'mkv', 47);
  assert.equal(name, '004 Trip- day 1-2.mkv');
  assert.equal(recordingDate({ recorded: null }), null);
});

// Real VR_MANGR.IFO files dropped into test/fixtures are checked for basic sanity.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const real = (await fs.readdir(fixtures).catch(() => [])).filter((f) => /\.ifo$/i.test(f));
for (const file of real) {
  test(`real index ${file}: recordings are ordered, non-overlapping and plausible`, async () => {
    const ifo = parseIfo(await fs.readFile(path.join(fixtures, file)));
    assert.ok(ifo.programs.length > 0);
    const byOffset = [...ifo.programs].sort((x, y) => x.offset - y.offset);
    for (let i = 1; i < byOffset.length; i++) {
      assert.ok(byOffset[i].offset >= byOffset[i - 1].offset + byOffset[i - 1].size, 'recordings overlap');
    }
    for (const p of ifo.programs) {
      assert.equal(p.offset % 2048, 0);
      assert.ok(p.size > 0);
      if (p.duration) {
        const mbit = (p.size * 8) / p.duration / 1e6;
        assert.ok(mbit > 1 && mbit < 15, `#${p.number}: ${mbit.toFixed(1)} Mbit/s is not DVD-like`);
      }
      if (p.recorded) assert.ok(p.recorded.year > 1995 && p.recorded.year < 2040);
    }
  });
}
