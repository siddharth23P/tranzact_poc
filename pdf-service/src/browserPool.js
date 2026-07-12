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

  _browserAlive() {
    if (!this.browser) return false;
    // puppeteer-core v23 exposes .connected; older versions isConnected().
    return this.browser.connected ?? this.browser.isConnected?.() ?? false;
  }

  async _launchBrowser() {
    this.browser = await puppeteer.launch({
      executablePath: this.executablePath,
      headless: true,
      args: LAUNCH_ARGS,
    });
    this.idle = [];
    this.all = [];
    for (let i = 0; i < this.size; i++) {
      const page = await this.browser.newPage();
      this.all.push(page);
      this.idle.push(page);
    }
  }

  // Chaos resilience: if Chromium dies (kill -9, OOM), rebuild the whole pool
  // once — concurrent callers await the same relaunch. In-flight tasks fail
  // with an infra error (BullMQ retries them); waiters are served fresh pages.
  async _relaunch() {
    if (this.relaunching) return this.relaunching;
    logger.warn('browser gone — relaunching pool');
    this.relaunching = (async () => {
      try {
        if (this.browser) await this.browser.close();
      } catch (_) {
        /* already dead */
      }
      this.browser = null;
      await this._launchBrowser();
      logger.info('browser pool relaunched', { pages: this.all.length });
      this._dispatch();
    })().finally(() => {
      this.relaunching = null;
    });
    return this.relaunching;
  }

  async start() {
    if (this.started) return;
    logger.info('launching chromium', {
      executablePath: this.executablePath,
      poolSize: this.size,
      reservedForSingle: this.reserved,
      bulkCap: this.bulkCap,
    });
    await this._launchBrowser();
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
  // in-flight counter is balanced. Best-effort reset; a poisoned page is
  // replaced, and a dead BROWSER triggers a full pool relaunch.
  async release(page, lane = 'single') {
    if (lane === 'bulk') {
      this.bulkInFlight = Math.max(0, this.bulkInFlight - 1);
    }
    if (!this._browserAlive()) {
      await this._relaunch();
      return; // relaunch rebuilt idle pages and dispatched waiters
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
      if (!this._browserAlive()) {
        await this._relaunch();
        return;
      }
      const idx = this.all.indexOf(page);
      try {
        page = await this.browser.newPage();
        if (idx >= 0) {
          this.all[idx] = page;
        } else if (this.all.length < this.size) {
          this.all.push(page);
        } else {
          // A stale page from before a relaunch — the pool is already full.
          try { await page.close(); } catch (_) { /* ignore */ }
          this._dispatch();
          return;
        }
      } catch (err2) {
        if (!this._browserAlive()) {
          await this._relaunch();
          return;
        }
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
