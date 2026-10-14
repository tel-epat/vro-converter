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
import {
  parseIfo, findIfoFor, checkAgainstVro, planRecordings, parseSelection, commonAspect,
} from './ifo.js';

const HELP = `vroconv — convert DVD-VR .VRO recordings (and other video) to MP4 and more

Usage:
  vroconv <input...> [options]       Convert files. Folders are searched for .vro files.
  vroconv serve [--port N] [--open]  Start the browser app on http://localhost:N

When VR_MANGR.IFO sits next to the VRO (as on the disc), each recording becomes
its own file, named by number and recording date, in a folder named after the VRO.

Options:
  -f, --format <fmt>        ${Object.keys(FORMATS).join(' | ')}   (default: ${DEFAULT_FORMAT})
  -q, --quality <q>         ${Object.keys(QUALITIES).join(' | ')}   (default: balanced)
  -d, --deinterlace <mode>  ${Object.keys(DEINTERLACE).join(' | ')}   (default: auto)
  -o, --output <path>       Output file or folder. Default: next to the input.
      --overwrite           Replace existing output files.
                            (Without it, finished recordings are skipped, so an
                            interrupted split can simply be run again.)
  Recordings (need VR_MANGR.IFO):
      --list                Show the recordings in the index and exit.
  -r, --recordings <list>   Only these recordings, e.g. 1,3,5-8.
      --join                One output file for the whole VRO instead of one per recording.
      --ifo <path>          Use this VR_MANGR.IFO instead of looking next to the VRO.

      --list-formats        Show formats your ffmpeg build supports.
  -h, --help                Show this help.

Examples:
  vroconv /Volumes/DVD_VR/DVD_RTAV -o ~/Movies/camcorder
  vroconv VR_MOVIE.VRO --list
  vroconv VR_MOVIE.VRO -r 5-9 -f mov
  vroconv VR_MOVIE.VRO --join -q high
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
        list: { type: 'boolean', default: false },
        recordings: { type: 'string', short: 'r' },
        join: { type: 'boolean', default: false },
        ifo: { type: 'string' },
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

  const inputs = await expandInputs(positionals);
  if (inputs.length === 0) return fail('No input files found (folders are searched for .vro files).');
  if (opts.ifo && inputs.length !== 1) return fail('--ifo can only be used with a single VRO.');

  // Attach each VRO's index, if there is one.
  const sources = [];
  for (const input of inputs) {
    const src = await loadIndex(input, opts.ifo);
    if (typeof src === 'string') return fail(src);
    sources.push(src);
  }

  if (opts.list) return listRecordings(sources);

  if (opts.recordings && !(sources.length === 1 && sources[0].ifo)) {
    return fail('--recordings needs exactly one VRO with its VR_MANGR.IFO.');
  }
  if (opts.recordings && opts.join) return fail('--recordings and --join cannot be combined.');
  if (opts.recordings) {
    try { parseSelection(opts.recordings, sources[0].ifo.programs.length); } catch (err) { return fail(err.message); }
  }

  const support = (await availableFormats()).find((f) => f.id === fmt);
  if (!support.available) return fail(`Your ffmpeg build cannot produce ${fmt} (missing: ${support.missing.join(', ')}).`);

  const settings = { format: fmt, quality: opts.quality, deinterlace: opts.deinterlace };
  const whole = sources.filter((s) => !s.ifo || opts.join);
  const split = sources.filter((s) => s.ifo && !opts.join);

  const wholePlan = whole.length ? await planOutputs(whole, fmt, opts.output, inputs.fromFolder || split.length > 0) : [];
  if (typeof wholePlan === 'string') return fail(wholePlan);
  const splitPlan = await planSplitFolders(split, opts.output);
  if (typeof splitPlan === 'string') return fail(splitPlan);

  let failures = 0;
  const total = wholePlan.length + splitPlan.length;
  let n = 0;

  for (const { src, output } of wholePlan) {
    const prefix = total > 1 ? `[${++n}/${total}] ` : '';
    if (!opts.overwrite && await exists(output)) {
      console.error(`${prefix}skip  ${output} already exists (use --overwrite)`);
      failures++;
      continue;
    }
    const aspect = src.ifo ? commonAspect(src.ifo) : null;
    console.log(`${prefix}${src.input}\n   → ${output}${aspect ? `   (aspect ${aspect} from index)` : ''}`);
    failures += await runOne({ ...settings, input: src.input, output, aspect }) ? 0 : 1;
  }

  for (const { src, dir } of splitPlan) {
    const prefix = total > 1 ? `[${++n}/${total}] ` : '';
    const selection = opts.recordings ? parseSelection(opts.recordings, src.ifo.programs.length) : null;
    const recs = planRecordings(src.ifo, { ext: FORMATS[fmt].ext, selection });
    console.log(`${prefix}${src.input}: ${recs.length} recording${recs.length === 1 ? '' : 's'} → ${dir}${path.sep}`);
    await fs.mkdir(dir, { recursive: true });
    let skipped = 0;
    for (const [i, rec] of recs.entries()) {
      const output = path.join(dir, rec.fileName);
      const tag = `   [${String(i + 1).padStart(String(recs.length).length)}/${recs.length}]`;
      if (!opts.overwrite && await exists(output)) {
        skipped++;
        continue;
      }
      console.log(`${tag} #${rec.number}  ${rec.recorded ?? 'no date'}  ${rec.duration ? formatTime(rec.duration) : ''}  → ${rec.fileName}`);
      const ok = await runOne({
        ...settings, input: src.input, output, range: rec.range, aspect: rec.aspect, recordedAt: rec.recordedAt,
      }, '        ');
      if (!ok) failures++;
    }
    if (skipped) console.log(`   ${skipped} already converted, skipped (use --overwrite to redo)`);
  }

  return failures ? 1 : 0;
}

