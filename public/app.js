const $ = (sel) => document.querySelector(sel);
const formatSel = $('#format');
const qualitySel = $('#quality');
const deintSel = $('#deinterlace');
const drop = $('#drop');
const fileInput = $('#file');
const list = $('#jobs');
const banner = $('#banner');
const tpl = $('#job-tpl');

const SETTINGS_KEY = 'vroconv.settings';
const cards = new Map(); // job id or temp id -> { el, job }
let uploadChain = Promise.resolve();

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
}

[formatSel, qualitySel, deintSel].forEach((sel) => sel.addEventListener('change', () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      format: formatSel.value, quality: qualitySel.value, deinterlace: deintSel.value,
    }));
  } catch { /* storage unavailable */ }
}));

// ---- file selection ----
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
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});
// Prevent the browser from opening a file dropped outside the drop zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function addFiles(files) {
  hideBanner();
  const settings = { format: formatSel.value, quality: qualitySel.value, deinterlace: deintSel.value };
  for (const file of files) {
    const tempId = `pending-${crypto.randomUUID()}`;
    const card = addCard(tempId, file.name);
    render(card, { name: file.name, status: 'waiting', format: settings.format });
    // Upload one file at a time; the server converts them in order.
    uploadChain = uploadChain.then(() => upload(file, settings, card, tempId));
  }
}

function upload(file, settings, card, tempId) {
  if (card.cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    const params = new URLSearchParams({ name: file.name, ...settings });
    const xhr = new XMLHttpRequest();
    card.xhr = xhr;
    xhr.open('POST', `/api/jobs?${params}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        render(card, { name: file.name, status: 'uploading', format: settings.format, progress: { percent: (e.loaded / e.total) * 100 } });
      }
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
  const el = tpl.content.firstElementChild.cloneNode(true);
  const card = { el, id };
  el.querySelector('.name').textContent = name;
  el.querySelector('.remove').addEventListener('click', () => removeCard(card));
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
  el.className = `job ${job.status}`;
  if (job.status === 'converting' && pct == null) el.classList.add('indeterminate');

  if (job.outputName) el.querySelector('.out').textContent = job.outputName;
  else if (job.format) el.querySelector('.out').textContent = `.${job.format}`;

  let fill = 0;
  if (job.status === 'uploading' || job.status === 'converting') fill = pct ?? 0;
  if (job.status === 'done') fill = 100;
  el.querySelector('.fill').style.width = `${fill}%`;

  let status = STATUS_TEXT[job.status] || job.status;
  if ((job.status === 'uploading' || job.status === 'converting') && pct != null) status += ` ${pct.toFixed(0)}%`;
  el.querySelector('.status').textContent = status;

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
  el.querySelector('.detail').textContent = detail;

  const dl = el.querySelector('.download');
  dl.hidden = job.status !== 'done';
  if (job.status === 'done') {
    dl.href = `/api/jobs/${job.id}/download`;
    dl.setAttribute('download', job.outputName);
  }
  el.querySelector('.remove').textContent = isFinal(job.status) ? 'Remove' : 'Cancel';
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

function showBanner(msg) { banner.textContent = msg; banner.hidden = false; }
function hideBanner() { banner.hidden = true; }
