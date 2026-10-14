// Local web server for the browser app. Zero dependencies (node:http only).
// Binds to 127.0.0.1 by default: files never leave your machine.
//
// API
//   GET    /api/formats             formats + options this machine supports
//   GET    /api/jobs                all jobs
//   POST   /api/jobs?name=&format=&quality=&deinterlace=   body: raw file bytes
//   GET    /api/jobs/:id            job status + progress
//   GET    /api/jobs/:id/download   converted file
//   DELETE /api/jobs/:id            cancel and delete

import http from 'node:http';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  convert, availableFormats, FORMATS, QUALITIES, DEINTERLACE, DEFAULT_FORMAT,
} from './convert.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const OUTPUT_MIME = {
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
  mpg: 'video/mpeg', mp3: 'audio/mpeg', m4a: 'audio/mp4',
};

/** Strip path components and characters that are awkward in file names. */
export function safeName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 200) || 'video';
}

export async function createApp({ workDir, concurrency = 1 } = {}) {
  const root = workDir
    ? await fs.mkdir(workDir, { recursive: true }).then(() => fs.mkdtemp(path.join(workDir, 'vroconv-')))
    : await fs.mkdtemp(path.join(os.tmpdir(), 'vroconv-'));

  const jobs = new Map();
  const queue = [];
  let running = 0;

  const view = (job) => ({
    id: job.id,
    name: job.name,
    outputName: job.outputName,
    format: job.format,
    quality: job.quality,
    deinterlace: job.deinterlace,
    status: job.status,
    progress: job.progress,
    error: job.error,
    outputSize: job.outputSize ?? null,
    info: job.info ?? null,
    createdAt: job.createdAt,
  });

  function pump() {
    while (running < concurrency && queue.length) {
      const job = queue.shift();
      if (job.status !== 'queued') continue;
      running++;
      runJob(job).finally(() => { running--; pump(); });
    }
  }

  async function runJob(job) {
    job.status = 'converting';
    job.progress = { percent: 0, seconds: 0, speed: null, duration: null };
    try {
      const { info } = await convert({
        input: job.inputPath,
        output: job.outputPath,
        format: job.format,
        quality: job.quality,
        deinterlace: job.deinterlace,
        signal: job.controller.signal,
        onProgress: (p) => { job.progress = p; },
      });
      job.info = info;
      job.outputSize = (await fs.stat(job.outputPath)).size;
      job.status = 'done';
      job.progress = { ...job.progress, percent: 100 };
      job.finishedAt = Date.now();
    } catch (err) {
      if (job.status === 'cancelled') return;
      job.status = 'error';
      // Show the user's file name, not our temp path.
      job.error = err.message.replaceAll(job.inputPath, job.name).replaceAll(job.dir, '');
      job.finishedAt = Date.now();
    } finally {
      // Source upload is no longer needed once conversion is over.
      await fs.rm(job.inputPath, { force: true }).catch(() => {});
    }
  }

  async function removeJob(job) {
    if (['queued', 'converting', 'uploading'].includes(job.status)) {
      job.status = 'cancelled';
      job.controller.abort();
    }
    jobs.delete(job.id);
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) removeJob(job);
    }
  }, 10 * 60 * 1000);
  sweeper.unref();

  async function handleUpload(req, res, url) {
    const name = safeName(url.searchParams.get('name'));
    const format = (url.searchParams.get('format') || DEFAULT_FORMAT).toLowerCase();
    const quality = url.searchParams.get('quality') || 'balanced';
    const deinterlace = url.searchParams.get('deinterlace') || 'auto';

    if (!FORMATS[format]) return sendJson(res, 400, { error: `Unknown format "${format}"` });
    if (!QUALITIES[quality]) return sendJson(res, 400, { error: `Unknown quality "${quality}"` });
    if (!DEINTERLACE[deinterlace]) return sendJson(res, 400, { error: `Unknown deinterlace mode "${deinterlace}"` });
    const support = (await availableFormats()).find((f) => f.id === format);
    if (!support.available) {
      return sendJson(res, 400, { error: `This machine's ffmpeg cannot produce ${format} (missing ${support.missing.join(', ')})` });
    }

    const id = crypto.randomUUID();
    const dir = path.join(root, id);
    await fs.mkdir(dir);
    const inExt = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const job = {
      id, dir, name, format, quality, deinterlace,
      inputPath: path.join(dir, `input${inExt}`),
      outputPath: path.join(dir, `output.${FORMATS[format].ext}`),
      outputName: `${path.parse(name).name || 'video'}.${FORMATS[format].ext}`,
      status: 'uploading',
      progress: null,
      error: null,
      controller: new AbortController(),
      createdAt: Date.now(),
    };
    jobs.set(id, job);

    try {
      await pipeline(req, createWriteStream(job.inputPath));
    } catch {
      await removeJob(job);
      if (!res.headersSent && !res.destroyed) sendJson(res, 400, { error: 'Upload interrupted' });
      return;
    }
    if (job.status === 'cancelled') return sendJson(res, 409, { error: 'Cancelled' });

    const { size } = await fs.stat(job.inputPath);
    if (size === 0) {
      await removeJob(job);
      return sendJson(res, 400, { error: 'Empty upload' });
    }

    job.status = 'queued';
    queue.push(job);
    pump();
    sendJson(res, 201, view(job));
  }

  async function handleDownload(req, res, job) {
    if (job.status !== 'done') return sendJson(res, 409, { error: `Job is ${job.status}` });
    const { size } = await fs.stat(job.outputPath);
    const ascii = job.outputName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    res.writeHead(200, {
      'Content-Type': OUTPUT_MIME[job.format] || 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.outputName)}`,
      'Cache-Control': 'no-store',
    });
    await pipeline(createReadStream(job.outputPath), res).catch(() => {});
  }

  async function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
    const data = await fs.readFile(file).catch(() => null);
    if (!data) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function handle(req, res) {
    // Reject requests whose Host isn't local: blocks DNS-rebinding attacks from web pages.
    const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
      return sendJson(res, 403, { error: 'Forbidden host' });
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] !== 'api') return handleStatic(req, res, url);

    if (parts[1] === 'formats' && req.method === 'GET') {
      return sendJson(res, 200, {
        formats: await availableFormats(),
        qualities: Object.entries(QUALITIES).map(([id, q]) => ({ id, label: q.label })),
        deinterlace: Object.entries(DEINTERLACE).map(([id, label]) => ({ id, label })),
        defaultFormat: DEFAULT_FORMAT,
      });
    }

    if (parts[1] === 'jobs') {
      if (parts.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, [...jobs.values()].map(view));
        if (req.method === 'POST') return handleUpload(req, res, url);
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      const job = jobs.get(parts[2]);
      if (!job) return sendJson(res, 404, { error: 'No such job' });
      if (parts.length === 3) {
        if (req.method === 'GET') return sendJson(res, 200, view(job));
        if (req.method === 'DELETE') { await removeJob(job); return sendJson(res, 200, { deleted: true }); }
      }
      if (parts[3] === 'download' && req.method === 'GET') return handleDownload(req, res, job);
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.destroy();
    });
  });
  // Multi-GB uploads take a while; Node's default 5-minute request timeout would cut them off.
  server.requestTimeout = 0;

  async function close() {
    clearInterval(sweeper);
    for (const job of jobs.values()) job.controller.abort();
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }

  return { server, close, workDir: root };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

export async function startServer({ port = 5173, host = '127.0.0.1', open = false, workDir } = {}) {
  // Fail early with a helpful message if ffmpeg is missing.
  await availableFormats();

  const app = await createApp({ workDir });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, resolve);
  });
  const actualPort = app.server.address().port;
  const url = `http://localhost:${actualPort}`;
  console.log(`VRO Converter running at ${url}`);
  console.log(`Temporary files: ${app.workDir}`);
  console.log('Press Ctrl+C to stop.');
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn(`Warning: listening on ${host}. Only localhost Host headers are accepted.`);
  }
  if (open) openBrowser(url);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nShutting down, removing temporary files…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { ...app, url };
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* opening the browser is best-effort */ }
}