async function runOne(job, indent = '   ') {
  const started = Date.now();
  try {
    await convert({ ...job, onProgress: process.stderr.isTTY ? (p) => drawProgress(p, indent) : undefined });
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
    console.log(`${indent}done in ${formatTime((Date.now() - started) / 1000)}`);
    return true;
  } catch (err) {
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
    console.error(`${indent}FAILED: ${err.message}`);
    return false;
  }
}

/** Returns { input, ifo, ifoPath } or an error string. */
async function loadIndex(input, explicitIfo) {
  const ifoPath = explicitIfo ?? (/\.vro$/i.test(input) ? await findIfoFor(input) : null);
  if (!ifoPath) return { input, ifo: null, ifoPath: null };

  let ifo;
  try {
    ifo = parseIfo(await fs.readFile(ifoPath));
    const problem = checkAgainstVro(ifo, (await fs.stat(input)).size);
    if (problem) throw new Error(problem);
  } catch (err) {
    if (explicitIfo) return `${ifoPath}: ${err.message}`;
    console.error(`warning: ignoring ${ifoPath}: ${err.message}\n         ${input} will be converted as one file.`);
    return { input, ifo: null, ifoPath, rejected: true };
  }
  if (ifo.cprm) console.error(`warning: ${ifoPath} marks the disc as copy-protected (CPRM); protected recordings will fail.`);
  return { input, ifo, ifoPath };
}

