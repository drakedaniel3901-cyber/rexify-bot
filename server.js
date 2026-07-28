// 1. Crash Guards
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH GUARD] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] Uncaught Exception:', err);
});

try {
  require('dotenv').config();
} catch (e) {}

const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const WebSocket = require('ws');
const { KnownDevices } = require('puppeteer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || 'https://rexify.com.ng?reference=sholaupdates';
const mobileDevice = KnownDevices['iPhone 13 Pro'];

// ---------------------------------------------------------
// 2. SSE LOGGING ENGINE
// ---------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static('public'));

let sseClients = [];

function sendLog(message, type = 'normal', done = false) {
  console.log(`[LOG] ${message}`);
  const payload = JSON.stringify({ message, type, done });
  sseClients = sseClients.filter((client) => {
    try {
      client.res.write(`data: ${payload}\n\n`);
      return true;
    } catch (err) {
      return false;
    }
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// SSE Endpoint
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(': keep-alive\n\n');
  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  req.on('close', () => {
    sseClients = sseClients.filter((client) => client.id !== clientId);
  });
});

setInterval(() => {
  sseClients.forEach((client) => {
    try { client.res.write(': keep-alive\n\n'); } catch (err) {}
  });
}, 10000);

// ---------------------------------------------------------
// 3. CONNECTION POOL WITH FRAME-LEVEL WS HEARTBEAT
// ---------------------------------------------------------
class BrowserlessConnection {
  constructor({ endpoint, id, heartbeatMs = 15000, maxTasksBeforeRecycle = 300 }) {
    this.endpoint = endpoint;
    this.id = id;
    this.heartbeatMs = heartbeatMs;
    this.maxTasksBeforeRecycle = maxTasksBeforeRecycle;

    this.browser = null;
    this.rawWs = null;
    this.healthy = false;
    this.taskCount = 0;
    this.failureStreak = 0;
    this.circuitOpenUntil = 0;
    this._heartbeatTimer = null;
    this._connecting = null;
  }

  isCircuitOpen() {
    return Date.now() < this.circuitOpenUntil;
  }

  tripCircuit(ms = 10000) {
    this.circuitOpenUntil = Date.now() + ms;
    this.healthy = false;
  }

  async connect() {
    if (this._connecting) return this._connecting;
    this._connecting = this._doConnect();
    try {
      await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  async _doConnect() {
    await this._cleanup();

    sendLog(`[BROWSER ENGINE] Connecting to Browserless (${this.id})...`, 'info');

    this.browser = await puppeteer.connect({
      browserWSEndpoint: this.endpoint,
      protocolTimeout: 30000,
    });

    // Grab raw WS connection for frame-level pings
    const transport = this.browser._connection?._transport;
    this.rawWs = transport?._ws || transport?.ws || null;

    this.browser.on('disconnected', () => {
      sendLog(`[BROWSER ENGINE] ⚠️ Socket disconnected (${this.id})`, 'warn');
      this.healthy = false;
      this._stopHeartbeat();
    });

    this._startHeartbeat();
    this.healthy = true;
    this.failureStreak = 0;
    this.taskCount = 0;
    sendLog(`[BROWSER ENGINE] Connected successfully (${this.id})!`, 'info');
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this.rawWs || this.rawWs.readyState !== WebSocket.OPEN) return;
      try {
        // Raw ping prevents 60s idle timeouts on Render / Browserless proxies
        this.rawWs.ping();
      } catch (err) {
        console.error(`[HEARTBEAT ERR] ${this.id}:`, err.message);
      }
    }, this.heartbeatMs);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  needsRecycle() {
    return this.taskCount >= this.maxTasksBeforeRecycle;
  }

  async _cleanup() {
    this._stopHeartbeat();
    try {
      if (this.browser) this.browser.disconnect();
    } catch (_) {}
    this.browser = null;
    this.rawWs = null;
  }
}

class ConnectionPool {
  constructor({ endpoints, heartbeatMs = 15000 }) {
    this.endpoints = endpoints;
    this.heartbeatMs = heartbeatMs;
    this.connections = [];
    this._rrIndex = 0;
  }

  async init() {
    this.connections = this.endpoints.map(
      (endpoint, i) => new BrowserlessConnection({ endpoint, id: `conn-${i + 1}`, heartbeatMs: this.heartbeatMs })
    );

    for (const conn of this.connections) {
      conn.browser?.on('disconnected', () => this._handleDrop(conn));
      await conn.connect().catch((err) => {
        conn.tripCircuit(5000);
        sendLog(`[BROWSER ENGINE] Initial connect failed for ${conn.id}: ${err.message}`, 'warn');
      });
    }
  }

  async _handleDrop(conn) {
    if (conn._reconnecting) return;
    conn._reconnecting = true;
    sendLog(`[BROWSER ENGINE] Reconnecting dropped socket ${conn.id}...`, 'warn');
    await delay(1000);
    try {
      await conn.connect();
    } catch (err) {
      conn.tripCircuit(8000);
      setTimeout(() => this._handleDrop(conn), 8500);
    } finally {
      conn._reconnecting = false;
    }
  }

  async acquire() {
    const n = this.connections.length;
    for (let attempt = 0; attempt < n; attempt++) {
      const conn = this.connections[this._rrIndex % n];
      this._rrIndex++;

      if (conn.isCircuitOpen()) continue;

      if (conn.needsRecycle()) {
        conn.connect().catch(() => conn.tripCircuit(5000));
        continue;
      }

      if (conn.healthy && conn.browser) return conn;
    }

    // Fallback: force reconnect first connection if all are down
    const fallbackConn = this.connections[0];
    if (fallbackConn) {
      await fallbackConn.connect();
      return fallbackConn;
    }

    throw new Error('No healthy Browserless connections available');
  }
}

// ---------------------------------------------------------
// 4. CONTEXT MANAGER (LIGHTWEIGHT RUNTIME)
// ---------------------------------------------------------
class ContextManager {
  constructor({ maxConcurrentPerConnection = 5 } = {}) {
    this.maxConcurrentPerConnection = maxConcurrentPerConnection;
    this._inFlight = new Map();
  }

  async withContext(conn, fn) {
    const count = this._inFlight.get(conn.id) || 0;
    if (count >= this.maxConcurrentPerConnection) {
      throw new Error('SATURATED');
    }
    this._inFlight.set(conn.id, count + 1);

    let context, page;
    try {
      context = await conn.browser.createBrowserContext();
      page = await context.newPage();

      // High-speed resource blocking
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      conn.taskCount++;
      return await fn(page, context);
    } finally {
      try { if (page && !page.isClosed()) await page.close(); } catch (_) {}
      try { if (context) await context.close(); } catch (_) {}
      this._inFlight.set(conn.id, Math.max(0, (this._inFlight.get(conn.id) || 1) - 1));
    }
  }
}

// ---------------------------------------------------------
// 5. FAST-PATH CDP & JS HELPERS
// ---------------------------------------------------------
const FastActions = {
  async fastClick(page, selector) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
    }, selector);
  },

  async fastType(page, selector, value) {
    await page.evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(el, val) : (el.value = val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, selector, value);
  },

  async waitForAny(page, selectors, timeout = 10000) {
    return page.waitForFunction(
      (sels) => sels.some((s) => document.querySelector(s)),
      { timeout, polling: 100 },
      selectors
    );
  }
};

