#!/usr/bin/env node
/**
 * YAYA Uptime Worker
 * Periodically screenshots store homepages, compares against baseline,
 * creates alerts and sends emails on significant visual changes.
 * Also runs basic ping monitoring every 5 minutes (free tier acquisition funnel).
 *
 * Features:
 * - Cron scheduling with overlap guard
 * - 5-second inter-store delay (Browserless rate-limit safety)
 * - Failed attempt tracking + auto-inactivation after 5 consecutive failures
 * - Basic ping monitoring (up/down, response time, consecutive down alerts)
 * - Bot identity + CSS noise hiding for cleaner screenshots
 * - R2 uploads with compression (sharp) + long-term caching
 * - Visual diff: Ghost overlay (actual screenshot + semi-transparent red highlights)
 * - Clean error handling & logging
 *
 * Last major update: February 26, 2026
 */

require('dotenv').config();

const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { PNG } = require('pngjs');
const { Resend } = require('resend');
const pixelmatch = require('pixelmatch').default || require('pixelmatch');
const sharp = require('sharp');

const resend = new Resend(process.env.RESEND_API_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  },
});

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://pub-9b659287417143e2a5f69b43384c4039.r2.dev';
const DIFF_THRESHOLD_PERCENT = 5;
const MAX_FAILURES_BEFORE_INACTIVE = 5;

let isRunningVisual = false;
let isRunningPing = false;

// ────────────────────────────────────────────────
// Logging Helpers
// ────────────────────────────────────────────────

function log(msg) {
  console.log(`[YAYA] ${msg}`);
}

function logError(msg) {
  console.error(`[YAYA] ERROR: ${msg}`);
}

// ────────────────────────────────────────────────
// Utility Functions
// ────────────────────────────────────────────────

function ensureHttps(url) {
  return url.startsWith('http') ? url : `https://${url}`;
}

async function uploadToR2(buffer, key) {
  const compressed = await sharp(buffer)
    .png({ quality: 90, compressionLevel: 9 })
    .toBuffer();

  await s3.send(
    new PutObjectCommand({
      Bucket: 'yaya-screenshots',
      Key: key,
      Body: compressed,
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000',
    })
  );
  return `${R2_PUBLIC_URL}/${key}`;
}

async function downloadFromR2(key) {
  if (!key) return null;
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: 'yaya-screenshots', Key: key }));
    const chunks = [];
    for await (const chunk of Body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (err) {
    logError(`R2 download failed for ${key}: ${err.message}`);
    return null;
  }
}

function extractR2Key(publicUrl) {
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl).pathname.substring(1);
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────
// Your Improved compareImages Function
// ────────────────────────────────────────────────

async function compareImages(baselineBuffer, newBuffer, id, timestamp) {
  try {
    const baselinePng = PNG.sync.read(baselineBuffer);
    const newPng = PNG.sync.read(newBuffer);
    const { width, height } = baselinePng;

    if (width !== newPng.width || height !== newPng.height) {
      return { hasSignificantDiff: false, dimensionChanged: true };
    }

    const diff = new PNG({ width, height });
   
    // Create the ghost overlay
    const numDiffPixels = pixelmatch(baselinePng.data, newPng.data, diff.data, width, height, {
      threshold: 0.1,
      alpha: 0.5,
    });
    const diffPercentage = (numDiffPixels / (width * height)) * 100;
   
    // 1. Get the raw buffer from pngjs
    const rawDiffBuffer = PNG.sync.write(diff);
    // 2. Compress with sharp to keep file size small (~200KB)
    const optimizedDiffBuffer = await sharp(rawDiffBuffer)
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();

    const diffKey = `diffs/${id}/${timestamp}-diff.png`;
    const diffUrl = await uploadToR2(optimizedDiffBuffer, diffKey);

    log(`Ghost overlay diff uploaded: ${diffPercentage.toFixed(2)}%`);

    return {
      hasSignificantDiff: diffPercentage > DIFF_THRESHOLD_PERCENT,
      diffPercentage: Math.round(diffPercentage * 100) / 100,
      diffUrl
    };
  } catch (err) {
    logError(`Comparison failed: ${err.message}`);
    return { hasSignificantDiff: false, error: true };
  }
}

