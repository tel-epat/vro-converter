import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildArgs, probe, convert, availableFormats, FORMATS,
} from '../src/convert.js';
import { tempDir, makeSampleVro, probeStreams } from './helpers.js';

let dir;
let sample;

before(async () => {
  dir = await tempDir();
  sample = await makeSampleVro(dir);
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('buildArgs: mp4 defaults use H.264/AAC, faststart and auto deinterlace', () => {
  const args = buildArgs({ input: 'in.vro', output: 'out.mp4' });
  const s = args.join(' ');
  assert.match(s, /-fflags \+genpts\+discardcorrupt/);
  assert.match(s, /-i in\.vro/);
  assert.match(s, /-c:v libx264/);
  assert.match(s, /-crf 21/);
  assert.match(s, /-c:a aac/);
  assert.match(s, /yadif=mode=send_frame:deint=interlaced/);
  assert.match(s, /-movflags \+faststart/);
  assert.equal(args.at(-1), 'out.mp4');
});

test('buildArgs: deinterlace on/off', () => {
  assert.match(buildArgs({ input: 'a', output: 'b.mp4', deinterlace: 'on' }).join(' '), /deint=all/);
  assert.doesNotMatch(buildArgs({ input: 'a', output: 'b.mp4', deinterlace: 'off' }).join(' '), /yadif/);
});

test('buildArgs: mpg is a stream copy with no filters', () => {
  const s = buildArgs({ input: 'a', output: 'b.mpg', format: 'mpg' }).join(' ');
  assert.match(s, /-c copy/);
  assert.doesNotMatch(s, /yadif|libx264/);
});

test('buildArgs: audio-only formats drop video', () => {
  const s = buildArgs({ input: 'a', output: 'b.mp3', format: 'mp3' }).join(' ');
  assert.match(s, /-vn/);
  assert.match(s, /libmp3lame/);
});

test('buildArgs: rejects unknown options', () => {
  assert.throws(() => buildArgs({ input: 'a', output: 'b', format: 'avi' }), /Unknown format/);
  assert.throws(() => buildArgs({ input: 'a', output: 'b', quality: 'ultra' }), /Unknown quality/);
  assert.throws(() => buildArgs({ input: 'a', output: 'b', deinterlace: 'maybe' }), /Unknown deinterlace/);
});

test('buildArgs: file names with spaces and shell characters stay single arguments', () => {
  const nasty = 'my "holiday" $(rm -rf) ; .vro';
  const args = buildArgs({ input: nasty, output: 'x.mp4' });
  assert.equal(args[args.indexOf('-i') + 1], nasty);
});

test('probe: reads the synthetic VRO as MPEG-2 PS with AC3', async () => {
  const info = await probe(sample);
  assert.equal(info.video.codec, 'mpeg2video');
  assert.equal(info.video.width, 720);
  assert.equal(info.video.height, 576);
  assert.equal(info.audio[0].codec, 'ac3');
  assert.ok(info.duration > 1.5 && info.duration < 2.6, `duration ${info.duration}`);
});

test('availableFormats: mp4 is available in the test environment', async () => {
  const formats = await availableFormats();
  assert.deepEqual(formats.map((f) => f.id), Object.keys(FORMATS));
  assert.ok(formats.find((f) => f.id === 'mp4').available);
});

test('convert: VRO → MP4 produces H.264 + AAC with progress reaching 100', async () => {
  const output = path.join(dir, 'out.mp4');
  const seen = [];
  await convert({ input: sample, output, onProgress: (p) => seen.push(p.percent) });
  const meta = await probeStreams(output);
  const v = meta.streams.find((s) => s.codec_type === 'video');
  const a = meta.streams.find((s) => s.codec_type === 'audio');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.equal(a.codec_name, 'aac');
  assert.equal(v.display_aspect_ratio, '4:3', 'DVD aspect ratio must survive');
  assert.ok(Math.abs(Number(meta.format.duration) - 2) < 0.3);
  assert.equal(seen.at(-1), 100);
});

for (const format of ['mkv', 'mov', 'mpg', 'm4a', 'mp3', 'webm']) {
  test(`convert: VRO → ${format}`, async (t) => {
    const support = (await availableFormats()).find((f) => f.id === format);
    if (!support.available) return t.skip(`ffmpeg lacks ${support.missing.join(', ')}`);
    const output = path.join(dir, `out.${FORMATS[format].ext}`);
    await convert({ input: sample, output, format, quality: 'small' });
    const meta = await probeStreams(output);
    const hasVideo = meta.streams.some((s) => s.codec_type === 'video');
    assert.equal(hasVideo, FORMATS[format].video !== null);
    assert.ok(meta.streams.some((s) => s.codec_type === 'audio'));
  });
}

test('convert: garbage input fails with a readable error and leaves no output', async () => {
  const bad = path.join(dir, 'broken.vro');
  await fs.writeFile(bad, 'this is not a video');
  const output = path.join(dir, 'broken.mp4');
  await assert.rejects(convert({ input: bad, output }), /Could not read/);
  await assert.rejects(fs.access(output));
});

test('convert: abort cancels and removes partial output', async () => {
  const long = await makeSampleVro(dir, { name: 'long.vro', seconds: 20 });
  const output = path.join(dir, 'long.mp4');
  const controller = new AbortController();
  const p = convert({
    input: long, output, format: 'webm', quality: 'high', signal: controller.signal,
    onProgress: () => controller.abort(),
  });
  await assert.rejects(p, { name: 'AbortError' });
  await assert.rejects(fs.access(output));
});
