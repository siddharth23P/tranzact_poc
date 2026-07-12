'use strict';

// Minimal S3 endpoint for docker-free local verification, standing in for
// MinIO (whose image is unpullable in the authoring environment). Requires
// s3rver to be installed (npm i -g s3rver, or npx s3rver).
//
// NOTE: s3rver enforces FIXED credentials S3RVER / S3RVER — set
//   S3_ACCESS_KEY=S3RVER S3_SECRET_KEY=S3RVER
// for the app when pointing it here. The real compose stack uses MinIO with
// minioadmin/minioadmin instead. See docs/dead-ends.md.

const fs = require('fs');
const S3rver = require('s3rver');

const dir = process.env.S3RVER_DIR || '/tmp/s3data';
const bucket = process.env.S3_BUCKET || 'pdf-artifacts';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

new S3rver({
  port: 9000,
  address: '0.0.0.0',
  silent: true,
  directory: dir,
  configureBuckets: [{ name: bucket, configs: [] }],
})
  .run()
  .then(() => console.log(`s3rver on :9000 (bucket ${bucket})`))
  .catch((e) => {
    console.error('s3rver failed', e);
    process.exit(1);
  });
