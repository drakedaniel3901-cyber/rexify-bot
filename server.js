// 1. Crash Guards
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH GUARD] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] Uncaught Exception thrown:', err);
});

// 2. Safe dotenv
try {
  require('dotenv').config();
} catch (e) {}

const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const { KnownDevices } = require('puppeteer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || 'https://rexify.com.ng?reference=sholaupdates';
const mobileDevice = KnownDevices['iPhone 13 Pro'];

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min = 100, max = 400) => 
  delay(Math.floor(Math.random() * (max - min + 1)) + min);

function generateRandomEmail() {
  const randStr = Math.random().toString(36).substring(2, 8);
  return `user_${Date.now()}_${randStr}@gmail.com`;
}

function generateRandomPassword() {
  return `Pass!${Math.random().toString(36).slice(-8)}`;
}

function ensurePageAlive(page) {
  if (!page || page.isClosed()) {
    throw new Error('PAGE_CLOSED_OR_DETACHED');
  }
}

// ---------------------------------------------------------
// SINGLETON BROWSER CONNECTION MANAGER
// ---------------------------------------------------------
let globalBrowser = null;
let isConnecting = false;

async function getBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) {
    return globalBrowser;
  }

  while (isConnecting) {
    await delay(200);
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
        sendLog('[BROWSER ENGINE] ⚠️ Browserless connection dropped!', 'warn');
        globalBrowser = null;
      });

      sendLog('[BROWSER ENGINE] Connected successfully to Browserless!', 'info');
      isConnecting = false;
      return globalBrowser;
    } catch (err) {
      const is429 = err.message && err.message.includes('429');
      const waitMs = is429 ? attempts * 1500 : 1000;
      sendLog(`[BROWSER ENGINE] Connection failed (${err.message}). Retrying in ${waitMs / 1000}s...`, 'warn');
      await delay(waitMs);
    }
  }

  isConnecting = false;
  throw new Error('Could not establish Browserless connection.');
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
    try { client.res.write(': keep-alive\n\n'); } catch (err) {}
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
// TURBO AUTOMATION ENGINE
// ---------------------------------------------------------
async function runAccountWorkflow(page, context, row, rowIndex, workerId) {
  const bankName = row.bankName || 'OPay';
  const accountNumber = row.accountNumber || row.account || Object.values(row)[0];
  const randomEmail = generateRandomEmail();
  const randomPassword = generateRandomPassword();

  sendLog(`[Worker ${workerId}] [Row ${rowIndex + 1}] Processing ${accountNumber} (${randomEmail})`, 'info');

  // Resource Blocking Optimization (Block heavy media/css/fonts)
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.emulate(mobileDevice);
  page.setDefaultTimeout(12000);

  // STEP 1: Landing Page
  ensurePageAlive(page);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

  ensurePageAlive(page);
  const getStartedBtn = await page.waitForSelector('text/Get started', { visible: true, timeout: 10000 });
  await getStartedBtn.click();

  const pages = await context.pages();
  if (pages.length > 1) {
    page = pages[pages.length - 1];
    await page.emulate(mobileDevice);
    page.setDefaultTimeout(12000);
  }

  // STEP 2: Fast Registration
  ensurePageAlive(page);
  const emailSelector = await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { visible: true, timeout: 10000 });
  await emailSelector.type(randomEmail, { delay: 0 });

  const passSelector = await page.waitForSelector('input[type="password"], input[name="password"]', { visible: true, timeout: 8000 });
  await passSelector.type(randomPassword, { delay: 0 });

  const checkbox = await page.$('input[type="checkbox"]');
  if (checkbox) await checkbox.click();

  const continueBtn = await page.waitForSelector('text/Continue', { visible: true, timeout: 10000 });
  await continueBtn.click();

  // STEP 3: Withdrawal Setup & Fast Verification Loop
  let isVerified = false;
  let verifyAttempt = 0;
  const MAX_VERIFY_ATTEMPTS = 7;

  while (!isVerified && verifyAttempt < MAX_VERIFY_ATTEMPTS) {
    verifyAttempt++;
    ensurePageAlive(page);
    sendLog(`[Worker ${workerId}] Verification attempt ${verifyAttempt}/${MAX_VERIFY_ATTEMPTS} for ${accountNumber}...`);

    const accountInput = await page.waitForSelector('input[placeholder*="account number" i], input[name*="account" i]', { visible: true, timeout: 10000 });
    await accountInput.click({ clickCount: 3 });
    await accountInput.press('Backspace');
    await accountInput.type(accountNumber, { delay: 0 });

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

    const verifyBtn = await page.waitForSelector('text/Verify account', { visible: true, timeout: 10000 });
    await verifyBtn.click();

    // Fast Polling Loop (250ms intervals)
    const startTime = Date.now();
    let status = 'pending';

    while (Date.now() - startTime < 8000) {
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
      await delay(250);
    }

    if (status === 'success') {
      isVerified = true;
      sendLog(`[Worker ${workerId}] Account verified successfully for ${accountNumber}!`, 'info');
    } else {
      sendLog(`[Worker ${workerId}] Verification returned '${status}' on attempt ${verifyAttempt}. Re-inputting...`, 'warn');
      await randomDelay(300, 600);
    }
  }

  if (!isVerified) {
    throw new Error(`Failed account verification after ${MAX_VERIFY_ATTEMPTS} attempts.`);
  }

  // Finish
  ensurePageAlive(page);
  const finishBtn = await page.waitForSelector('text/Finish & continue', { visible: true, timeout: 10000 });
  await finishBtn.click();

  sendLog(`[Worker ${workerId}] Clicked 'Finish & continue'. Finalizing...`);
  await delay(2000); // Fast stabilization

  return true;
}

