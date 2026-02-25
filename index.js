#!/usr/bin/env node
/**
 * YAYA Uptime — Bot Worker (MVP v2)
 * Monitors store homepages: screenshot, compare to baseline, alert on changes.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { PNG } = require('pngjs');

const pixelmatchModule = require('pixelmatch');
const pixelmatch = pixelmatchModule.default || pixelmatchModule;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const s3 = new S3Client({
  region: 'auto',
  endpoint: 'https://' + process.env.CLOUDFLARE_ACCOUNT_ID + '.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  },
});

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://pub-9b659287417143e2a5f69b43384c4039.r2.dev';
const DIFF_THRESHOLD_PERCENT = parseFloat(process.env.DIFF_THRESHOLD_PERCENT || '5');

function log(msg) {
  console.log('[YAYA Uptime] ' + msg);
}

function logError(msg) {
  console.error('[YAYA Uptime] ' + msg);
}

function ensureHttps(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'https://' + url;
  }
  return url;
}

async function uploadToR2(buffer, key) {
  await s3.send(new PutObjectCommand({
    Bucket: 'yaya-screenshots',
    Key: key,
    Body: buffer,
    ContentType: 'image/png',
  }));
  return R2_PUBLIC_URL + '/' + key;
}

async function downloadFromR2(key) {
  if (!key) return null;
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: 'yaya-screenshots',
      Key: key,
    }));
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    logError('R2 download failed for ' + key + ': ' + err.message);
    return null;
  }
}

function extractR2Key(publicUrl) {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    return url.pathname.substring(1);
  } catch (e) {
    return null;
  }
}

function compareImages(baselineBuffer, newBuffer) {
  if (!baselineBuffer || !newBuffer) {
    return { hasSignificantDiff: true, diffPercentage: 100 };
  }

  var baselinePng, newPng;
  try {
    baselinePng = PNG.sync.read(baselineBuffer);
    newPng = PNG.sync.read(newBuffer);
  } catch (err) {
    logError('PNG decode failed: ' + err.message);
    return { hasSignificantDiff: true, diffPercentage: 100 };
  }

  var w1 = baselinePng.width, h1 = baselinePng.height;
  var w2 = newPng.width, h2 = newPng.height;

  if (w1 !== w2 || h1 !== h2) {
    log('Dimension change: ' + w1 + 'x' + h1 + ' -> ' + w2 + 'x' + h2);
    return { hasSignificantDiff: false, diffPercentage: 0, dimensionChanged: true };
  }

  var diff = new Uint8Array(w1 * h1 * 4);
  var numDiffPixels = pixelmatch(
    baselinePng.data,
    newPng.data,
    diff,
    w1,
    h1,
    { threshold: 0.1 }
  );

  var diffPercentage = (numDiffPixels / (w1 * h1)) * 100;
  return {
    hasSignificantDiff: diffPercentage > DIFF_THRESHOLD_PERCENT,
    diffPercentage: Math.round(diffPercentage * 100) / 100,
  };
}

async function processStore(browser, store) {
  var id = store.id;
  var url = store.url;
  var baseline_homepage_url = store.baseline_homepage_url;
  var fullUrl = ensureHttps(url);
  log('Processing: ' + fullUrl);

  var runStart = new Date().toISOString();
  var runStatus = 'success';
  var runError = null;
  var screenshotUrl = null;
  var diffResult = null;

  var page = await browser.newPage();

  try {
    await page.setRequestInterception(true);
    page.on('request', function(req) {
      var type = req.resourceType();
      if (type === 'font' || type === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 YAYAUptimeBot/1.0'
    );

    await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    await new Promise(function(r) { setTimeout(r, 5000); });

    var timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    var key = 'screenshots/' + id + '/homepage-' + timestamp + '.png';
    var buffer = await page.screenshot({ fullPage: false, type: 'png' });

    screenshotUrl = await uploadToR2(buffer, key);
    log('Screenshot uploaded: ' + key);

    if (!baseline_homepage_url) {
      await supabase.from('stores').update({
        baseline_homepage_url: screenshotUrl,
      }).eq('id', id);
      log('First run. Baseline set.');
    } else {
      var baselineKey = extractR2Key(baseline_homepage_url);
      var baselineBuffer = await downloadFromR2(baselineKey);

      if (!baselineBuffer) {
        await supabase.from('stores').update({
          baseline_homepage_url: screenshotUrl,
        }).eq('id', id);
        log('Baseline file missing. Reset to current screenshot.');
      } else {
        diffResult = compareImages(baselineBuffer, buffer);

        if (diffResult.dimensionChanged) {
          await supabase.from('stores').update({
            baseline_homepage_url: screenshotUrl,
          }).eq('id', id);
          log('Dimension changed. Baseline updated silently.');
        } else if (diffResult.hasSignificantDiff) {
          await supabase.from('alerts').insert({
            store_id: id,
            step: 'homepage',
            before_url: baseline_homepage_url,
            after_url: screenshotUrl,
            diff_percentage: diffResult.diffPercentage,
            type: diffResult.diffPercentage > 20 ? 'red' : 'yellow',
          });
          log('ALERT: ' + diffResult.diffPercentage + '% change detected!');
        } else {
          await supabase.from('stores').update({
            baseline_homepage_url: screenshotUrl,
          }).eq('id', id);
          log('OK: ' + diffResult.diffPercentage + '% change (below threshold).');
        }
      }
    }
  } catch (err) {
    runStatus = 'error';
    runError = err.message;
    logError('Store ' + id + ' failed: ' + err.message);
  } finally {
    await page.close();
  }

  await supabase.from('stores').update({
    last_checked: new Date().toISOString(),
  }).eq('id', id);

  await supabase.from('runs').insert({
    store_id: id,
    started_at: runStart,
    finished_at: new Date().toISOString(),
    status: runStatus,
    error_message: runError,
    screenshot_url: screenshotUrl,
    diff_percentage: diffResult ? diffResult.diffPercentage : null,
  });
}

async function main() {
  log('Starting bot worker...');

  try {
    var result = await supabase
      .from('stores')
      .select('id, url, baseline_homepage_url')
      .eq('status', 'active');

    if (result.error) throw result.error;

    var stores = result.data;

    if (!stores || stores.length === 0) {
      log('No active stores found.');
      return;
    }

    log('Found ' + stores.length + ' active store(s).');

    var browser = await puppeteer.connect({
      browserWSEndpoint: 'wss://chrome.browserless.io?token=' + process.env.BROWSERLESS_API_KEY,
      ignoreHTTPSErrors: true,
    });

    for (var i = 0; i < stores.length; i++) {
      await processStore(browser, stores[i]);
    }

    await browser.close();
    log('All stores processed. Done.');
  } catch (err) {
    logError('Fatal error: ' + err.message);
    process.exit(1);
  }
}

main();