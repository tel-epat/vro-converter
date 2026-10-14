const $ = (sel, root = document) => root.querySelector(sel);
const formatSel = $('#format');
const qualitySel = $('#quality');
const deintSel = $('#deinterlace');
const modeSel = $('#mode');
const drop = $('#drop');
const fileInput = $('#file');
const list = $('#jobs');
const banner = $('#banner');
const indexNote = $('#index-note');
const jobTpl = $('#job-tpl');
const recTpl = $('#rec-tpl');

const SETTINGS_KEY = 'vroconv.settings';
const cards = new Map(); // job id or temp id -> card
let uploadChain = Promise.resolve();
let pendingIndex = null; // an index dropped on its own, waiting for its VRO

const isIfo = (name) => /\.ifo$/i.test(name);

init();

async function init() {
  try {
    const res = await fetch('/api/formats');
    if (!res.ok) throw new Error((await res.json()).error);
    const opts = await res.json();
    fill(formatSel, opts.formats.map((f) => ({
      id: f.id,
      label: f.available ? f.label : `${f.label} (not supported by your ffmpeg)`,
      disabled: !f.available,
    })));
    fill(qualitySel, opts.qualities);
    fill(deintSel, opts.deinterlace);
    restoreSettings(opts.defaultFormat);
  } catch (err) {
    showBanner(`Could not reach the converter: ${err.message}. Is "npm start" still running?`);
    return;
  }

  // Restore jobs if the page was reloaded while the server kept running.
  const existing = await fetch('/api/jobs').then((r) => r.json()).catch(() => []);
  existing.sort((a, b) => a.createdAt - b.createdAt).forEach((job) => {
    const card = addCard(job.id, job.name);
    render(card, job);
    if (!isFinal(job.status)) poll(job.id);
  });
}

function fill(select, items) {
  select.replaceChildren(...items.map((it) => {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.label;
    o.disabled = !!it.disabled;
    return o;
  }));
}

function restoreSettings(defaultFormat) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* storage unavailable */ }
  const pick = (sel, value) => {
    const opt = [...sel.options].find((o) => o.value === value && !o.disabled);
    if (opt) sel.value = value;
  };
  pick(formatSel, defaultFormat);
  pick(formatSel, saved.format);
  pick(qualitySel, 'balanced');
  pick(qualitySel, saved.quality);
  pick(deintSel, 'auto');
  pick(deintSel, saved.deinterlace);
  pick(modeSel, saved.mode);
}

[formatSel, qualitySel, deintSel, modeSel].forEach((sel) => sel.addEventListener('change', () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      format: formatSel.value, quality: qualitySel.value, deinterlace: deintSel.value, mode: modeSel.value,
    }));
  } catch { /* storage unavailable */ }
}));

// ---- file selection (files or whole folders) ----
fileInput.addEventListener('change', () => {
  addFiles([...fileInput.files]);
  fileInput.value = '';
});
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => {
  e.preventDefault();
  drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  const entries = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  const files = entries.length ? await filesFromEntries(entries) : [...e.dataTransfer.files];
  addFiles(files);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/** Expand dropped folders (e.g. DVD_RTAV) into the files they contain. */
async function filesFromEntries(entries) {
  const out = [];
  async function walk(entry, depth) {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory && depth < 4) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, depth + 1);
      }
    }
  }
  for (const entry of entries) await walk(entry, 0);
  // From a disc folder take only the video and its index, not .BUP backups or menus.
  const relevant = out.filter((f) => /\.(vro|ifo)$/i.test(f.name) && !/\.bup$/i.test(f.name));
  const fromFolder = entries.some((en) => en.isDirectory);
  return fromFolder ? relevant.filter((f) => !isIfo(f.name) || /^VR_MANGR\.IFO$/i.test(f.name)) : out;
}

