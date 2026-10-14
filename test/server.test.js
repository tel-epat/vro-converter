import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createApp, safeName } from '../src/server.js';
import { tempDir, makeSampleVro, probeStreams } from './helpers.js';

let dir;
let sample;
let app;
let base;

before(async () => {
  dir = await tempDir();
  sample = await makeSampleVro(dir);
  app = await createApp({ workDir: path.join(dir, 'work') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function waitFor(id) {
  for (let i = 0; i < 300; i++) {
    const job = await fetch(`${base}/api/jobs/${id}`).then((r) => r.json());
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

test('safeName strips paths and odd characters', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\videos\\Holiday 2009.VRO'), 'Holiday 2009.VRO');
  assert.equal(safeName('a<b>:c?.vro'), 'a_b__c_.vro');
  assert.equal(safeName(''), 'video');
  assert.equal(safeName('...'), 'video');
});

test('serves the UI', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /VRO Converter/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
});

test('static files cannot escape the public folder', async () => {
  const res = await fetch(`${base}/..%2fpackage.json`);
  assert.equal(res.status, 404);
});

test('rejects non-local Host headers (DNS rebinding)', async () => {
  const http = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: app.server.address().port, path: '/api/formats', headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('GET /api/formats lists formats and options', async () => {
  const body = await fetch(`${base}/api/formats`).then((r) => r.json());
  assert.equal(body.defaultFormat, 'mp4');
  assert.ok(body.formats.some((f) => f.id === 'mp4' && f.available));
  assert.ok(body.qualities.length >= 3);
});

test('upload → convert → download round trip', async () => {
  const data = await fs.readFile(sample);
  const res = await fetch(`${base}/api/jobs?name=${encodeURIComponent('Holiday 2009.VRO')}&format=mp4`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data,
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.outputName, 'Holiday 2009.mp4');

  const job = await waitFor(created.id);
  assert.equal(job.status, 'done', job.error);
  assert.ok(job.outputSize > 0);

  const dl = await fetch(`${base}/api/jobs/${job.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'video/mp4');
  assert.match(dl.headers.get('content-disposition'), /Holiday%202009\.mp4/);
  const out = path.join(dir, 'downloaded.mp4');
  await fs.writeFile(out, Buffer.from(await dl.arrayBuffer()));
  const meta = await probeStreams(out);
  assert.ok(meta.streams.some((s) => s.codec_name === 'h264'));

  const del = await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${base}/api/jobs/${job.id}`)).status, 404);
});

test('bad upload reports an error instead of crashing', async () => {
  const res = await fetch(`${base}/api/jobs?name=junk.vro`, { method: 'POST', body: 'not a video at all' });
  assert.equal(res.status, 201);
  const job = await waitFor((await res.json()).id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /Could not read/);
});

test('validates parameters', async () => {
  const res = await fetch(`${base}/api/jobs?name=a.vro&format=avi`, { method: 'POST', body: 'x' });
  assert.equal(res.status, 400);
  const empty = await fetch(`${base}/api/jobs?name=a.vro`, { method: 'POST', body: '' });
  assert.equal(empty.status, 400);
});
