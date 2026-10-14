import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execFile);

export async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vroconv-test-'));
}

/**
 * Build a small file shaped like a DVD-VR recording: MPEG-2 program stream,
 * PAL 720x576 interlaced MPEG-2 video, AC3 audio, .vro extension.
 */
export async function makeSampleVro(dir, { name = 'VR_MOVIE.VRO', seconds = 2 } = {}) {
  const out = path.join(dir, name);
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=720x576:rate=25:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'mpeg2video', '-b:v', '4M', '-flags', '+ilme+ildct', '-top', '1', '-aspect', '4:3',
    '-c:a', 'ac3', '-b:a', '192k',
    '-f', 'vob', out,
  ]);
  return out;
}

export async function probeStreams(file) {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  return JSON.parse(stdout);
}