// ---------------------------------------------------------
// 6. RESILIENT TASK EXECUTOR
// ---------------------------------------------------------
class ResilientExecutor {
  constructor({ pool, contextManager, maxRetries = 2 }) {
    this.pool = pool;
    this.contextManager = contextManager;
    this.maxRetries = maxRetries;
  }

  isRecoverableError(err) {
    const msg = err?.message || '';
    return (
      /detached frame/i.test(msg) ||
      /target closed/i.test(msg) ||
      /session closed/i.test(msg) ||
      /websocket/i.test(msg) ||
      /protocol error/i.test(msg) ||
      msg === 'SATURATED'
    );
  }

  async run(task, taskFn) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let conn;
      try {
        conn = await this.pool.acquire();
      } catch (err) {
        lastErr = err;
        await delay(500 * (attempt + 1));
        continue;
      }

      try {
        const result = await this.contextManager.withContext(conn, (page, context) =>
          taskFn(page, context, task)
        );
        conn.failureStreak = 0;
        return result;
      } catch (err) {
        lastErr = err;
        conn.failureStreak++;

        if (conn.failureStreak >= 3) conn.tripCircuit(8000);

        if (!this.isRecoverableError(err) || attempt === this.maxRetries) {
          throw err;
        }

        sendLog(`[Worker ${task.workerId}] Recoverable glitch (${err.message}). Retrying (${attempt + 1}/${this.maxRetries})...`, 'warn');
        await delay(300 * Math.pow(2, attempt));
      }
    }
    throw lastErr;
  }
}

