'use strict';

// BrowserPool: one warm Chromium, a fixed pool of N reusable pages, handed out
// page-per-task. Warming pages up front keeps per-render latency low (no
// per-task page creation). acquire() blocks (FIFO) when all pages are busy;
// release() returns a page to the pool after resetting it.
//
// Reserved-capacity for singles is enforced by the WORKER concurrency caps
// (bulk capped at N-k), not here — this pool just guarantees at most N pages
// are ever in flight. See docs/queueing.md.

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
  constructor({ size = config.render.poolSize, executablePath = config.render.chromiumPath } = {}) {
    this.size = size;
    this.executablePath = executablePath;
    this.browser = null;
    this.idle = []; // available pages
    this.waiters = []; // resolve fns awaiting a page
    this.all = []; // every page (for teardown)
    this.started = false;
  }

  async start() {
    if (this.started) return;
    logger.info('launching chromium', { executablePath: this.executablePath, poolSize: this.size });
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

  // Acquire a page (FIFO wait if none idle).
  acquire() {
    if (this.idle.length > 0) {
      return Promise.resolve(this.idle.pop());
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  // Return a page to the pool. Best-effort reset; if reset fails the page is
  // replaced with a fresh one so a poisoned page can't wedge the pool.
  async release(page) {
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
        return;
      }
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(page);
    else this.idle.push(page);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.started = false;
    this.idle = [];
    this.all = [];
    this.waiters = [];
  }
}

module.exports = { BrowserPool };
