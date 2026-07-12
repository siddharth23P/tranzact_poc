'use strict';

// Per-task strategy selection. A document renders via ChunkedMerge when its
// line-item count exceeds CHUNK_THRESHOLD, otherwise SinglePass. The threshold
// is env-tunable (set from stress data); the choice is made per document, not
// per job — a bulk job can mix single-pass and chunked tasks.

const config = require('../config');
const singlePass = require('./singlePass');
const chunkedMerge = require('./chunkedMerge');

function chooseStrategy(doc, { threshold = config.render.chunkThreshold } = {}) {
  const count = Array.isArray(doc.lineItems) ? doc.lineItems.length : 0;
  return count > threshold ? chunkedMerge : singlePass;
}

// Render `doc` with the selected strategy on the pooled `page`.
async function renderWithSelectedStrategy(page, doc) {
  const strategy = chooseStrategy(doc);
  const pdf =
    strategy.name === 'ChunkedMerge'
      ? await strategy.render(page, doc, { chunkSize: config.render.chunkSize })
      : await strategy.render(page, doc);
  return { pdf, strategy: strategy.name };
}

module.exports = { chooseStrategy, renderWithSelectedStrategy };