// ---------------------------------------------------------
// WORKER HANDLER WITH CONTEXT RETRY GUARD
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

      return await runAccountWorkflow(page, context, row, rowIndex, workerId);

    } catch (err) {
      const errMsg = err.message || '';
      const isRecoverable = 
        errMsg.includes('detached') || 
        errMsg.includes('Target closed') || 
        errMsg.includes('Protocol error') || 
        errMsg.includes('PAGE_CLOSED') ||
        errMsg.includes('Execution context');

      if (isRecoverable && accountAttempts < MAX_ACCOUNT_ATTEMPTS) {
        sendLog(`[Worker ${workerId}] Recoverable error for ${accountNumber} (${errMsg}). Re-spawning context (Attempt ${accountAttempts}/${MAX_ACCOUNT_ATTEMPTS})...`, 'warn');
        await delay(500);
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
// MAIN BATCH RUNNER
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

    sendLog(`Loaded ${accountRows.length} account row(s). Starting Turbo Batch Engine...`, 'info');

    if (!process.env.BROWSERLESS_WS) {
      sendLog('ERROR: BROWSERLESS_WS variable missing!', 'error', true);
      return;
    }

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

        // Fast staggered start (300ms)
        const batchPromises = currentBatch.map(async (row, batchIdx) => {
          const workerId = batchIdx + 1;
          const rowIndex = i + batchIdx;

          await delay(batchIdx * 300);

          if (globalSuccesses >= TARGET_SUCCESSES) return false;

          const success = await processAccount(row, rowIndex, workerId);
          if (success) {
            globalSuccesses++;
            sendLog(`SUCCESS (${globalSuccesses}/${TARGET_SUCCESSES}): Row ${rowIndex + 1} completed!`, 'info');
          }
          return success;
        });

        await Promise.all(batchPromises);

        sendLog(`--- BATCH ${batchNumber} FINISHED. Verified successes: ${globalSuccesses}/${TARGET_SUCCESSES} ---`, 'info');

        if (globalSuccesses >= TARGET_SUCCESSES) {
          sendLog(`🎉 TARGET REACHED: ${TARGET_SUCCESSES} accounts created!`, 'info', true);
          break;
        }

        await delay(1000);
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