async function addFiles(files) {
  hideBanner();
  const indexes = files.filter((f) => isIfo(f.name));
  const videos = files.filter((f) => !isIfo(f.name));

  if (indexes.length > 1) {
    showBanner('Several VR_MANGR.IFO files were dropped. Add one disc at a time so each video gets its own index.');
    return;
  }

  let index = null;
  if (indexes.length === 1) {
    index = await uploadIndex(indexes[0]);
    if (!index) return;
  } else if (pendingIndex && videos.length === 1) {
    index = pendingIndex;
  }

  if (videos.length === 0) {
    if (index) {
      pendingIndex = index;
      showIndexNote(index);
    }
    return;
  }
  if (index && videos.length > 1) {
    showBanner('An index (VR_MANGR.IFO) belongs to one VR_MOVIE.VRO. Drop one disc at a time to split by recording.');
    index = null;
  }
  if (index) {
    pendingIndex = null;
    hideIndexNote();
  }

  const settings = { format: formatSel.value, quality: qualitySel.value, deinterlace: deintSel.value };
  for (const file of videos) {
    const tempId = `pending-${crypto.randomUUID()}`;
    const card = addCard(tempId, file.name);
    const splitting = index && modeSel.value === 'split';
    const preview = { name: file.name, status: 'waiting', format: settings.format };
    if (splitting) {
      preview.mode = 'split';
      preview.parts = index.recordings.map((r) => ({ ...r, status: 'queued', percent: null }));
    }
    render(card, preview);
    if (!index && /^VR_MOVIE\.VRO$/i.test(file.name)) {
      setHint(card, 'Converting as one file. Add VR_MANGR.IFO from the same folder (or drop the whole DVD_RTAV folder) to get one file per recording.');
    }
    const params = { ...settings };
    if (index) Object.assign(params, { ifo: index.id, mode: modeSel.value });
    uploadChain = uploadChain.then(() => upload(file, params, card, tempId, preview));
  }
}

