#!/usr/bin/env node
/**
 * YAYA Uptime — Bot Worker with Baseline + Diff + Alerts (Stable MVP)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { PNG } = require('pngjs');

// Robust pixelmatch import
const pixelmatchModule = require('pixelmatch');
const pixelmatch = pixelmatchModule.default || pixelmatchModule;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  },
});

const DIFF_THRESHOLD_PERCENT = parseFloat(process.env.DIFF_THRESHOLD_PERCENT || '5');

async function uploadToR2(buffer, key) {
  const command = new PutObjectCommand({
    Bucket: 'yaya-screenshots',
    Key: key,
    Body: buffer,
    ContentType: 'image/png',
  });
  await s3.send(command);
  return `https://pub-9b659287417143e2a5f69b43384c4039.r2.dev/${key}`;
}

// ────────────────────────────────────────────────────────────────
// Visual diff helpers
// ────────────────────────────────────────────────────────────────

function urlToKey(urlString) {
  try {
    return new URL(urlString).pathname.substring(1);
  } catch (e) {
    console.error(`[YAYA Uptime] Invalid URL format: ${urlString}`, e.message);
    return null;
  }
}

async function getImageBuffer(key) {
  if (!key) return null;
  try {
    const command = new GetObjectCommand({
      Bucket: 'yaya-screenshots',
      Key: key,
    });
    const response = await s3.send(command);
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    console.error(`[YAYA Uptime] R2 download failed for ${key}: ${err.message}`);
    return null;
  }
}

function compareImages(baselineBuffer, newBuffer) {
  if (!baselineBuffer || !newBuffer) {
    return { hasSignificantDiff: true, diffPercentage: 100 };
  }

  let baselinePng, newPng;
  try {
    baselinePng = PNG.sync.read(baselineBuffer);
    newPng = PNG.sync.read(newBuffer);
  } catch (err) {
    console.error('[YAYA Uptime] PNG decode failed:', err.message);
    return { hasSignificantDiff: true, diffPercentage: 100 };
  }

  const w1 = baselinePng.width, h1 = baselinePng.height;
  const w2 = newPng.width,     h2 = newPng.height;

  // Auto-update baseline on dimension change (prevents repeated 100% alerts)
  if (w1 !== w2 || h1 !== h2) {
    console.log(`[YAYA Uptime] Dimension change: ${w1}×${h1} → ${w2}×${h2} — updating baseline`);
    return { hasSignificantDiff: true, diffPercentage: 100, shouldUpdateBaseline: true };
  }

  const diff = new Uint8Array(w1 * h1 * 4);
  const numDiffPixels = pixelmatch(
    baselinePng.data,
    newPng.data,
    diff,
    w1,
    h1,
    { threshold: 0.05 }
  );

  const diffPercentage = (numDiffPixels / (w1 * h1)) * 100;
  return { hasSignificantDiff: diffPercentage > DIFF_THRESHOLD_PERCENT, diffPercentage };
}

async function main() {
  console.log('[YAYA Uptime] Starting bot worker...');

  try {
    const { data: stores, error } = await supabase
      .from('stores')
      .select('id, url, baseline_homepage_url')
      .eq('status', 'active');

    if (error) throw error;
    if (!stores.length) {
      console.log('[YAYA Uptime] No active stores.');
      return;
    }

    console.log(`[YAYA Uptime] Found ${stores.length} stores.`);

    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`,
      ignoreHTTPSErrors: true,
    });

    for (const store of stores) {
      const { id, url, baseline_homepage_url } = store;
      console.log(`[YAYA Uptime] Processing store ${id}: ${url}`);

      const page = await browser.newPage();

      // COST OPTIMIZATION + STABILITY
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const rt = req.resourceType();
        if (['image', 'font', 'media', 'other'].includes(rt)) req.abort();
        else req.continue();
      });

      await page.setViewport({ width: 1280, height: 10000 }); // Tall fixed height = stable dimensions

      try {
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 YAYA-Uptime-Bot/1.0');

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const key = `homepage-${id}-${timestamp}.png`;

        const buffer = await page.screenshot({ fullPage: true, type: 'png' });
        const publicUrl = await uploadToR2(buffer, key);
        console.log(`[YAYA Uptime] Uploaded screenshot: ${publicUrl}`);

        // Baseline logic
        try {
          if (!baseline_homepage_url) {
            await supabase.from('stores').update({ baseline_homepage_url: publicUrl }).eq('id', id);
            console.log('[YAYA Uptime] First run — baseline set');
          } else {
            const baselineKey = urlToKey(baseline_homepage_url);
            const baselineBuffer = await getImageBuffer(baselineKey);

            if (!baselineBuffer) {
              await supabase.from('stores').update({ baseline_homepage_url: publicUrl }).eq('id', id);
              console.log('[YAYA Uptime] Baseline missing → updated to new screenshot (no alert)');
            } else {
              const newKey = urlToKey(publicUrl);
              const newBuffer = await getImageBuffer(newKey);

              if (!newBuffer) {
                console.error('[YAYA Uptime] Failed to download new screenshot — skipping comparison');
              } else {
                const result = compareImages(baselineBuffer, newBuffer);

                if (result.shouldUpdateBaseline) {
                  // Dimension changed — treat as new normal
                  await supabase.from('stores').update({ baseline_homepage_url: publicUrl }).eq('id', id);
                  console.log('[YAYA Uptime] Dimension changed — new baseline set');
                } else if (result.hasSignificantDiff) {
                  await supabase.from('alerts').insert({
                    store_id: id,
                    step: 'homepage',
                    before_url: baseline_homepage_url,
                    after_url: publicUrl,
                    diff_percentage: Math.round(result.diffPercentage * 100) / 100,
                    type: 'red'
                  });
                  console.log(`[YAYA Uptime] Alert created! Diff ${result.diffPercentage.toFixed(2)}%`);
                } else {
                  console.log(`[YAYA Uptime] No significant change (diff ${result.diffPercentage.toFixed(2)}%)`);
                  await supabase.from('stores').update({ baseline_homepage_url: publicUrl }).eq('id', id);
                }
              }
            }
          }
        } catch (err) {
          console.error('[YAYA Uptime] Baseline/diff/alert error:', err.message);
        }

      } catch (err) {
        console.error(`[YAYA Uptime] Store ${id} failed: ${err.message}`);
      } finally {
        await page.close();
      }
    }

    await browser.close();
    console.log('[YAYA Uptime] Finished processing all stores.');
  } catch (err) {
    console.error('[YAYA Uptime] Fatal startup/loop error:', err.message);
    process.exit(1);
  }
}

main();// Trigger redeploy
