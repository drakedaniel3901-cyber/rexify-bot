// 1. Crash Guards (Prevents background errors from killing Express on Render)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH GUARD] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] Uncaught Exception thrown:', err);
});

// 2. Safe dotenv initialization
try {
  require('dotenv').config();
} catch (e) {
  // Gracefully ignored when environment variables are injected directly in production
}

const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const { KnownDevices } = require('puppeteer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || 'https://rexify.com.ng?reference=sholaupdates';

const mobileDevice = KnownDevices['iPhone 13 Pro'];

// Global CORS Middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
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

// Helpers
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min = 500, max = 1800) => 
  delay(Math.floor(Math.random() * (max - min + 1)) + min);

function generateRandomEmail() {
  const randStr = Math.random().toString(36).substring(2, 8);
  return `user_${Date.now()}_${randStr}@gmail.com`;
}

function generateRandomPassword() {
  return `Pass!${Math.random().toString(36).slice(-8)}`;
}

// Ensure Page Guard
function ensurePageAlive(page) {
  if (!page || page.isClosed()) {
    throw new Error('PAGE_CLOSED_OR_DETACHED');
  }
}

// ---------------------------------------------------------
// 3. SINGLETON BROWSER CONNECTION MANAGER
// ---------------------------------------------------------
let globalBrowser = null;
let isConnecting = false;

async function getBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) {
    return globalBrowser;
  }

  while (isConnecting) {
    await delay(300);
    if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
  }

  isConnecting = true;
  let attempts = 0;
  const MAX_ATTEMPTS = 5;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      sendLog(`[BROWSER ENGINE] Connecting to Browserless (Attempt ${attempts}/${MAX_ATTEMPTS})...`, 'info');
      
      globalBrowser = await puppeteer.connect({
        browserWSEndpoint: process.env.BROWSERLESS_WS,
      });

      globalBrowser.on('disconnected', () => {
        sendLog('[BROWSER ENGINE] ⚠️ Browserless connection dropped! Engine will reconnect automatically.', 'warn');
        globalBrowser = null;
      });

      sendLog('[BROWSER ENGINE] Connected successfully to Browserless!', 'info');
      isConnecting = false;
      return globalBrowser;
    } catch (err) {
      const is429 = err.message && err.message.includes('429');
      const waitMs = is429 ? attempts * 2000 : 1500;
      sendLog(`[BROWSER ENGINE] Connection attempt failed (${err.message}). Retrying in ${waitMs / 1000}s...`, 'warn');
      await delay(waitMs);
    }
  }

  isConnecting = false;
  throw new Error('Could not establish a stable Browserless WebSocket connection.');
}

// SSE Logging Endpoint
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
    try {
      client.res.write(': keep-alive\n\n');
    } catch (err) {}
  });
}, 10000);

function parseCSVBuffer(buffer) {
  const content = buffer.toString('utf-8');
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    return row;
  });
}

