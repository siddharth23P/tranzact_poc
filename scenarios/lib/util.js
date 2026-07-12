'use strict';

// Shared helpers for the stress/chaos scenario scripts.

const { exec } = require('child_process');

const PDF_API = process.env.PDF_API || 'http://localhost:3000';
const PROVENANCE = process.env.PROVENANCE || 'unlabeled';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sortedAsc, q) {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((q / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

// Deterministic small PO for load tests.
function loadDoc(id, rows = 5) {
  const lineItems = [];
  for (let n = 0; n < rows; n++) {
    lineItems.push({
      description: `Load item ${n + 1} of ${rows} for ${id}`,
      quantity: (n % 5) + 1,
      unitPrice: Number(((n % 40) + 1.25).toFixed(2)),
    });
  }
  return {
    documentId: id,
    type: 'purchase_order',
    poNumber: `PO-${id}`,
    vendor: { name: 'Load Test Vendor' },
    buyer: { name: 'Load Test Buyer' },
    currency: 'USD',
    lineItems,
  };
}

async function submitJob(documents, idempotencyKey) {
  const res = await fetch(`${PDF_API}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(idempotencyKey ? { idempotencyKey } : {}), documents }),
  });
  const json = await res.json();
  if (res.status !== 201) throw new Error(`POST /jobs -> ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function getJob(id) {
  const res = await fetch(`${PDF_API}/jobs/${id}`);
  if (!res.ok) throw new Error(`GET /jobs/${id} -> ${res.status}`);
  return res.json();
}

async function getManifest(id) {
  const res = await fetch(`${PDF_API}/jobs/${id}/manifest`);
  if (!res.ok) throw new Error(`manifest ${id} -> ${res.status}`);
  return res.json();
}

const TERMINAL = new Set(['completed', 'completed_with_errors', 'failed']);

// Tight poll to terminal; returns { job, ms } from call start.
async function pollTerminal(id, { intervalMs = 100, timeoutMs = 300000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const job = await getJob(id);
    if (TERMINAL.has(job.status)) return { job, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { job, ms: Date.now() - t0, timedOut: true };
    await sleep(intervalMs);
  }
}

// Time-to-presigned-URL for a single-doc job: submit, tight-poll to terminal,
// fetch manifest, confirm the URL is present. Returns total ms from submit.
async function timeToUrl(doc, { intervalMs = 100, timeoutMs = 120000 } = {}) {
  const t0 = Date.now();
  const job = await submitJob([doc]);
  const { job: fin, timedOut } = await pollTerminal(job.id, { intervalMs, timeoutMs });
  if (timedOut) return { ms: Date.now() - t0, ok: false, reason: 'timeout', jobId: job.id };
  if (fin.status !== 'completed') return { ms: Date.now() - t0, ok: false, reason: fin.status, jobId: job.id };
  const manifest = await getManifest(job.id);
  const url = manifest.documents[0]?.url;
  return { ms: Date.now() - t0, ok: !!url, reason: url ? null : 'no-url', jobId: job.id };
}

// Memory sampler. MEM_CMD is a shell command printing the worker's memory use;
// output may be plain bytes, "NNN kB" (Vm* from /proc), or docker-style
// "1.234GiB / 2GiB". Sampled every intervalMs; returns peak/steady stats.
// Default targets the compose worker's cgroup v2 file; override via env.
const DEFAULT_MEM_CMD =
  'docker compose exec -T worker cat /sys/fs/cgroup/memory.current 2>/dev/null || docker compose exec -T worker cat /sys/fs/cgroup/memory/memory.usage_in_bytes';

function parseMemBytes(out) {
  const s = String(out).trim().split('\n').pop().trim();
  const m = s.match(/([\d.]+)\s*(GiB|MiB|KiB|kB|B)?/i);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  const unit = (m[2] || 'B').toLowerCase();
  const mult = { gib: 1024 ** 3, mib: 1024 ** 2, kib: 1024, kb: 1024, b: 1 }[unit] ?? 1;
  return v * mult;
}

function startMemSampler({ cmd = process.env.MEM_CMD || DEFAULT_MEM_CMD, intervalMs = 1000 } = {}) {
  const samples = [];
  let failures = 0;
  const timer = setInterval(() => {
    exec(cmd, { timeout: 3000 }, (err, stdout) => {
      if (err) { failures++; return; }
      const bytes = parseMemBytes(stdout);
      if (Number.isFinite(bytes)) samples.push(bytes);
    });
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      if (samples.length === 0) return { available: false, failures };
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        available: true,
        count: samples.length,
        peakMiB: (sorted[sorted.length - 1] / 1024 ** 2).toFixed(0),
        steadyMiB: (percentile(sorted, 50) / 1024 ** 2).toFixed(0),
        failures,
      };
    },
  };
}

function mdRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  PDF_API,
  PROVENANCE,
  sleep,
  percentile,
  loadDoc,
  submitJob,
  getJob,
  getManifest,
  pollTerminal,
  timeToUrl,
  startMemSampler,
  mdRow,
  today,
};