// ---------------------------------------------------------
// 7. REXIFY WORKFLOW FUNCTION
// ---------------------------------------------------------
function generateRandomEmail() {
  return `user_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@gmail.com`;
}

function generateRandomPassword() {
  return `Pass!${Math.random().toString(36).slice(-8)}`;
}

async function runRexifyWorkflow(page, context, task) {
  const { row, rowIndex, workerId } = task;
  const bankName = row.bankName || 'OPay';
  const accountNumber = row.accountNumber || row.account || Object.values(row)[0];
  const email = generateRandomEmail();
  const password = generateRandomPassword();

  sendLog(`[Worker ${workerId}] [Row ${rowIndex + 1}] Processing ${accountNumber} (${email})`, 'info');

  await page.emulate(mobileDevice);
  page.setDefaultTimeout(10000);

  // STEP 1: Landing Page
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 12000 });
  const getStartedBtn = await page.waitForSelector('text/Get started', { visible: true, timeout: 8000 });
  await getStartedBtn.click();

  const pages = await context.pages();
  if (pages.length > 1) {
    page = pages[pages.length - 1];
    await page.emulate(mobileDevice);
  }

  // STEP 2: Fast Registration
  await FastActions.waitForAny(page, ['input[type="email"]', 'input[name="email"]']);
  await FastActions.fastType(page, 'input[type="email"], input[name="email"]', email);
  await FastActions.fastType(page, 'input[type="password"], input[name="password"]', password);

  const checkbox = await page.$('input[type="checkbox"]');
  if (checkbox) await checkbox.click();

  const continueBtn = await page.waitForSelector('text/Continue', { visible: true, timeout: 8000 });
  await continueBtn.click();

  // STEP 3: Account Verification
  let isVerified = false;
  let verifyAttempt = 0;
  const MAX_VERIFY_ATTEMPTS = 5;

  while (!isVerified && verifyAttempt < MAX_VERIFY_ATTEMPTS) {
    verifyAttempt++;
    sendLog(`[Worker ${workerId}] Verification attempt ${verifyAttempt}/${MAX_VERIFY_ATTEMPTS} for ${accountNumber}...`);

    await FastActions.waitForAny(page, ['input[placeholder*="account number" i]', 'input[name*="account" i]']);
    await FastActions.fastType(page, 'input[placeholder*="account number" i], input[name*="account" i]', accountNumber);

    try {
      await page.select('select', bankName);
    } catch (e) {
      await page.evaluate((bName) => {
        const select = document.querySelector('select');
        if (!select) return;
        for (let option of select.options) {
          if (option.text.toLowerCase().includes(bName.toLowerCase())) {
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
      }, bankName);
    }

    const verifyBtn = await page.waitForSelector('text/Verify account', { visible: true, timeout: 8000 });
    await verifyBtn.click();

    // Fast status check loop (polling every 250ms)
    const startTime = Date.now();
    let status = 'pending';

    while (Date.now() - startTime < 6000) {
      const result = await page.evaluate(() => {
        const body = document.body.innerText || '';
        if (body.includes('Account name') || body.includes('Verified')) return 'success';
        if (body.includes('Not verified') || body.includes('Could not verify')) return 'failed';
        return 'pending';
      });

      if (result !== 'pending') {
        status = result;
        break;
      }
      await delay(250);
    }

    if (status === 'success') {
      isVerified = true;
      sendLog(`[Worker ${workerId}] Account verified successfully for ${accountNumber}!`, 'info');
    } else {
      sendLog(`[Worker ${workerId}] Verification status '${status}'. Retrying...`, 'warn');
      await delay(400);
    }
  }

  if (!isVerified) throw new Error(`Verification failed after ${MAX_VERIFY_ATTEMPTS} attempts`);

  const finishBtn = await page.waitForSelector('text/Finish & continue', { visible: true, timeout: 8000 });
  await finishBtn.click();
  await delay(1000);

  return true;
}

function parseCSVBuffer(buffer) {
  const content = buffer.toString('utf-8');
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    return row;
  });
}

