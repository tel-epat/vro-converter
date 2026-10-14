import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, makeSampleVro, probeStreams } from './helpers.js';

const exec = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const run = (args) => exec('node', [CLI, ...args]).then(
  (r) => ({ code: 0, ...r }),
  (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
);

let dir;

before(async () => { dir = await tempDir(); });
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

test('converts a disc folder (DVD_RTAV/VR_MOVIE.VRO) into an output folder', async () => {
  const disc = path.join(dir, 'disc', 'DVD_RTAV');
  await fs.mkdir(disc, { recursive: true });
  await makeSampleVro(disc);
  const out = path.join(dir, 'out');

  const r = await run([path.join(dir, 'disc'), '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  const meta = await probeStreams(path.join(out, 'VR_MOVIE.mp4'));
  assert.ok(meta.streams.some((s) => s.codec_name === 'h264'));

  const again = await run([path.join(dir, 'disc'), '-o', out]);
  assert.equal(again.code, 1, 'existing output is not overwritten silently');
  assert.match(again.stderr, /already exists/);

  const forced = await run([path.join(dir, 'disc'), '-o', out, '--overwrite']);
  assert.equal(forced.code, 0, forced.stderr);
});

test('multiple recordings with restarting timestamps convert to one continuous file', async () => {
  // A real VRO often holds several recordings back to back, each starting its clock at zero.
  const a = await makeSampleVro(dir, { name: 'a.vob', seconds: 2 });
  const b = await makeSampleVro(dir, { name: 'b.vob', seconds: 2 });
  const joined = path.join(dir, 'joined.vro');
  await fs.writeFile(joined, Buffer.concat([await fs.readFile(a), await fs.readFile(b)]));

  const r = await run([joined, '-f', 'mkv']);
  assert.equal(r.code, 0, r.stderr);
  const meta = await probeStreams(path.join(dir, 'joined.mkv'));
  const duration = Number(meta.format.duration);
  assert.ok(duration > 3.5, `expected both recordings (~4s), got ${duration}s`);
});

test('reports bad options with a non-zero exit', async () => {
  const r = await run(['x.vro', '-f', 'avi']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown format/);
});

test('--list-formats and --help work without input', async () => {
  assert.match((await run(['--list-formats'])).stdout, /mp4/);
  assert.match((await run(['--help'])).stdout, /Usage:/);
});
