'use strict';

// Lazy zip fallback. Built on FIRST request for a terminal job, streamed
// (artifact-by-artifact) into S3 as archives/{jobId}.zip, then cached — later
// requests redirect straight to the cached object's presigned URL.
//
// Streaming discipline: artifacts are appended to the zip ONE AT A TIME — each
// S3 read stream is piped through archiver into the S3 upload stream, and the
// next object is only opened after the previous entry is fully written. Peak
// memory is one compression window, not the sum of the files.
//
// Concurrency: a Redis SET NX lock ensures a single builder per job. Losers of
// the race poll for the cached object instead of building a duplicate.

const { PassThrough } = require('stream');
const archiver = require('archiver');
const logger = require('./logger');
const s3 = require('./s3');
const { getRedis } = require('./redis');
const { buildManifestPayload } = require('./delivery');

const LOCK_TTL_SECONDS = 300;
const WAIT_POLL_MS = 1000;
const WAIT_MAX_MS = 60000;

function lockKey(jobId) {
  return `archive:${jobId}:building`;
}

function sanitizeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

// Append one entry and resolve when archiver has fully consumed it.
function appendAndWait(archive, source, opts) {
  return new Promise((resolve, reject) => {
    const onEntry = (entry) => {
      if (entry.name === opts.name) {
        archive.off('entry', onEntry);
        archive.off('error', onError);
        resolve();
      }
    };
    const onError = (err) => {
      archive.off('entry', onEntry);
      reject(err);
    };
    archive.on('entry', onEntry);
    archive.once('error', onError);
    archive.append(source, opts);
  });
}

// Build the zip for a terminal job and store it at archives/{jobId}.zip.
async function buildArchive(job) {
  const payload = await buildManifestPayload(job, { withUrls: false });
  const key = s3.archiveKey(job.id);

  const archive = archiver('zip', { zlib: { level: 6 } });
  const pass = new PassThrough();
  archive.pipe(pass);
  const uploadDone = s3.uploadStream(key, pass, 'application/zip');

  // MANIFEST.json first: hashes for every rendered file, error entries for
  // failed documents — so a partial (99/100) archive is self-describing.
  await appendAndWait(archive, Buffer.from(JSON.stringify(payload, null, 2)), {
    name: 'MANIFEST.json',
  });

  for (const doc of payload.documents) {
    if (doc.status !== 'rendered') continue; // failures are noted in MANIFEST.json
    const name = `${String(doc.index).padStart(3, '0')}_${sanitizeName(doc.documentId) || 'document'}.pdf`;
    const stream = await s3.getObjectStream(s3.artifactKey(job.id, doc.index));
    await appendAndWait(archive, stream, { name });
  }

  await archive.finalize();
  await uploadDone;
  logger.info('archive built', { jobId: job.id, key, entries: payload.documents.length });
  return key;
}

// Ensure the archive exists (build-once semantics). Returns the S3 key.
async function ensureArchive(job) {
  const key = s3.archiveKey(job.id);
  if (await s3.objectExists(key)) return key;

  const redis = getRedis();
  const acquired = await redis.set(lockKey(job.id), '1', 'EX', LOCK_TTL_SECONDS, 'NX');

  if (acquired === 'OK') {
    try {
      // Re-check under the lock (a previous builder may have just finished).
      if (!(await s3.objectExists(key))) await buildArchive(job);
      return key;
    } finally {
      await redis.del(lockKey(job.id)).catch(() => {});
    }
  }

  // Another request is building — wait for the object to appear.
  const deadline = Date.now() + WAIT_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    if (await s3.objectExists(key)) return key;
    // If the builder died (lock expired) take over.
    if (!(await redis.exists(lockKey(job.id)))) return ensureArchive(job);
  }
  throw new Error('timed out waiting for archive build');
}

module.exports = { ensureArchive, buildArchive };
