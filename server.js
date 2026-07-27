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

// 3. Global CORS Middleware
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

// Dynamic delay helpers
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min = 1000, max = 3000) => 
  delay(Math.floor(Math.random() * (max - min + 1)) + min);

function generateRandomEmail() {
  const randStr = Math.random().toString(36).substring(2, 8);
  return `user_${Date.now()}_${randStr}@gmail.com`;
}

function generateRandomPassword() {
  return `Pass!${Math.random().toString(36).slice(-8)}`;
}

// 4. Server-Sent Events (SSE) Endpoint with Heartbeat Ping
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
    } catch (err) {
      // Cleaned up on disconnect
    }
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

// 5. Browser Instance Manager
let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  
  sendLog('Establishing Browserless WebSocket connection...', 'info');
  browserInstance = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSERLESS_WS,
  });

  browserInstance.on('disconnected', () => {
    sendLog('Browserless connection dropped. Reconnect queued...', 'error');
    browserInstance = null;
  });

  return browserInstance;
}

// Single Account Creation Handler
async function processAccount(row, rowIndex, workerId) {
  const bankName = row.bankName || 'OPay';
  const accountNumber = row.accountNumber || row.account || Object.values(row)[0];

  const randomEmail = generateRandomEmail();
  const randomPassword = generateRandomPassword();
  sendLog(`[Worker ${workerId}] [Row ${rowIndex + 1}] Processing ${accountNumber} (${randomEmail})`, 'info');

  let context = null;
  try {
    const browser = await getBrowser();
    context = await browser.createBrowserContext();
    let page = await context.newPage();

    await page.emulate(mobileDevice);
    page.setDefaultTimeout(25000);

    // STEP 1: Landing Page
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 35000 });
    await randomDelay(1000, 2000);

    const getStartedBtn = await page.waitForSelector('text/Get started', { visible: true, timeout: 15000 });
    await randomDelay(500, 1000);
    await Promise.all([
      getStartedBtn.click(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
    ]);

    const pages = await context.pages();
    if (pages.length > 1) {
      page = pages[pages.length - 1];
      await page.emulate(mobileDevice);
      page.setDefaultTimeout(25000);
    }

    await randomDelay(1500, 3000);

    // STEP 2: Registration
    const emailSelector = await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { visible: true, timeout: 15000 });
    await emailSelector.type(randomEmail, { delay: 50 });

    const passSelector = await page.waitForSelector('input[type="password"], input[name="password"]', { visible: true, timeout: 10000 });
    await passSelector.type(randomPassword, { delay: 50 });

    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) {
      await checkbox.click();
    }

    const continueBtn = await page.waitForSelector('text/Continue', { visible: true, timeout: 15000 });
    await randomDelay(600, 1200);
    await Promise.all([
      continueBtn.click(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
    ]);

    await randomDelay(3000, 5000);

    // STEP 3: Withdrawal Setup & 7x Retry Verification Loop
    let isVerified = false;
    let verifyAttempt = 0;
    const MAX_VERIFY_ATTEMPTS = 7;

    while (!isVerified && verifyAttempt < MAX_VERIFY_ATTEMPTS) {
      verifyAttempt++;
      sendLog(`[Worker ${workerId}] Verification attempt ${verifyAttempt}/${MAX_VERIFY_ATTEMPTS} for ${accountNumber}...`);

      const accountInput = await page.waitForSelector('input[placeholder*="account number" i], input[name*="account" i]', { visible: true, timeout: 15000 });
      
      // Clear input field cleanly
      await accountInput.click({ clickCount: 3 });
      await accountInput.press('Backspace');
      await randomDelay(300, 600);
      await accountInput.type(accountNumber, { delay: 50 });

      // Select Bank
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

      const verifyBtn = await page.waitForSelector('text/Verify account', { visible: true, timeout: 15000 });
      await randomDelay(500, 1000);
      await verifyBtn.click();

      // Poll DOM state for up to 12 seconds
      const startTime = Date.now();
      let status = 'pending';

      while (Date.now() - startTime < 12000) {
        const result = await page.evaluate(() => {
          const bodyText = document.body.innerText || '';
          if (bodyText.includes('Account name') || bodyText.includes('Verified')) {
            return 'success';
          }
          if (bodyText.includes('Not verified') || bodyText.includes('Could not verify')) {
            return 'failed';
          }
          return 'pending';
        });

        if (result !== 'pending') {
          status = result;
          break;
        }
        await delay(1000);
      }

      if (status === 'success') {
        isVerified = true;
        sendLog(`[Worker ${workerId}] Account verified successfully for ${accountNumber}!`, 'info');
      } else {
        sendLog(`[Worker ${workerId}] Verification returned '${status}' on attempt ${verifyAttempt}. Re-inputting...`, 'warn');
        await randomDelay(1500, 3000);
      }
    }

    if (!isVerified) {
      throw new Error(`Failed account verification after ${MAX_VERIFY_ATTEMPTS} attempts.`);
    }

    // Finish & Continue
    const finishBtn = await page.waitForSelector('text/Finish & continue', { visible: true, timeout: 15000 });
    await randomDelay(800, 1500);
    await finishBtn.click();

    sendLog(`[Worker ${workerId}] Clicked 'Finish & continue'. Stabilizing account (15s)...`);
    await delay(15000);

    return true;

  } catch (err) {
    sendLog(`[Worker ${workerId}] Error on account ${accountNumber}: ${err.message}`, 'error');
    return false;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

// 6. Main Runner with Concurrency = 5 and Auto-Stop at 20 Successes
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

    sendLog(`Loaded ${accountRows.length} account row(s). Starting execution pool...`, 'info');

    if (!process.env.BROWSERLESS_WS) {
      sendLog('ERROR: BROWSERLESS_WS environment variable is missing!', 'error', true);
      return;
    }

    // Concurrent Work Queue Engine
    (async () => {
      let globalSuccesses = 0;
      const TARGET_SUCCESSES = 20;
      const CONCURRENCY = 5;

      const queue = accountRows.map((row, index) => ({ row, index }));

      const worker = async (workerId) => {
        while (queue.length > 0 && globalSuccesses < TARGET_SUCCESSES) {
          const item = queue.shift();
          if (!item) break;

          const success = await processAccount(item.row, item.index, workerId);

          if (success) {
            globalSuccesses++;
            sendLog(`SUCCESS (${globalSuccesses}/${TARGET_SUCCESSES}): Account row ${item.index + 1} completed!`, 'info');

            if (globalSuccesses >= TARGET_SUCCESSES) {
              sendLog(`🎉 TARGET REACHED: Successfully created ${TARGET_SUCCESSES} accounts! Stopping execution pool.`, 'info', true);
              break;
            }
          } else {
            sendLog(`Failed row ${item.index + 1}. Worker ${workerId} moving to next in queue...`, 'warn');
          }

          await randomDelay(1000, 2500);
        }
      };

      // Launch 5 instances in parallel
      const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
      await Promise.all(workers);

      sendLog(`Execution batch completed. Total successes: ${globalSuccesses}/${TARGET_SUCCESSES}`, 'info', true);

      if (browserInstance) {
        await browserInstance.disconnect().catch(() => {});
        browserInstance = null;
      }
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