// ────────────────────────────────────────────────
// Alert Email (visual + ping)
// ────────────────────────────────────────────────

async function sendAlertEmail(alert, type = 'visual') {
  try {
    const { data: store } = await supabase
      .from('stores')
      .select('url, user_id')
      .eq('id', alert.store_id)
      .single();

    if (!store?.user_id) return;

    const { data: { user } } = await supabase.auth.admin.getUserById(store.user_id);
    if (!user?.email) return;

    let subject, html;

    if (type === 'ping') {
      subject = `🚨 Your store is DOWN: ${store.url}`;
      html = `
        <h1 style="color:#ef4444;">Site Down Alert</h1>
        <p>Your store <strong><a href="${store.url}">${store.url}</a></strong> has been unreachable for multiple checks.</p>
        <p>Please check your hosting/server immediately.</p>
        <p><a href="https://www.yayauptime.com/dashboard" style="display:inline-block; background:#ef4444; color:white; padding:16px 32px; text-decoration:none; border-radius:8px; font-weight:bold;">View in Dashboard</a></p>
        <p style="color:#666; font-size:13px; margin-top:30px;">YAYA Uptime • Visual Store Monitoring</p>
      `;
    } else {
      subject = `🚨 Visual change on ${store.url} – ${alert.diff_percentage}%`;
      html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>YAYA Uptime Alert</title>
  <style>
    body { background:#0a0a0a; color:#fff; font-family:system-ui,sans-serif; margin:0; padding:0; }
    .container { max-width:600px; margin:40px auto; padding:20px; }
    .header { background:#111; padding:20px; text-align:center; border-radius:8px 8px 0 0; }
    .content { background:#1a1a1a; padding:30px; border-radius:0 0 8px 8px; }
    h1 { color:#ef4444; margin:0 0 20px; }
    .diff { font-size:26px; font-weight:bold; color:#f59e0b; }
    .screenshots { display:flex; gap:20px; flex-wrap:wrap; margin:25px 0; }
    .screenshot { max-width:100%; border:3px solid #333; border-radius:8px; }
    .cta { display:inline-block; background:#ef4444; color:white; padding:16px 32px; text-decoration:none; border-radius:8px; font-weight:bold; font-size:16px; margin-top:20px; }
    .cta:hover { background:#f87171; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>🚨 YAYA Uptime Alert</h1></div>
    <div class="content">
      <p><strong>Store:</strong> <a href="${store.url}" style="color:#60a5fa;">${store.url}</a></p>
      <p class="diff">Visual change detected: ${alert.diff_percentage}%</p>
      <div class="screenshots">
        <div><p><strong>Before</strong></p><img src="${alert.before_url}" class="screenshot" alt="Before"></div>
        <div><p><strong>After</strong></p><img src="${alert.after_url}" class="screenshot" alt="After"></div>
        ${alert.diff_url ? `<div><p><strong>Highlighted Diff</strong></p><img src="${alert.diff_url}" class="screenshot" alt="Diff"></div>` : ''}
      </div>
      <a href="https://www.yayauptime.com/dashboard/alerts/${alert.id}" class="cta">VIEW IN DASHBOARD →</a>
      <p style="margin-top:30px; color:#666; font-size:13px;">YAYA Uptime • Visual Store Monitoring</p>
    </div>
  </div>
</body>
</html>`;
    }

    await resend.emails.send({
      from: 'YAYA Uptime <alerts@yayauptime.com>',
      to: user.email,
      subject,
      html,
    });

    log(`Alert email sent to ${user.email} (${type})`);
  } catch (err) {
    logError(`Email send failed: ${err.message}`);
  }
}

// ────────────────────────────────────────────────
// Ping Monitor (Mission 2.4.1)
// ────────────────────────────────────────────────

async function pingStore(store) {
  const { id, url } = store;
  const fullUrl = ensureHttps(url);
  log(`Ping: ${id} - ${fullUrl}`);

  const startTime = Date.now();
  let statusCode = null;
  let responseTimeMs = null;
  let isUp = false;
  let errorMsg = null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(fullUrl, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    statusCode = response.status;
    responseTimeMs = Date.now() - startTime;
    isUp = statusCode >= 200 && statusCode < 300;

    log(`Ping ${fullUrl} – ${statusCode} (${responseTimeMs}ms)`);
  } catch (err) {
    responseTimeMs = Date.now() - startTime;
    errorMsg = err.message || 'Unknown error';
    isUp = false;

    logError(`Ping failed ${fullUrl}: ${errorMsg}`);
  }

  await supabase.from('ping_logs').insert({
    store_id: id,
    status_code: statusCode,
    response_time_ms: responseTimeMs,
    is_up: isUp,
    error_message: errorMsg,
  });

  if (!isUp) {
    const { data: lastPing } = await supabase
      .from('ping_logs')
      .select('is_up')
      .eq('store_id', id)
      .order('checked_at', { ascending: false })
      .limit(1);

    if (lastPing?.[0]?.is_up === false) {
      await sendAlertEmail({ store_id: id }, 'ping');
    }
  }
}

// ────────────────────────────────────────────────
// Core Visual Processing
// ────────────────────────────────────────────────

async function processStore(browser, store) {
  const { id, url, baseline_homepage_url } = store;
  const fullUrl = ensureHttps(url);
  log(`Processing ${id}: ${fullUrl}`);

  const runStart = new Date().toISOString();
  let status = 'success';
  let errorMsg = null;
  let screenshotUrl = null;
  let diffResult = null;
  let page = null;

  try {
    page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      'X-YAYA-Uptime': 'true',
      'X-Purpose': 'Uptime Monitoring with consent',
    });

    await page.setUserAgent(
      'Mozilla/5.0 (compatible; YAYA Uptime Bot/1.0; +https://yayauptime.com/bot)'
    );

    await page.addStyleTag({
      content: `
        [id*="cookie"], [class*="cookie"], [class*="gdpr"], [class*="consent"],
        [class*="banner"], [class*="popup"], [class*="modal"], [class*="overlay"],
        [class*="chat"], [id*="chat"], [id*="intercom"], [class*="widget"],
        .cookie-notice, .cookie-consent, .cookie-law, .cookie-message,
        .cc-window, .cc-banner, .cc-compliance, .cc-floating, .cc-revoke,
        iframe[src*="cookie"], iframe[src*="consent"], [data-cookie],
        [data-gdpr], [data-consent], [data-tracking], [data-analytics],
        .popup-wrapper, .popup-container, .modal-backdrop, .backdrop,
        .notification-bar, .alert-bar, .top-bar, .bottom-bar,
        .newsletter-popup, .exit-intent, .scroll-popup, .float-chat {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
          height: 0 !important;
          width: 0 !important;
          max-height: 0 !important;
          max-width: 0 !important;
          overflow: hidden !important;
        }
      `,
    });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'font' || type === 'media') req.abort();
      else req.continue();
    });

    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 5000));

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `screenshots/${id}/homepage-${timestamp}.png`;
    const buffer = await page.screenshot({ fullPage: true, type: 'png' });

    screenshotUrl = await uploadToR2(buffer, key);
    log(`Screenshot: ${key}`);

    await supabase.from('stores').update({ failed_attempts: 0 }).eq('id', id);

    if (!baseline_homepage_url) {
      await supabase.from('stores').update({ baseline_homepage_url: screenshotUrl }).eq('id', id);
      log('First run — baseline set');
      return;
    }

    const baselineKey = extractR2Key(baseline_homepage_url);
    const baselineBuffer = await downloadFromR2(baselineKey);

    if (!baselineBuffer) {
      await supabase.from('stores').update({ baseline_homepage_url: screenshotUrl }).eq('id', id);
      log('Missing baseline — reset');
      return;
    }

    diffResult = await compareImages(baselineBuffer, buffer, id, timestamp);

    if (diffResult.dimensionChanged) {
      await supabase.from('stores').update({ baseline_homepage_url: screenshotUrl }).eq('id', id);
      log('Dimensions changed — baseline updated');
      return;
    }

    if (diffResult.hasSignificantDiff) {
      const { data: alert, error } = await supabase
        .from('alerts')
        .insert({
          store_id: id,
          step: 'homepage',
          before_url: baseline_homepage_url,
          after_url: screenshotUrl,
          diff_url: diffResult.diffUrl,
          diff_percentage: diffResult.diffPercentage,
          type: diffResult.diffPercentage > 20 ? 'red' : 'yellow',
        })
        .select()
        .single();

      if (error) logError(`Alert insert failed: ${error.message}`);
      else {
        log(`Significant change: ${diffResult.diffPercentage}%`);
        await sendAlertEmail(alert);
      }
    } else {
      await supabase.from('stores').update({ baseline_homepage_url: screenshotUrl }).eq('id', id);
      log(`No significant change: ${diffResult.diffPercentage}%`);
    }
  } catch (err) {
    status = 'error';
    errorMsg = err.message;
    logError(`Store ${id} failed: ${err.message}`);

    const failureKeywords = [
      'ERR_NAME_NOT_RESOLVED',
      'getaddrinfo',
      'ECONNREFUSED',
      'timeout',
      'ENOTFOUND',
      'ERR_CONNECTION_REFUSED',
      'ERR_CONNECTION_TIMED_OUT',
    ];

    if (failureKeywords.some((kw) => err.message.includes(kw))) {
      const { data: current } = await supabase
        .from('stores')
        .select('failed_attempts')
        .eq('id', id)
        .single();

      const count = (current?.failed_attempts ?? 0) + 1;
      const update = { failed_attempts: count };

      if (count >= MAX_FAILURES_BEFORE_INACTIVE) {
        update.status = 'inactive';
        log(`Store ${id} inactivated after ${count} consecutive failures`);
      }

      await supabase.from('stores').update(update).eq('id', id);
      log(`Failure count for ${id}: ${count}`);
    }
  } finally {
    if (page) await page.close();

    await supabase.from('stores').update({ last_checked: new Date().toISOString() }).eq('id', id);

    await supabase.from('runs').insert({
      store_id: id,
      started_at: runStart,
      finished_at: new Date().toISOString(),
      status,
      error_message: errorMsg,
      screenshot_url: screenshotUrl,
      diff_percentage: diffResult?.diffPercentage ?? null,
    });
  }
}

// ────────────────────────────────────────────────
// Visual Cycle Runner
// ────────────────────────────────────────────────

async function runVisualChecks() {
  if (isRunningVisual) {
    log('Visual cycle still running — skipping');
    return;
  }

  isRunningVisual = true;
  log('Starting visual check cycle');

  try {
    const { data: stores, error } = await supabase
      .from('stores')
      .select('id, url, baseline_homepage_url, check_interval_minutes')
      .eq('status', 'active');

    if (error) throw error;
    if (!stores?.length) {
      log('No active stores for visual check');
      return;
    }

    log(`Processing ${stores.length} stores (visual)`);

    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`,
      ignoreHTTPSErrors: true,
    });

    for (const store of stores) {
      await processStore(browser, store);
      await new Promise((r) => setTimeout(r, 5000));
    }

    await browser.close();
    log('Visual cycle finished');
  } catch (err) {
    logError(`Visual cycle error: ${err.message}`);
  } finally {
    isRunningVisual = false;
  }
}

// ────────────────────────────────────────────────
// Ping Cycle Runner (Mission 2.4.1)
// ────────────────────────────────────────────────

async function runPingChecks() {
  if (isRunningPing) {
    log('Ping cycle still running — skipping');
    return;
  }

  isRunningPing = true;
  log('Starting ping cycle');

  try {
    const { data: stores, error } = await supabase
      .from('stores')
      .select('id, url')
      .eq('status', 'active');

    if (error) throw error;
    if (!stores?.length) {
      log('No active stores for ping');
      return;
    }

    log(`Pinging ${stores.length} stores`);

    for (const store of stores) {
      await pingStore(store);
    }

    log('Ping cycle finished');
  } catch (err) {
    logError(`Ping cycle error: ${err.message}`);
  } finally {
    isRunningPing = false;
  }
}

// ────────────────────────────────────────────────
// Scheduler
// ────────────────────────────────────────────────

// Visual checks every 15 minutes (Mission 2.4 aligned)
cron.schedule('*/15 * * * *', runVisualChecks);

// Ping checks every 5 minutes (Mission 2.4.1)
cron.schedule('*/5 * * * *', runPingChecks);

// Immediate first visual run
runVisualChecks();

// Immediate first ping run
runPingChecks();

log('Worker started');
log('Visual checks every 15 minutes (first run immediate) | Ping checks every 5 minutes (first run immediate)');

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down');
  process.exit(0);
});