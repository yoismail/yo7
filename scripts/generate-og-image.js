// Regenerates og-image.png (the 1200x630 social-share preview image used
// by og:image/twitter:image) from the current #seal-mark SVG and brand
// copy. This image used to be a one-off hand-composed export with no
// generator in the repo, so every logo change silently left it stale -
// this renders it from source instead, the same way scripts/minify.py
// renders index.html from src/index.html.
//
// The mark's path data below must be kept in sync with #seal-mark /
// #seal-ring in src/index.html by hand (same requirement as SEAL_MARK_PNG,
// documented there) - there's no automated extraction, since this is the
// only other place a logo change needs to be mirrored into a static PNG.
//
// Requires Playwright (`npm install playwright` if it isn't already on
// your machine). Run from the repo root:
//
//   node scripts/generate-og-image.js
//
// Writes og-image.png directly to the repo root, overwriting it.

const path = require('path');
const { chromium } = require('playwright');

const SEAL_RING_PATH = 'M 889.50,500.00 C 889.50,395.83 777.07,242.31 680.50,187.45 C 583.93,132.59 401.82,118.72 310.00,170.83 C 218.18,222.93 129.50,390.28 129.50,500.00 C 129.50,609.73 218.18,777.07 310.00,829.18 C 401.82,881.28 583.93,867.41 680.50,812.55 C 777.07,757.69 889.50,604.17 889.50,500.00 Z';
const SEAL_NUMERAL_PATH = 'M 376.50 319.50 L 642.50 319.50 L 462.00 737.50';

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,700;0,800;0,900&display=swap">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    font-family: 'Poppins', sans-serif;
    background: linear-gradient(135deg, #EFEBDA 0%, #FAF9F2 45%, #FAF9F2 100%);
    position: relative;
  }
  .watermark {
    position: absolute;
    top: -58px;
    right: 0px;
    font-family: 'Poppins', sans-serif;
    font-weight: 900;
    font-size: 570px;
    line-height: 1;
    color: #E9E7DC;
    user-select: none;
  }
  .icon {
    position: absolute;
    left: 110px;
    top: 258px;
    width: 130px;
    height: 125px;
  }
  .wordmark-block {
    position: absolute;
    left: 288px;
    top: 196px;
  }
  .wordmark {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .wordmark .yo7 {
    font-weight: 800;
    font-size: 54px;
    letter-spacing: -0.01em;
  }
  .wordmark .yo7 .dark { color: #063B00; }
  .wordmark .yo7 .accent { color: #90B800; }
  .wordmark .foods {
    font-weight: 700;
    font-size: 15px;
    letter-spacing: 0.22em;
    color: #90B800;
  }
  .tagline {
    margin-top: 12px;
    font-weight: 700;
    font-size: 32px;
    line-height: 1.15;
    color: #0D1704;
    max-width: 640px;
  }
  .subtext {
    margin-top: 14px;
    font-weight: 600;
    font-size: 18px;
    color: #8C8378;
  }
  .subtext .accent { color: #90B800; }
  .bottom-bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 19px;
    background: #5B8D08;
  }
</style>
</head>
<body>
  <div class="watermark">7</div>

  <svg class="icon" viewBox="65 25 875 900">
    <path d="${SEAL_RING_PATH}" fill="#042500" stroke="#90B800" stroke-width="66" stroke-linejoin="round" />
    <path d="${SEAL_NUMERAL_PATH}" fill="none" stroke="#FAF9F2" stroke-width="76" stroke-linecap="round" stroke-linejoin="round" />
  </svg>

  <div class="wordmark-block">
    <div class="wordmark">
      <span class="yo7"><span class="dark">YO</span><span class="accent">7</span></span>
      <span class="foods">FOODS</span>
    </div>
    <div class="tagline">Fresh African &amp; Caribbean groceries,<br>delivered with modern convenience.</div>
    <div class="subtext">UK-wide delivery &middot; Pickup in <span class="accent">Ipswich</span> &middot; Suffolk</div>
  </div>

  <div class="bottom-bar"></div>
</body>
</html>`;

(async () => {
    const launchOptions = process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {};
    const browser = await chromium.launch(launchOptions);
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const outPath = path.join(__dirname, '..', 'og-image.png');
    await page.screenshot({ path: outPath });
    await browser.close();
    console.log('Wrote', outPath);
})();
