'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const config = require('./config');

// Path-style S3 client pointed at MinIO locally (or real S3 in prod).
const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
});

const BUCKET = config.s3.bucket;

// Snapshot key convention: bulk consistency depends on this being the ONLY
// source workers render from.
function snapshotKey(jobId) {
  return `snapshots/${jobId}.json`;
}

// Write the full validated payload to S3 BEFORE enqueue. Workers render only
// from this snapshot, never from live data.
async function putSnapshot(jobId, payload) {
  const key = snapshotKey(jobId);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/json',
    })
  );
  return { key, byteSize: body.length };
}

// Artifact key convention: one PDF per document task.
function artifactKey(jobId, documentIndex) {
  return `artifacts/${jobId}/${documentIndex}.pdf`;
}

// Upload a rendered PDF. Returns the key + byte size.
async function putArtifact(jobId, documentIndex, pdfBuffer) {
  const key = artifactKey(jobId, documentIndex);
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
    })
  );
  return { key, byteSize: pdfBuffer.length };
}

// Presigned GET URL for delivering an artifact without proxying bytes.
async function presignGet(key, expiresIn = config.render.presignExpirySeconds) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

async function getObjectString(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body.transformToString('utf8');
}

// Readable stream of an object's bytes (used to stream artifacts into the zip
// without buffering whole files).
async function getObjectStream(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body; // Node Readable
}

async function headObject(key) {
  return client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

// True if the object exists (HEAD succeeds), false on 404/NotFound.
async function objectExists(key) {
  try {
    await headObject(key);
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

// Archive (lazy zip) key convention.
function archiveKey(jobId) {
  return `archives/${jobId}.zip`;
}

// Streaming upload (lib-storage handles buffering into parts) — the zip is
// piped in as it is built, never fully materialized in memory.
async function uploadStream(key, bodyStream, contentType) {
  const upload = new Upload({
    client,
    params: { Bucket: BUCKET, Key: key, Body: bodyStream, ContentType: contentType },
  });
  await upload.done();
  return { key };
}

module.exports = {
  client,
  BUCKET,
  snapshotKey,
  putSnapshot,
  artifactKey,
  putArtifact,
  archiveKey,
  presignGet,
  getObjectString,
  getObjectStream,
  headObject,
  objectExists,
  uploadStream,
};