// ---------------------------------------------------------
// 4. AUTOMATION ENGINE (RUNS INSIDE A FRESH BROWSER CONTEXT)
// ---------------------------------------------------------
async function runAccountWorkflow(page, context, row, rowIndex, workerId) {
  const bankName = row.bankName || 'OPay';
  const accountNumber = row.accountNumber || row.account || Object.values(row)[0];
  const randomEmail = generateRandomEmail();
  const randomPassword = generateRandomPassword();

  sendLog(`[Worker ${workerId}] [Row ${rowIndex + 1}] Processing ${accountNumber} (${randomEmail})`, 'info');

  await page.emulate(mobileDevice);
  page.setDefaultTimeout(20000);

  // STEP 1: Landing Page
  ensurePageAlive(page);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await randomDelay(400, 800);

  ensurePageAlive(page);
  const getStartedBtn = await page.waitForSelector('text/Get started', { visible: true, timeout: 12000 });
  await Promise.all([
    getStartedBtn.click(),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
  ]);

  const pages = await context.pages();
  if (pages.length > 1) {
    page = pages[pages.length - 1];
    await page.emulate(mobileDevice);
    page.setDefaultTimeout(20000);
  }

  await randomDelay(1000, 2000);

  // STEP 2: Registration
  ensurePageAlive(page);
  const emailSelector = await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { visible: true, timeout: 12000 });
  await emailSelector.type(randomEmail, { delay: 30 });

  const passSelector = await page.waitForSelector('input[type="password"], input[name="password"]', { visible: true, timeout: 10000 });
  await passSelector.type(randomPassword, { delay: 30 });

  const checkbox = await page.$('input[type="checkbox"]');
  if (checkbox) await checkbox.click();

  const continueBtn = await page.waitForSelector('text/Continue', { visible: true, timeout: 12000 });
  await randomDelay(400, 800);
  await Promise.all([
    continueBtn.click(),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
  ]);

  await randomDelay(2000, 3500);

  // STEP 3: Withdrawal Setup & 7x Retry Verification Loop
  let isVerified = false;
  let verifyAttempt = 0;
  const MAX_VERIFY_ATTEMPTS = 7;

  while (!isVerified && verifyAttempt < MAX_VERIFY_ATTEMPTS) {
    verifyAttempt++;
    ensurePageAlive(page);
    sendLog(`[Worker ${workerId}] Verification attempt ${verifyAttempt}/${MAX_VERIFY_ATTEMPTS} for ${accountNumber}...`);

    const accountInput = await page.waitForSelector('input[placeholder*="account number" i], input[name*="account" i]', { visible: true, timeout: 12000 });
    await accountInput.click({ clickCount: 3 });
    await accountInput.press('Backspace');
    await randomDelay(200, 400);
    await accountInput.type(accountNumber, { delay: 30 });

    try {
      await page.select('select', bankName);
    } catch (e) {
      await page.evaluate((bName) => {
        const select = document.querySelector('select');
        if (!select) return;
        for (let option of select.options) {
          if (
            option.text.toLowerCase().includes(bName.toLowerCase()) ||
            option.value.toLowerCase().includes(bName.toLowerCase())
          ) {
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
      }, bankName);
    }

    const verifyBtn = await page.waitForSelector('text/Verify account', { visible: true, timeout: 12000 });
    await randomDelay(300, 600);
    await verifyBtn.click();

    // Fast DOM Polling (500ms intervals)
    const startTime = Date.now();
    let status = 'pending';

    while (Date.now() - startTime < 10000) {
      ensurePageAlive(page);
      const result = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        if (bodyText.includes('Account name') || bodyText.includes('Verified')) return 'success';
        if (bodyText.includes('Not verified') || bodyText.includes('Could not verify')) return 'failed';
        return 'pending';
      });

      if (result !== 'pending') {
        status = result;
        break;
      }
      await delay(500);
    }

    if (status === 'success') {
      isVerified = true;
      sendLog(`[Worker ${workerId}] Account verified successfully for ${accountNumber}!`, 'info');
    } else {
      sendLog(`[Worker ${workerId}] Verification returned '${status}' on attempt ${verifyAttempt}. Re-inputting...`, 'warn');
      await randomDelay(1000, 2000);
    }
  }

  if (!isVerified) {
    throw new Error(`Failed account verification after ${MAX_VERIFY_ATTEMPTS} attempts.`);
  }

  // Finish & Continue
  ensurePageAlive(page);
  const finishBtn = await page.waitForSelector('text/Finish & continue', { visible: true, timeout: 12000 });
  await randomDelay(500, 1000);
  await finishBtn.click();

  sendLog(`[Worker ${workerId}] Clicked 'Finish & continue'. Stabilizing account (15s)...`);
  await delay(15000);

  return true;
}

