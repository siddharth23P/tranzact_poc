'use strict';

const IORedis = require('ioredis');
const config = require('./config');

// Shared ioredis connection. BullMQ requires maxRetriesPerRequest=null on the
// connection it uses for blocking commands; we reuse the same options here for
// the progress-counter client.
function buildConnectionOptions() {
  return {
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null,
  };
}

let client = null;
function getRedis() {
  if (!client) {
    client = new IORedis(buildConnectionOptions());
    client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'error', msg: 'redis error', error: err.message }));
    });
  }
  return client;
}

async function close() {
  if (client) {
    await client.quit();
    client = null;
  }
}

module.exports = { getRedis, buildConnectionOptions, close };
