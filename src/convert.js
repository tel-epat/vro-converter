// Core conversion logic: a thin, well-defined wrapper around ffmpeg/ffprobe.
// Shared by the CLI and the web server.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// VRO files (DVD-VR recordings from DVD-RAM/-RW discs and camcorders) are MPEG-2
// program streams that often contain timestamp jumps between recordings, corrupt
// packets around edit points and navigation data streams. These input flags make
// ffmpeg regenerate missing timestamps, drop corrupt packets instead of failing,
// and probe deep enough to find audio that starts late in the file.
export const INPUT_FLAGS = [
  '-fflags', '+genpts+discardcorrupt',
  '-analyzeduration', '100M',
  '-probesize', '100M',
];

export const QUALITIES = {
  high: { label: 'High (larger file)', x264: 18, vp9: 28, audio: '256k' },
  balanced: { label: 'Balanced', x264: 21, vp9: 32, audio: '192k' },
  small: { label: 'Small (lower quality)', x264: 26, vp9: 38, audio: '128k' },
};

export const DEINTERLACE = {
  auto: 'Auto', // only frames the stream flags as interlaced — safe default
  on: 'Always',
  off: 'Never',
};

export const FORMATS = {
  mp4: {
    label: 'MP4 — H.264 + AAC (plays everywhere)',
    ext: 'mp4', video: 'x264', audio: 'aac',
    container: ['-movflags', '+faststart'],
    encoders: ['libx264', 'aac'],
  },
  mov: {
    label: 'MOV — H.264 + AAC (QuickTime, iMovie, Final Cut)',
    ext: 'mov', video: 'x264', audio: 'aac',
    container: ['-movflags', '+faststart'],
    encoders: ['libx264', 'aac'],
  },
  mkv: {
    label: 'MKV — H.264 + AAC',
    ext: 'mkv', video: 'x264', audio: 'aac',
    container: [],
    encoders: ['libx264', 'aac'],
  },
  webm: {
    label: 'WebM — VP9 + Opus (slow to encode)',
    ext: 'webm', video: 'vp9', audio: 'opus',
    container: [],
    encoders: ['libvpx-vp9', 'libopus'],
  },
  mpg: {
    label: 'MPG — lossless remux, no re-encode (fast)',
    ext: 'mpg', copy: true,
    container: [],
    encoders: [],
  },
  mp3: {
    label: 'MP3 — audio only',
    ext: 'mp3', video: null, audio: 'mp3',
    container: [],
    encoders: ['libmp3lame'],
  },
  m4a: {
    label: 'M4A — audio only (AAC)',
    ext: 'm4a', video: null, audio: 'aac',
    container: ['-movflags', '+faststart'],
    encoders: ['aac'],
  },
};

export const DEFAULT_FORMAT = 'mp4';

function videoArgs(codec, quality) {
  const q = QUALITIES[quality];
  if (codec === 'x264') {
    return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(q.x264), '-pix_fmt', 'yuv420p'];
  }
  if (codec === 'vp9') {
    return [
      '-c:v', 'libvpx-vp9', '-crf', String(q.vp9), '-b:v', '0',
      '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-pix_fmt', 'yuv420p',
    ];
  }
  throw new Error(`Unknown video codec: ${codec}`);
}

function audioArgs(codec, quality) {
  const bitrate = QUALITIES[quality].audio;
  const encoder = { aac: 'aac', opus: 'libopus', mp3: 'libmp3lame' }[codec];
  if (!encoder) throw new Error(`Unknown audio codec: ${codec}`);
  return ['-c:a', encoder, '-b:a', bitrate];
}

/**
 * Build the ffmpeg argument list (no shell involved — safe for any file name).
 * Pure function, exported for testing.
 */
