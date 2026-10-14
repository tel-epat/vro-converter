import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, probeStreams } from './helpers.js';
import { buildIfo } from './ifo-writer.js';
import { createApp } from '../src/server.js';

const exec = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const cli = (args) => exec('node', [CLI, ...args]).then(
  (r) => ({ code: 0, ...r }),
  (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
);

const RECORDINGS = [
  { seconds: 2, recorded: { year: 2017, month: 12, day: 11, hour: 22, minute: 46, second: 1 } },
  { seconds: 3, recorded: { year: 2017, month: 12, day: 12, hour: 20, minute: 41, second: 0 } },
  { seconds: 1, recorded: { year: 2017, month: 12, day: 13, hour: 0, minute: 56, second: 5 } },
];

let dir;
let disc; // folder holding DVD_RTAV/VR_MOVIE.VRO + VR_MANGR.IFO
let vro;
let ifoBuf;

/**
 * A fake camcorder disc: three recordings back to back, each with its clock starting
 * at zero, and — like real camcorders — the MPEG stream says 4:3 while the index says 16:9.
 */
before(async () => {
  dir = await tempDir();
  disc = path.join(dir, 'disc');
  const rtav = path.join(disc, 'DVD_RTAV');
  await fs.mkdir(rtav, { recursive: true });
  const blobs = [];
  for (const [i, r] of RECORDINGS.entries()) {
    const f = path.join(dir, `rec${i}.vob`);
    await exec('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=720x576:rate=25:duration=${r.seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=${300 * (i + 1)}:sample_rate=48000:duration=${r.seconds}`,
      '-c:v', 'mpeg2video', '-b:v', '4M', '-flags', '+ilme+ildct', '-top', '1', '-aspect', '4:3',
      '-c:a', 'ac3', '-b:a', '192k', '-f', 'vob', f,
    ]);
    const buf = await fs.readFile(f);
    assert.equal(buf.length % 2048, 0, 'VOB muxer writes whole sectors');
    blobs.push(buf);
  }
  let sector = 0;
  const programs = RECORDINGS.map((r, i) => {
    const p = { sector, sectors: blobs[i].length / 2048, recorded: r.recorded, seconds: r.seconds };
    sector += p.sectors;
    return p;
  });
  vro = path.join(rtav, 'VR_MOVIE.VRO');
  await fs.writeFile(vro, Buffer.concat(blobs));
  ifoBuf = buildIfo(programs, { aspect: '16:9' });
  await fs.writeFile(path.join(rtav, 'VR_MANGR.IFO'), ifoBuf);
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const expectedNames = [
  '001 2017-12-11 22-46-01.mp4',
  '002 2017-12-12 20-41-00.mp4',
  '003 2017-12-13 00-56-05.mp4',
];

test('CLI --list shows the recordings from the index', async () => {
  const r = await cli([vro, '--list']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /3 recordings/);
  assert.match(r.stdout, /PAL 720×576 16:9 AC3/);
  assert.match(r.stdout, /2017-12-13 00:56:05/);
});

test('CLI splits a disc folder into one file per recording, with fixed aspect and dates', async () => {
  const out = path.join(dir, 'out');
  const r = await cli([disc, '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual((await fs.readdir(out)).sort(), expectedNames);

  for (const [i, name] of expectedNames.entries()) {
    const file = path.join(out, name);
    const meta = await probeStreams(file);
    const v = meta.streams.find((s) => s.codec_type === 'video');
    assert.equal(v.codec_name, 'h264');
    assert.equal(v.display_aspect_ratio, '16:9', 'aspect comes from the index, not the 4:3 stream flag');
    assert.ok(Math.abs(Number(meta.format.duration) - RECORDINGS[i].seconds) < 0.3,
      `${name}: duration ${meta.format.duration} vs ${RECORDINGS[i].seconds}`);
    const { year, month, day, hour, minute, second } = RECORDINGS[i].recorded;
    const expected = new Date(year, month - 1, day, hour, minute, second);
    assert.equal(new Date(meta.format.tags.creation_time).getTime(), expected.getTime(), 'creation_time metadata');
    assert.equal(Math.round((await fs.stat(file)).mtimeMs / 1000), expected.getTime() / 1000, 'file date');
  }
  const hidden = (await fs.readdir(out)).filter((f) => f.includes('.partial'));
  assert.deepEqual(hidden, [], 'no leftover partial files');

  // Re-running resumes: finished recordings are skipped, nothing fails.
  const again = await cli([disc, '-o', out]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /3 already converted, skipped/);
});

test('CLI --recordings picks a subset; default output folder is named after the VRO', async () => {
  const r = await cli([vro, '-r', '2', '-f', 'mkv']);
  assert.equal(r.code, 0, r.stderr);
  const folder = path.join(path.dirname(vro), 'VR_MOVIE');
  assert.deepEqual(await fs.readdir(folder), ['002 2017-12-12 20-41-00.mkv']);
  await fs.rm(folder, { recursive: true });
});

test('CLI --join makes one file but still applies the aspect from the index', async () => {
  const out = path.join(dir, 'joined.mp4');
  const r = await cli([vro, '--join', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  const meta = await probeStreams(out);
  assert.ok(Number(meta.format.duration) > 5.5, `all recordings kept: ${meta.format.duration}s`);
  assert.equal(meta.streams.find((s) => s.codec_type === 'video').display_aspect_ratio, '16:9');
});

test('CLI mpg remux rewrites the aspect flag without re-encoding', async () => {
  const out = path.join(dir, 'remux');
  const r = await cli([vro, '-f', 'mpg', '-o', out, '-r', '1']);
  assert.equal(r.code, 0, r.stderr);
  const meta = await probeStreams(path.join(out, '001 2017-12-11 22-46-01.mpg'));
  const v = meta.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'mpeg2video');
  assert.equal(v.display_aspect_ratio, '16:9');
});

test('CLI rejects bad --recordings', async () => {
  const r = await cli([vro, '-r', '7']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /outside 1-3/);
});

// ---- browser app ----

async function withServer(fn) {
  const app = await createApp({ workDir: path.join(dir, 'work') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://localhost:${app.server.address().port}`);
  } finally {
    await app.close();
  }
}

async function waitFor(base, id) {
  for (let i = 0; i < 600; i++) {
    const job = await fetch(`${base}/api/jobs/${id}`).then((r) => r.json());
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

test('server: index upload → split job → per-recording and zip downloads', async () => {
  await withServer(async (base) => {
    const ir = await fetch(`${base}/api/ifo`, { method: 'POST', body: ifoBuf });
    assert.equal(ir.status, 201);
    const index = await ir.json();
    assert.equal(index.recordings.length, 3);
    assert.equal(index.format.aspect, '16:9');

    const res = await fetch(`${base}/api/jobs?name=VR_MOVIE.VRO&format=mp4&ifo=${index.id}`, {
      method: 'POST', body: await fs.readFile(vro),
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.mode, 'split');
    assert.equal(created.outputName, 'VR_MOVIE.zip');

    const job = await waitFor(base, created.id);
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(job.parts.map((p) => p.status), ['done', 'done', 'done']);
    assert.deepEqual(job.parts.map((p) => p.fileName), expectedNames);

    const one = await fetch(`${base}/api/jobs/${job.id}/parts/2/download`);
    assert.equal(one.status, 200);
    assert.match(one.headers.get('content-disposition'), /002%202017-12-12/);
    const oneFile = path.join(dir, 'one.mp4');
    await fs.writeFile(oneFile, Buffer.from(await one.arrayBuffer()));
    assert.ok(Math.abs(Number((await probeStreams(oneFile)).format.duration) - 3) < 0.3);

    const zip = await fetch(`${base}/api/jobs/${job.id}/download`);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    const zipBuf = Buffer.from(await zip.arrayBuffer());
    assert.equal(zipBuf.length, Number(zip.headers.get('content-length')));
    assert.equal(zipBuf.length, job.outputSize);
    const zipFile = path.join(dir, 'all.zip');
    await fs.writeFile(zipFile, zipBuf);
    const { stdout } = await exec('unzip', ['-l', zipFile]);
    for (const n of expectedNames) assert.ok(stdout.includes(n), `${n} in zip`);
    await exec('unzip', ['-tq', zipFile]); // throws on CRC/structure errors
  });
});

test('server: join mode, mismatched VRO and bad index are handled', async () => {
  await withServer(async (base) => {
    const index = await fetch(`${base}/api/ifo`, { method: 'POST', body: ifoBuf }).then((r) => r.json());

    const join = await fetch(`${base}/api/jobs?name=VR_MOVIE.VRO&ifo=${index.id}&mode=join`, {
      method: 'POST', body: await fs.readFile(vro),
    }).then((r) => r.json());
    assert.equal(join.mode, 'single');
    const done = await waitFor(base, join.id);
    assert.equal(done.status, 'done', done.error);

    const tooSmall = await fetch(`${base}/api/jobs?name=other.VRO&ifo=${index.id}`, {
      method: 'POST', body: Buffer.alloc(4096),
    });
    assert.equal(tooSmall.status, 400);
    assert.match((await tooSmall.json()).error, /doesn't match this VRO/);

    const bad = await fetch(`${base}/api/ifo`, { method: 'POST', body: 'not an index' });
    assert.equal(bad.status, 400);
    const unknown = await fetch(`${base}/api/jobs?name=a.vro&ifo=nope`, { method: 'POST', body: 'x' });
    assert.equal(unknown.status, 400);
  });
});
