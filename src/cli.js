#!/usr/bin/env node
// Command-line interface.
//   vroconv <file.vro|folder> [...more] [options]
//   vroconv serve [--port 5173] [--open]

import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  convert, availableFormats, FORMATS, QUALITIES, DEINTERLACE, DEFAULT_FORMAT,
} from './convert.js';

const HELP = `vroconv — convert DVD-VR .VRO recordings (and other video) to MP4 and more

Usage:
  vroconv <input...> [options]       Convert files. Folders are searched for .vro files.
  vroconv serve [--port N] [--open]  Start the browser app on http://localhost:N

Options:
  -f, --format <fmt>        ${Object.keys(FORMATS).join(' | ')}   (default: ${DEFAULT_FORMAT})
  -q, --quality <q>         ${Object.keys(QUALITIES).join(' | ')}   (default: balanced)
  -d, --deinterlace <mode>  ${Object.keys(DEINTERLACE).join(' | ')}   (default: auto)
  -o, --output <path>       Output file (single input) or folder (any number of inputs).
                            Default: next to each input, same name, new extension.
      --overwrite           Replace existing output files.
      --list-formats        Show formats your ffmpeg build supports.
  -h, --help                Show this help.

Examples:
  vroconv VR_MOVIE.VRO
  vroconv /Volumes/DVD_VR/DVD_RTAV -o ~/Movies/converted
  vroconv holiday.vro -f mkv -q high
  vroconv serve --open
`;

async function main(argv) {
  if (argv[0] === 'serve') return serve(argv.slice(1));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', short: 'f', default: DEFAULT_FORMAT },
        quality: { type: 'string', short: 'q', default: 'balanced' },
        deinterlace: { type: 'string', short: 'd', default: 'auto' },
        output: { type: 'string', short: 'o' },
        overwrite: { type: 'boolean', default: false },
        'list-formats': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  const { values: opts, positionals } = parsed;

  if (opts.help) { console.log(HELP); return 0; }

  if (opts['list-formats']) {
    for (const f of await availableFormats()) {
      const note = f.available ? '' : `   (unavailable — ffmpeg lacks ${f.missing.join(', ')})`;
      console.log(`  ${f.id.padEnd(6)} ${f.label}${note}`);
    }
    return 0;
  }

  if (positionals.length === 0) { console.log(HELP); return 2; }

  const fmt = opts.format.toLowerCase();
  if (!FORMATS[fmt]) return fail(`Unknown format "${opts.format}". Use one of: ${Object.keys(FORMATS).join(', ')}`);
  if (!QUALITIES[opts.quality]) return fail(`Unknown quality "${opts.quality}".`);
  if (!DEINTERLACE[opts.deinterlace]) return fail(`Unknown deinterlace mode "${opts.deinterlace}".`);

  const support = (await availableFormats()).find((f) => f.id === fmt);
  if (!support.available) return fail(`Your ffmpeg build cannot produce ${fmt} (missing: ${support.missing.join(', ')}).`);

  const inputs = await expandInputs(positionals);
  if (inputs.length === 0) return fail('No input files found (folders are searched for .vro files).');

  const jobs = await planOutputs(inputs, fmt, opts.output);
  if (typeof jobs === 'string') return fail(jobs);

  let failures = 0;
  for (const [i, { input, output }] of jobs.entries()) {
    const prefix = jobs.length > 1 ? `[${i + 1}/${jobs.length}] ` : '';
    if (!opts.overwrite && await exists(output)) {
      console.error(`${prefix}skip  ${output} already exists (use --overwrite)`);
      failures++;
      continue;
    }
    console.log(`${prefix}${input}\n   → ${output}`);
    const started = Date.now();
    try {
      await convert({
        input, output, format: fmt, quality: opts.quality, deinterlace: opts.deinterlace,
        onProgress: process.stderr.isTTY ? drawProgress : undefined,
      });
      if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
      console.log(`   done in ${formatTime((Date.now() - started) / 1000)}`);
    } catch (err) {
      if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
      console.error(`   FAILED: ${err.message}`);
      failures++;
    }
  }
  return failures ? 1 : 0;
}

async function expandInputs(paths) {
  const result = [];
  for (const p of paths) {
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) { console.error(`not found: ${p}`); continue; }
    if (stat.isDirectory()) {
      result.fromFolder = true;
      const entries = await fs.readdir(p, { recursive: true });
      entries
        .filter((e) => /\.vro$/i.test(e))
        .sort()
        .forEach((e) => result.push(path.join(p, e)));
    } else {
      result.push(p);
    }
  }
  return result;
}

async function planOutputs(inputs, fmt, outOpt) {
  const ext = FORMATS[fmt].ext;
  const withExt = (file, dir) => path.join(dir ?? path.dirname(file), `${path.parse(file).name}.${ext}`);

  if (!outOpt) return inputs.map((input) => ({ input, output: withExt(input) }));

  const outStat = await fs.stat(outOpt).catch(() => null);
  const looksLikeDir = outStat?.isDirectory() || outOpt.endsWith(path.sep) || outOpt.endsWith('/')
    || (!outStat && path.extname(outOpt) === '');

  if (inputs.length === 1 && !inputs.fromFolder && !looksLikeDir) {
    return [{ input: inputs[0], output: outOpt }];
  }
  if (outStat && !outStat.isDirectory()) return `--output must be a folder when converting several files.`;
  await fs.mkdir(outOpt, { recursive: true });

  const plan = inputs.map((input) => ({ input, output: withExt(input, outOpt) }));
  const seen = new Set();
  for (const { output } of plan) {
    if (seen.has(output)) return `Two inputs would both be written to ${output}. Convert them separately or without --output.`;
    seen.add(output);
  }
  return plan;
}

function drawProgress({ percent, seconds, speed }) {
  const width = 30;
  const pct = percent ?? 0;
  const filled = Math.round((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pctText = percent == null ? '  ?  ' : `${pct.toFixed(1).padStart(5)}%`;
  const speedText = speed ? `  ${speed.toFixed(1)}x` : '';
  process.stderr.write(`\r   ${bar} ${pctText}  ${formatTime(seconds)}${speedText}\x1b[K`);
}

function formatTime(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}

function fail(msg) {
  console.error(msg);
  return 2;
}

async function serve(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', short: 'p', default: '5173' },
      host: { type: 'string', default: '127.0.0.1' },
      open: { type: 'boolean', default: false },
      'work-dir': { type: 'string' },
    },
  });
  const { startServer } = await import('./server.js');
  await startServer({
    port: Number(values.port),
    host: values.host,
    open: values.open,
    workDir: values['work-dir'],
  });
  return null; // keep running
}

main(process.argv.slice(2)).then(
  (code) => { if (code !== null) process.exitCode = code; },
  (err) => { console.error(err.message); process.exitCode = 1; },
);