// ---------------------------------------------------------
// 5. WORKER HANDLER WITH CONTEXT RETRY GUARD
// ---------------------------------------------------------
async function processAccount(row, rowIndex, workerId) {
  const accountNumber = row.accountNumber || row.account || Object.values(row)[0];
  let accountAttempts = 0;
  const MAX_ACCOUNT_ATTEMPTS = 3;

  while (accountAttempts < MAX_ACCOUNT_ATTEMPTS) {
    accountAttempts++;
    let context = null;

    try {
      const browser = await getBrowser();
      context = await browser.createBrowserContext();
      const page = await context.newPage();

      const success = await runAccountWorkflow(page, context, row, rowIndex, workerId);
      return success;

    } catch (err) {
      const errMsg = err.message || '';
      const isRecoverable = 
        errMsg.includes('detached') || 
        errMsg.includes('Target closed') || 
        errMsg.includes('Protocol error') || 
        errMsg.includes('PAGE_CLOSED') ||
        errMsg.includes('Execution context');

      if (isRecoverable && accountAttempts < MAX_ACCOUNT_ATTEMPTS) {
        sendLog(`[Worker ${workerId}] Recoverable browser error for account ${accountNumber} (${errMsg}). Creating new Browser Context (Attempt ${accountAttempts}/${MAX_ACCOUNT_ATTEMPTS})...`, 'warn');
        await delay(1500);
      } else {
        sendLog(`[Worker ${workerId}] Error on account ${accountNumber}: ${errMsg}`, 'error');
        return false;
      }
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
    }
  }

  return false;
}

// ---------------------------------------------------------
// 6. MAIN BATCH RUNNER
// ---------------------------------------------------------
app.post('/api/start', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No CSV file uploaded' });
    }

    const accountRows = parseCSVBuffer(req.file.buffer);
    if (accountRows.length === 0) {
      return res.status(400).json({ success: false, error: 'CSV file is empty' });
    }

    res.json({ success: true, count: accountRows.length });

    sendLog(`Loaded ${accountRows.length} account row(s). Initializing resilient batch engine (5 workers/batch)...`, 'info');

    if (!process.env.BROWSERLESS_WS) {
      sendLog('ERROR: BROWSERLESS_WS environment variable is missing!', 'error', true);
      return;
    }

    // Initialize global singleton connection
    await getBrowser().catch(() => {});

    (async () => {
      let globalSuccesses = 0;
      const TARGET_SUCCESSES = 20;
      const BATCH_SIZE = 5;

      for (let i = 0; i < accountRows.length; i += BATCH_SIZE) {
        if (globalSuccesses >= TARGET_SUCCESSES) break;

        const currentBatch = accountRows.slice(i, i + BATCH_SIZE);
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

        sendLog(`--- STARTING BATCH ${batchNumber} (${currentBatch.length} accounts in parallel) ---`, 'info');

        // Launch 5 workers with a 1.2s stagger to prevent initial CPU spikes
        const batchPromises = currentBatch.map(async (row, batchIdx) => {
          const workerId = batchIdx + 1;
          const rowIndex = i + batchIdx;

          await delay(batchIdx * 1200);

          if (globalSuccesses >= TARGET_SUCCESSES) return false;

          const success = await processAccount(row, rowIndex, workerId);
          if (success) {
            globalSuccesses++;
            sendLog(`SUCCESS (${globalSuccesses}/${TARGET_SUCCESSES}): Row ${rowIndex + 1} completed!`, 'info');
          }
          return success;
        });

        // Hard await: Batch will not finish until all 5 workers complete or recover
        await Promise.all(batchPromises);

        sendLog(`--- BATCH ${batchNumber} FINISHED. Total verified successes: ${globalSuccesses}/${TARGET_SUCCESSES} ---`, 'info');

        if (globalSuccesses >= TARGET_SUCCESSES) {
          sendLog(`🎉 TARGET REACHED: Successfully created ${TARGET_SUCCESSES} accounts! Stopping execution engine.`, 'info', true);
          break;
        }

        await delay(2000);
      }

      sendLog(`Execution complete. Final verified total: ${globalSuccesses}/${TARGET_SUCCESSES}`, 'info', true);
    })();

  } catch (err) {
    console.error('Fatal API Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
