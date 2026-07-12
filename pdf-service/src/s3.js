'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
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

async function getObjectString(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body.transformToString('utf8');
}

async function headObject(key) {
  return client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { client, BUCKET, snapshotKey, putSnapshot, getObjectString, headObject };