function listRecordings(sources) {
  let any = false;
  for (const { input, ifo, ifoPath, rejected } of sources) {
    if (!ifo) {
      if (!rejected) console.log(`${input}: no VR_MANGR.IFO found next to it — would be converted as one file.\n`);
      continue;
    }
    any = true;
    const f = ifo.formats[0];
    const fmtText = f ? [f.video.tvSystem, f.video.width && `${f.video.width}×${f.video.height}`, f.video.aspect, f.audio.codec?.toUpperCase()].filter(Boolean).join(' ') : '';
    const totalDur = ifo.programs.reduce((s, p) => s + (p.duration ?? 0), 0);
    console.log(`${input}`);
    console.log(`  index: ${ifoPath} (DVD-VR ${ifo.version})${ifo.discInfo.length ? ` "${ifo.discInfo.join(' / ')}"` : ''}`);
    console.log(`  ${ifo.programs.length} recordings, ${formatTime(totalDur)} total${fmtText ? `, ${fmtText}` : ''}\n`);
    const w = String(ifo.programs.length).length;
    console.log(`  ${'#'.padStart(w)}  recorded             length      size  label`);
    for (const p of ifo.programs) {
      console.log(`  ${String(p.number).padStart(w)}  ${(p.recorded?.text ?? '—').padEnd(19)}  ${(p.duration ? formatTime(p.duration) : '—').padStart(6)}  ${formatSize(p.size).padStart(8)}  ${p.title || p.label || ''}`);
    }
    console.log('');
  }
  return any ? 0 : 1;
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

async function planOutputs(sources, fmt, outOpt, forceFolder) {
  const ext = FORMATS[fmt].ext;
  const withExt = (file, dir) => path.join(dir ?? path.dirname(file), `${path.parse(file).name}.${ext}`);

  if (!outOpt) return sources.map((src) => ({ src, output: withExt(src.input) }));

  const outStat = await fs.stat(outOpt).catch(() => null);
  const looksLikeDir = outStat?.isDirectory() || outOpt.endsWith(path.sep) || outOpt.endsWith('/')
    || (!outStat && path.extname(outOpt) === '');

  if (sources.length === 1 && !forceFolder && !looksLikeDir) {
    return [{ src: sources[0], output: outOpt }];
  }
  if (outStat && !outStat.isDirectory()) return `--output must be a folder when converting several files.`;
  await fs.mkdir(outOpt, { recursive: true });

  const plan = sources.map((src) => ({ src, output: withExt(src.input, outOpt) }));
  const seen = new Set();
  for (const { output } of plan) {
    if (seen.has(output)) return `Two inputs would both be written to ${output}. Convert them separately or without --output.`;
    seen.add(output);
  }
  return plan;
}

/** Each split VRO gets its own folder: -o itself for one VRO, else <name> inside -o / next to the VRO. */
async function planSplitFolders(sources, outOpt) {
  if (sources.length === 0) return [];
  if (outOpt) {
    const st = await fs.stat(outOpt).catch(() => null);
    if (st && !st.isDirectory()) return `--output must be a folder when splitting recordings (${outOpt} is a file).`;
    if (sources.length === 1) return [{ src: sources[0], dir: outOpt }];
  }
  const used = new Set();
  return sources.map((src) => {
    const base = outOpt ?? path.dirname(src.input);
    let name = path.parse(src.input).name;
    // Several discs all have VR_MOVIE.VRO: prefer the disc/folder name to tell them apart.
    if (outOpt && sources.length > 1) {
      const parent = path.basename(path.dirname(src.input));
      const grand = path.basename(path.dirname(path.dirname(src.input)));
      const label = parent.toUpperCase() === 'DVD_RTAV' ? grand : parent;
      if (label && label !== '.') name = `${label} ${name}`;
    }
    let dir = path.join(base, name);
    for (let i = 2; used.has(dir); i++) dir = path.join(base, `${name} ${i}`);
    used.add(dir);
    return { src, dir };
  });
}

function drawProgress({ percent, seconds, speed }, indent) {
  const width = 30;
  const pct = percent ?? 0;
  const filled = Math.round((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pctText = percent == null ? '  ?  ' : `${pct.toFixed(1).padStart(5)}%`;
  const speedText = speed ? `  ${speed.toFixed(1)}x` : '';
  process.stderr.write(`\r${indent}${bar} ${pctText}  ${formatTime(seconds)}${speedText}\x1b[K`);
}

function formatTime(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1000 && i < units.length - 1) { bytes /= 1000; i++; }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
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