// ---------------------------------------------------------
// 8. BATCH DISPATCHER & EXPRESS ROUTE
// ---------------------------------------------------------
let globalPool = null;

app.post('/api/start', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No CSV file uploaded' });

    const accountRows = parseCSVBuffer(req.file.buffer);
    if (accountRows.length === 0) return res.status(400).json({ success: false, error: 'CSV file is empty' });

    res.json({ success: true, count: accountRows.length });

    sendLog(`Loaded ${accountRows.length} account row(s). Launching Turbo Pipeline...`, 'info');

    const wsEndpoints = (process.env.BROWSERLESS_WS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (wsEndpoints.length === 0) {
      sendLog('ERROR: BROWSERLESS_WS environment variable missing!', 'error', true);
      return;
    }

    if (!globalPool) {
      globalPool = new ConnectionPool({ endpoints: wsEndpoints, heartbeatMs: 15000 });
      await globalPool.init();
    }

    const contextManager = new ContextManager({ maxConcurrentPerConnection: 5 });
    const executor = new ResilientExecutor({ pool: globalPool, contextManager, maxRetries: 2 });

    (async () => {
      let globalSuccesses = 0;
      const TARGET_SUCCESSES = 20;
      const BATCH_SIZE = 5;

      for (let i = 0; i < accountRows.length; i += BATCH_SIZE) {
        if (globalSuccesses >= TARGET_SUCCESSES) break;

        const currentBatch = accountRows.slice(i, i + BATCH_SIZE);
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

        sendLog(`--- STARTING BATCH ${batchNumber} (${currentBatch.length} parallel tasks) ---`, 'info');

        const promises = currentBatch.map(async (row, batchIdx) => {
          const workerId = batchIdx + 1;
          const rowIndex = i + batchIdx;

          await delay(batchIdx * 200);

          if (globalSuccesses >= TARGET_SUCCESSES) return false;

          try {
            const task = { row, rowIndex, workerId };
            await executor.run(task, runRexifyWorkflow);
            globalSuccesses++;
            sendLog(`SUCCESS (${globalSuccesses}/${TARGET_SUCCESSES}): Row ${rowIndex + 1} finished!`, 'info');
            return true;
          } catch (err) {
            sendLog(`[Worker ${workerId}] Row ${rowIndex + 1} failed: ${err.message}`, 'error');
            return false;
          }
        });

        await Promise.all(promises);

        if (globalSuccesses >= TARGET_SUCCESSES) {
          sendLog(`🎉 TARGET REACHED: ${TARGET_SUCCESSES} accounts completed!`, 'info', true);
          break;
        }

        await delay(500);
      }

      sendLog(`Execution complete. Final count: ${globalSuccesses}/${TARGET_SUCCESSES}`, 'info', true);
    })();

  } catch (err) {
    console.error('Fatal API Error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Rexify Dashboard backend listening on port ${PORT}`);
});