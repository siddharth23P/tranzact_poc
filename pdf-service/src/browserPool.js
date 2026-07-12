'use strict';

// BrowserPool: one warm Chromium, a fixed pool of N reusable pages, handed out
// page-per-task, lane-aware.
//
// RESERVATION INVARIANT (structural, not by convention):
//   pool size = N; k pages reserved for the 'single' lane; the pool grants a
//   'bulk' page only while bulkInFlight < N-k, so bulk NEVER holds more than
//   N-k pages concurrently and >= k pages are always available to 'single' —
//   enforced HERE on acquire (with an assert), independent of BullMQ worker
//   concurrency settings. See docs/queueing.md.
//
// 'single' waiters are always served before 'bulk' when a page frees, so a
// single task never queues behind bulk work.

const assert = require('assert');
const puppeteer = require('puppeteer-core');
const config = require('./config');
const logger = require('./logger');

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // avoid /dev/shm exhaustion in containers
  '--disable-gpu',
];

class BrowserPool {
  constructor({
    size = config.render.poolSize,
    reserved = config.render.singleReserved,
    executablePath = config.render.chromiumPath,
  } = {}) {
    this.size = size;
    this.reserved = Math.min(reserved, size); // k <= N
    this.bulkCap = Math.max(0, size - this.reserved); // N - k
    this.executablePath = executablePath;

    this.browser = null;
    this.idle = []; // available pages
    this.all = []; // every page (for teardown)
    this.singleWaiters = []; // resolve fns awaiting a page (fast lane)
    this.bulkWaiters = []; // resolve fns awaiting a page (bulk lane)
    this.bulkInFlight = 0; // pages currently held by bulk tasks
    this.started = false;
  }

  async start() {
    if (this.started) return;
    logger.info('launching chromium', {
      executablePath: this.executablePath,
      poolSize: this.size,
      reservedForSingle: this.reserved,
      bulkCap: this.bulkCap,
    });
    this.browser = await puppeteer.launch({
      executablePath: this.executablePath,
      headless: true,
      args: LAUNCH_ARGS,
    });
    for (let i = 0; i < this.size; i++) {
      const page = await this.browser.newPage();
      this.all.push(page);
      this.idle.push(page);
    }
    this.started = true;
    logger.info('browser pool ready', { pages: this.all.length });
  }

  // Acquire a page for the given lane ('single' | 'bulk'). Resolves when a page
  // is available AND (for bulk) the reservation permits it.
  acquire(lane = 'single') {
    return new Promise((resolve) => {
      if (lane === 'bulk') this.bulkWaiters.push(resolve);
      else this.singleWaiters.push(resolve);
      this._dispatch();
    });
  }

  // Assign idle pages to waiters, single lane first, bulk only while under cap.
  _dispatch() {
    while (this.singleWaiters.length > 0 && this.idle.length > 0) {
      const resolve = this.singleWaiters.shift();
      resolve(this.idle.pop());
    }
    while (
      this.bulkWaiters.length > 0 &&
      this.idle.length > 0 &&
      this.bulkInFlight < this.bulkCap
    ) {
      const resolve = this.bulkWaiters.shift();
      this.bulkInFlight += 1;
      // Structural invariant check: bulk can never exceed its cap.
      assert(this.bulkInFlight <= this.bulkCap, 'bulk in-flight exceeded N-k');
      resolve(this.idle.pop());
    }
  }

  // Return a page to the pool. `lane` MUST match the acquire lane so bulk's
  // in-flight counter is balanced. Best-effort reset; a page that fails to
  // reset is replaced so it can't wedge the pool.
  async release(page, lane = 'single') {
    if (lane === 'bulk') {
      this.bulkInFlight = Math.max(0, this.bulkInFlight - 1);
    }
    try {
      await page.goto('about:blank');
    } catch (err) {
      logger.warn('page reset failed, replacing', { error: err.message });
      try {
        await page.close();
      } catch (_) {
        /* ignore */
      }
      const idx = this.all.indexOf(page);
      try {
        page = await this.browser.newPage();
        if (idx >= 0) this.all[idx] = page;
        else this.all.push(page);
      } catch (err2) {
        logger.error('failed to replace page', { error: err2.message });
        this._dispatch();
        return;
      }
    }
    this.idle.push(page);
    this._dispatch();
  }

  // Observability / test hook.
  stats() {
    return {
      size: this.size,
      reserved: this.reserved,
      bulkCap: this.bulkCap,
      idle: this.idle.length,
      bulkInFlight: this.bulkInFlight,
      singleWaiting: this.singleWaiters.length,
      bulkWaiting: this.bulkWaiters.length,
    };
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.started = false;
    this.idle = [];
    this.all = [];
    this.singleWaiters = [];
    this.bulkWaiters = [];
    this.bulkInFlight = 0;
  }
}

module.exports = { BrowserPool };