export function buildArgs({ input, output, format = DEFAULT_FORMAT, quality = 'balanced', deinterlace = 'auto' }) {
  const fmt = FORMATS[format];
  if (!fmt) throw new Error(`Unknown format "${format}". Options: ${Object.keys(FORMATS).join(', ')}`);
  if (!QUALITIES[quality]) throw new Error(`Unknown quality "${quality}". Options: ${Object.keys(QUALITIES).join(', ')}`);
  if (!DEINTERLACE[deinterlace]) throw new Error(`Unknown deinterlace mode "${deinterlace}". Options: ${Object.keys(DEINTERLACE).join(', ')}`);

  const args = ['-hide_banner', '-nostdin', '-y', ...INPUT_FLAGS, '-i', input];

  if (fmt.copy) {
    // Straight remux into a clean MPEG program stream: keeps original quality,
    // fixes timestamps, drops DVD-VR navigation packets. VOB muxer handles AC3/LPCM.
    args.push('-map', '0:v:0?', '-map', '0:a?', '-c', 'copy', '-f', 'vob');
  } else {
    if (fmt.video) {
      args.push('-map', '0:v:0');
      // yadif with deint=interlaced only touches frames the stream flags as
      // interlaced, so "auto" is safe for progressive material too.
      if (deinterlace !== 'off') {
        const mode = deinterlace === 'on' ? 'all' : 'interlaced';
        args.push('-vf', `yadif=mode=send_frame:deint=${mode}`);
      }
      args.push(...videoArgs(fmt.video, quality));
      args.push('-map', '0:a:0?');
    } else {
      // audio-only output: fail clearly if there is no audio
      args.push('-vn', '-map', '0:a:0');
    }
    args.push(...audioArgs(fmt.audio, quality));
  }

  args.push(
    '-sn', '-dn',
    '-max_muxing_queue_size', '1024',
    ...fmt.container,
    '-progress', 'pipe:1', '-nostats',
    output,
  );
  return args;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(missingBinaryError(cmd, err)));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim().split('\n').slice(-5).join('\n')}`));
    });
  });
}

function missingBinaryError(cmd, err) {
  if (err && err.code === 'ENOENT') {
    return new Error(`"${cmd}" was not found. Install ffmpeg (macOS: brew install ffmpeg) or set FFMPEG_PATH/FFPROBE_PATH.`);
  }
  return err;
}

/** Probe a media file. Returns a compact summary; throws if the file is not readable media. */
export async function probe(input) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', ...INPUT_FLAGS,
    '-print_format', 'json', '-show_format', '-show_streams', input,
  ]);
  const data = JSON.parse(stdout);
  const streams = data.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const duration = Number.parseFloat(data.format?.duration);
  return {
    container: data.format?.format_name ?? null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    size: Number(data.format?.size) || null,
    video: v ? {
      codec: v.codec_name,
      width: v.width,
      height: v.height,
      fieldOrder: v.field_order ?? 'unknown',
      aspect: v.display_aspect_ratio ?? null,
      fps: v.avg_frame_rate ?? v.r_frame_rate ?? null,
    } : null,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({
      codec: s.codec_name,
      channels: s.channels,
      sampleRate: Number(s.sample_rate) || null,
    })),
  };
}

let encoderCache = null;

/** Set of encoder names compiled into the local ffmpeg build. */
export async function listEncoders() {
  if (!encoderCache) {
    encoderCache = run(FFMPEG, ['-hide_banner', '-encoders']).then(({ stdout }) => {
      const names = new Set();
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/);
        if (m) names.add(m[1]);
      }
      return names;
    }).catch((err) => {
      encoderCache = null;
      throw err;
    });
  }
  return encoderCache;
}

/** All formats, flagged by whether this machine's ffmpeg can produce them. */
export async function availableFormats() {
  const encoders = await listEncoders();
  return Object.entries(FORMATS).map(([id, f]) => {
    const missing = f.encoders.filter((e) => !encoders.has(e));
    return { id, label: f.label, ext: f.ext, available: missing.length === 0, missing };
  });
}

/**
 * Convert a file. Resolves with { output, info } when done.
 * onProgress({ percent, seconds, duration, speed }) is called as ffmpeg reports progress;
 * percent is null when the source duration is unknown.
 * Pass an AbortSignal to cancel; the partial output file is removed.
 */
export async function convert({
  input, output, format = DEFAULT_FORMAT, quality = 'balanced', deinterlace = 'auto',
  onProgress, signal,
}) {
  const args = buildArgs({ input, output, format, quality, deinterlace });

  // Probe first so bad inputs fail fast with a clear message, and to get duration for progress.
  let info;
  try {
    info = await probe(input);
  } catch (err) {
    const reason = err.message.split('\n').pop().replace(/^.*?:\s(?=[A-Z])/, '');
    throw new Error(`Could not read "${input}" as video — ${reason}`);
  }
  if (!info.video && FORMATS[format].video) {
    throw new Error('No video stream found in the input file.');
  }
  if (info.audio.length === 0 && FORMATS[format].video === null) {
    throw new Error('No audio stream found — cannot produce an audio-only file.');
  }
  if (signal?.aborted) throw abortError();

  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrTail = [];
    let buffered = '';
    let last = {};
    let settled = false;

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        last[key] = value;
        if (key === 'progress') {
          const us = Number(last.out_time_us ?? last.out_time_ms);
          const seconds = Number.isFinite(us) && us >= 0 ? us / 1e6 : 0;
          const speed = Number.parseFloat(last.speed) || null;
          let percent = info.duration ? Math.min(99.9, (seconds / info.duration) * 100) : null;
          if (value === 'end') percent = 100;
          onProgress?.({ percent, seconds, duration: info.duration, speed });
          last = {};
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > 30) stderrTail.shift();
      }
    });

    const finish = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve();
    };

    child.on('error', (err) => finish(missingBinaryError(FFMPEG, err)));
    child.on('close', (code) => {
      if (signal?.aborted) return finish(abortError());
      if (code === 0) return finish();
      finish(new Error(`ffmpeg failed (exit ${code}):\n${stderrTail.slice(-8).join('\n')}`));
    });
  }).catch(async (err) => {
    await fs.rm(output, { force: true });
    throw err;
  });

  const stat = await fs.stat(output).catch(() => null);
  if (!stat || stat.size === 0) {
    await fs.rm(output, { force: true });
    throw new Error('ffmpeg finished but produced an empty file.');
  }
  return { output, info };
}

function abortError() {
  const err = new Error('Conversion cancelled');
  err.name = 'AbortError';
  return err;
}