async function uploadIndex(file) {
  try {
    const res = await fetch('/api/ifo', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    if (body.cprm) showBanner('This disc is marked copy-protected (CPRM). Protected TV recordings cannot be converted; your own recordings usually can.');
    return body;
  } catch (err) {
    showBanner(`${file.name}: ${err.message}`);
    return null;
  }
}

function upload(file, params, card, tempId, preview) {
  if (card.cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    const query = new URLSearchParams({ name: file.name, ...params });
    const xhr = new XMLHttpRequest();
    card.xhr = xhr;
    xhr.open('POST', `/api/jobs?${query}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) render(card, { ...preview, status: 'uploading', progress: { percent: (e.loaded / e.total) * 100 } });
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
      if (xhr.status === 201) {
        cards.delete(tempId);
        cards.set(body.id, card);
        card.id = body.id;
        render(card, body);
        poll(body.id);
      } else {
        render(card, { name: file.name, status: 'error', error: body.error || `Upload failed (${xhr.status})` });
      }
      resolve();
    };
    xhr.onerror = () => {
      render(card, { name: file.name, status: 'error', error: 'Upload failed — is the server still running?' });
      resolve();
    };
    xhr.onabort = () => resolve();
    xhr.send(file);
  });
}

async function poll(id) {
  const card = cards.get(id);
  if (!card) return;
  try {
    const res = await fetch(`/api/jobs/${id}`);
    if (res.status === 404) return;
    const job = await res.json();
    render(card, job);
    if (isFinal(job.status)) return;
  } catch { /* transient; retry */ }
  setTimeout(() => poll(id), 700);
}

const isFinal = (s) => ['done', 'error', 'cancelled'].includes(s);

// ---- rendering ----
function addCard(id, name) {
  const el = jobTpl.content.firstElementChild.cloneNode(true);
  const card = { el, id, rows: [] };
  $('.name', el).textContent = name;
  $('.remove', el).addEventListener('click', () => removeCard(card));
  list.prepend(el);
  cards.set(id, card);
  return card;
}

async function removeCard(card) {
  card.cancelled = true;
  card.xhr?.abort();
  if (card.id && !card.id.startsWith('pending-')) {
    await fetch(`/api/jobs/${card.id}`, { method: 'DELETE' }).catch(() => {});
  }
  cards.delete(card.id);
  card.el.remove();
}

function setHint(card, text) {
  const hint = $('.hint', card.el);
  hint.textContent = text;
  hint.hidden = !text;
}

const STATUS_TEXT = {
  waiting: 'Waiting to upload',
  uploading: 'Uploading',
  queued: 'Queued',
  converting: 'Converting',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
};

function render(card, job) {
  const { el } = card;
  const pct = job.progress?.percent;
  const parts = job.parts;
  el.className = `job ${job.status}`;
  if (job.status === 'converting' && pct == null) el.classList.add('indeterminate');

  if (parts) {
    el.querySelector('.out').textContent = `${parts.length} recording${parts.length === 1 ? '' : 's'}`;
  } else if (job.outputName) {
    el.querySelector('.out').textContent = job.outputName;
  } else if (job.format) {
    el.querySelector('.out').textContent = `.${job.format}`;
  }

  let fill = 0;
  if (job.status === 'uploading' || job.status === 'converting') fill = pct ?? 0;
  if (job.status === 'done') fill = 100;
  $('.fill', el).style.width = `${fill}%`;

  let status = STATUS_TEXT[job.status] || job.status;
  if (job.status === 'converting' && parts) {
    const current = parts.findIndex((p) => p.status === 'converting');
    if (current >= 0) status = `Converting ${current + 1} of ${parts.length}`;
  }
  if ((job.status === 'uploading' || job.status === 'converting') && pct != null) status += ` · ${pct.toFixed(0)}%`;
  if (job.status === 'done' && parts) {
    const failed = parts.filter((p) => p.status === 'error').length;
    if (failed) status = `Done — ${failed} of ${parts.length} failed`;
  }
  $('.status', el).textContent = status;

  let detail = '';
  if (job.status === 'converting' && job.progress) {
    const p = job.progress;
    detail = `${time(p.seconds)}${p.duration ? ` / ${time(p.duration)}` : ''}${p.speed ? ` · ${p.speed.toFixed(1)}× realtime` : ''}`;
  } else if (job.status === 'done') {
    const v = job.info?.video;
    detail = [job.outputSize && size(job.outputSize), v && `${v.width}×${v.height}`, job.info?.duration && time(job.info.duration)]
      .filter(Boolean).join(' · ');
  } else if (job.status === 'error') {
    detail = job.error || '';
  }
  $('.detail', el).textContent = detail;

  const dl = $('.download', el);
  dl.hidden = job.status !== 'done';
  dl.textContent = parts ? 'Download all (.zip)' : 'Download';
  if (job.status === 'done') {
    dl.href = `/api/jobs/${job.id}/download`;
    dl.setAttribute('download', job.outputName);
  }
  $('.remove', el).textContent = isFinal(job.status) ? 'Remove' : 'Cancel';

  if (parts) {
    $('.hint', el).hidden = true;
    renderParts(card, job);
  }
}

const PART_TEXT = { queued: 'Waiting', converting: 'Converting', done: 'Done', error: 'Failed' };

function renderParts(card, job) {
  const box = $('.recs', card.el);
  const ol = $('.rec-list', card.el);
  box.hidden = false;
  if (card.rows.length !== job.parts.length) {
    card.rows = job.parts.map(() => recTpl.content.firstElementChild.cloneNode(true));
    ol.replaceChildren(...card.rows);
  }
  const total = job.parts.reduce((s, p) => s + (p.duration ?? 0), 0);
  const first = job.parts.find((p) => p.recorded)?.recorded?.slice(0, 10);
  const last = [...job.parts].reverse().find((p) => p.recorded)?.recorded?.slice(0, 10);
  const span = first ? ` · ${first}${last && last !== first ? ` → ${last}` : ''}` : '';
  $('summary', box).textContent = `${job.parts.length} recordings · ${time(total)}${span}`;

  job.parts.forEach((p, i) => {
    const row = card.rows[i];
    row.className = `rec ${p.status}`;
    $('.rec-num', row).textContent = `#${p.number}`;
    $('.rec-when', row).textContent = [p.recorded ?? 'no date', p.label].filter(Boolean).join(' · ');
    $('.rec-len', row).textContent = p.duration ? time(p.duration) : '';
    let state = PART_TEXT[p.status] ?? p.status;
    if (p.status === 'converting' && p.percent != null) state += ` ${p.percent.toFixed(0)}%`;
    if (p.status === 'done' && p.size) state = size(p.size);
    $('.rec-state', row).textContent = state;
    row.title = p.error || p.fileName || '';
    const link = $('.rec-dl', row);
    link.hidden = p.status !== 'done' || !job.id;
    if (!link.hidden) {
      link.href = `/api/jobs/${job.id}/parts/${p.number}/download`;
      link.setAttribute('download', p.fileName);
    }
  });
}

function time(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function size(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function showIndexNote(index) {
  const n = index.recordings.length;
  const dates = index.recordings.map((r) => r.recorded).filter(Boolean);
  const span = dates.length ? `, recorded ${dates[0].slice(0, 10)}${dates.at(-1).slice(0, 10) !== dates[0].slice(0, 10) ? ` → ${dates.at(-1).slice(0, 10)}` : ''}` : '';
  indexNote.replaceChildren(
    document.createTextNode(`Index loaded: ${n} recording${n === 1 ? '' : 's'}${span}. Now add VR_MOVIE.VRO from the same folder.`),
  );
  const clear = document.createElement('button');
  clear.className = 'btn';
  clear.type = 'button';
  clear.textContent = 'Forget index';
  clear.addEventListener('click', () => { pendingIndex = null; hideIndexNote(); });
  indexNote.append(clear);
  indexNote.hidden = false;
}

function hideIndexNote() { indexNote.hidden = true; }
function showBanner(msg) { banner.textContent = msg; banner.hidden = false; }
function hideBanner() { banner.hidden = true; }
