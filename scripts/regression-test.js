// Regression check for src/index.html. Not a build step, but not manual-
// only either: .github/workflows/regression-test.yml runs it in CI on
// every push/PR that touches src/index.html, this script, this workflow,
// or package.json/package-lock.json - and it's also meant to be run by
// hand after making changes, before shipping them, same as before CI
// existed.
//
// Requires Playwright (`npm install playwright` if it isn't already on
// your machine) and a local server pointed at the build you want to test:
//
//   python3 -m http.server 8000 --directory src     # unminified dev build
//   python3 -m http.server 8000                     # minified prod build (repo root)
//
// then:
//
//   BASE_URL=http://localhost:8000 node scripts/regression-test.js
//
// BASE_URL defaults to http://localhost:8000. Exits non-zero if any check
// fails, which is what CI treats as a failed run, and what makes it worth
// running by hand before pushing too.
//
// Covers the flows that are easy to break silently while editing
// src/index.html: routing, cart/checkout arithmetic, delivery-fee
// tiers, discount codes, admin add-product (incl. sale price display),
// search, and signup validation. It does NOT cover anything that needs
// a real Supabase/Stripe round trip (payment, real auth, persisted
// writes) - those still need a manual check against the live site.

const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

const ROUTES = [
  '#/', '#/shop', '#/about', '#/delivery-info', '#/contact', '#/guide',
  '#/new-arrivals', '#/best-sellers', '#/special-offers', '#/bundles', '#/combos',
  '#/build-bundle', '#/checkout', '#/login', '#/signup', '#/forgot-password',
  '#/orders', '#/notifications', '#/refer', '#/admin', '#/privacy', '#/terms',
  '#/returns', '#/cookie-policy', '#/delivery-policy', '#/buy-again',
];

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Every check here is meant to deterministically exercise the local-only
// "preview mode" fallback (no live Supabase write, no real Stripe call),
// the same path a developer without live credentials sees - not because
// that's the only path worth testing, but because it's the only one this
// script can safely and reproducibly exercise everywhere: real CI runners
// have real internet access (unlike some sandboxes), so without this,
// supabaseClient would go non-null there and admin add-product would
// silently take the real-RPC branch instead of the local one this script
// asserts against - and a regression run must never depend on, or write
// to, the live Supabase project. Blocking the Supabase JS library itself
// (not just its API calls) keeps window.supabase/supabaseClient exactly
// as absent as they are with no network at all, in every environment.
// Cloudflare's RUM beacon is blocked too since it always CORS-fails
// against a localhost origin anyway (real, harmless noise, not a bug),
// and Stripe's script just isn't needed for anything checked here.
const BLOCKED_SCRIPT_PATTERN = /supabase-js|js\.stripe\.com|cloudflareinsights\.com/;
async function newPage(browser) {
  const page = await browser.newContext().then((ctx) => ctx.newPage());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/*', (route) => {
    if (BLOCKED_SCRIPT_PATTERN.test(route.request().url())) return route.abort();
    return route.continue();
  });
  return page;
}

async function gotoHash(page, hash) {
  await page.evaluate((h) => {
    window.location.hash = h;
    if (typeof route === 'function') route();
  }, hash);
  await page.waitForTimeout(400);
}

async function dismissWelcome(page) {
  const gotIt = await page.$('button:has-text("Got it")');
  if (gotIt) { await gotIt.click(); await page.waitForTimeout(150); }
}

(async () => {
  const browser = await chromium.launch();

  // --- Route sweep: every named route + a 404 + a product/category/group page should load with zero console/page errors ---
  await check('route sweep: zero console/page errors', async () => {
    const page = await newPage(browser);
    const errors = [];
    let currentRoute = 'boot';
    page.on('pageerror', (err) => errors.push(`[${currentRoute}] pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_CERT_AUTHORITY_INVALID|Failed to load resource/.test(text)) return;
      // sw.js lives at the repo root, not inside src/ - expected 404 (and
      // the resulting "Service worker registration failed") when BASE_URL
      // points at a server serving only the src/ directory.
      if (/sw\.js|fetching the script/.test(text)) return;
      errors.push(`[${currentRoute}] console.error: ${text}`);
    });

    await page.goto(BASE_URL);
    await page.waitForTimeout(700);
    await dismissWelcome(page);

    const firstCatSlug = await page.evaluate(() => CATEGORIES[0].slug);

    for (const route of ROUTES) {
      currentRoute = route;
      await gotoHash(page, route);
    }
    currentRoute = '#/this-should-404';
    await gotoHash(page, currentRoute);
    const notFoundShown = await page.evaluate(() => {
      const el = document.getElementById('view-not-found');
      return el && !el.classList.contains('hidden-view');
    });
    if (!notFoundShown) errors.push('unknown hash did not render view-not-found');

    currentRoute = '#/product/' + firstCatSlug + '/0';
    await gotoHash(page, currentRoute);
    currentRoute = '#/category/' + firstCatSlug;
    await gotoHash(page, currentRoute);

    await page.close();
    assert(errors.length === 0, `${errors.length} error(s):\n` + errors.join('\n'));
  });

  // --- Cart + checkout arithmetic across quantity changes and weight-tier delivery fee ---
  await check('cart/checkout arithmetic stays consistent across quantity changes', async () => {
    const page = await newPage(browser);
    await page.goto(BASE_URL);
    await page.waitForTimeout(700);
    await dismissWelcome(page);

    await page.evaluate(() => {
      const p = getProduct(CATEGORIES[0].slug, 0);
      addToCart(p, 1);
    });
    await gotoHash(page, '#/checkout');

    async function readTotals() {
      return page.evaluate(() => {
        const sub = parseFloat(document.getElementById('sumSubtotal').textContent.replace('£', ''));
        const deliveryText = document.getElementById('sumDelivery').textContent;
        const del = deliveryText.trim() === 'Free' ? 0 : parseFloat(deliveryText.replace('£', ''));
        const tot = parseFloat(document.getElementById('sumTotal').textContent.replace('£', ''));
        return { sub, del, tot };
      });
    }

    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => document.querySelectorAll('.cart-qty button')[1]?.click());
      await page.waitForTimeout(60);
    }
    let t = await readTotals();
    assert(Math.abs(t.sub + t.del - t.tot) < 0.01, `after qty+15: subtotal ${t.sub} + delivery ${t.del} != total ${t.tot}`);

    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => document.querySelectorAll('.cart-qty button')[0]?.click());
      await page.waitForTimeout(60);
    }
    t = await readTotals();
    assert(Math.abs(t.sub + t.del - t.tot) < 0.01, `after qty-10: subtotal ${t.sub} + delivery ${t.del} != total ${t.tot}`);
    assert(t.sub >= 50 ? t.del === 0 : true, `subtotal £${t.sub} is over the free-delivery threshold but delivery is still £${t.del}`);

    await page.close();
  });

  // --- Discount code: must never hard-crash, whether it succeeds or fails ---
  await check('discount code field fails gracefully (no crash) when unreachable', async () => {
    const page = await newPage(browser);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(BASE_URL);
    await page.waitForTimeout(700);
    await dismissWelcome(page);
    await page.evaluate(() => addToCart(getProduct(CATEGORIES[0].slug, 0), 1));
    await gotoHash(page, '#/checkout');

    await page.fill('#discountCodeInput', 'TESTCODE').catch(() => {});
    await page.click('#applyDiscountBtn').catch(() => {});
    await page.waitForTimeout(600);

    await page.close();
    assert(errors.length === 0, `discount code entry threw: ${errors.join('; ')}`);
  });

  // --- Admin add-product: sale price + best-seller flag save correctly and render with strikethrough on the PD page ---
  await check('admin add-product: sale price saves and renders with strikethrough on its own PD page', async () => {
    const page = await newPage(browser);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(BASE_URL);
    await page.waitForTimeout(700);
    await dismissWelcome(page);

    const catSlug = await page.evaluate(() => {
      document.body.classList.add('edit-mode-on');
      const c = CATEGORIES[0];
      window.location.hash = '#/category/' + c.slug;
      if (typeof route === 'function') route();
      return c.slug;
    });
    await page.waitForTimeout(500);

    await page.click('#addProductBtnShop');
    await page.waitForTimeout(300);
    const uid = 'addProductSlotShop';
    await page.fill(`#apf-name-${uid}`, 'Regression Sale Product');
    await page.fill(`#apf-unit-${uid}`, '1kg');
    await page.fill(`#apf-price-${uid}`, '9.99');
    await page.fill(`#apf-sale-${uid}`, '7.49');
    await page.fill(`#apf-weight-${uid}`, '1');
    const bestSellerCheckbox = await page.$(`#apf-isbestseller-${uid}`);
    if (bestSellerCheckbox) await bestSellerCheckbox.check();
    await page.click(`#apf-save-${uid}`).catch(() => page.click('button:has-text("Add product")'));
    await page.waitForTimeout(500);

    const added = await page.evaluate((slug) => {
      const cat = findCategory(slug);
      const idx = cat.products.findIndex((p) => p && p.name === 'Regression Sale Product');
      return { idx, product: idx >= 0 ? cat.products[idx] : null };
    }, catSlug);
    assert(added.idx >= 0, 'product was not added to the category after form submit');
    assert(added.product.salePrice === 7.49, `salePrice was ${added.product.salePrice}, expected 7.49`);

    const inBestSellers = await page.evaluate(() => bestSellerItems().some((p) => p.name === 'Regression Sale Product'));
    assert(inBestSellers, 'best-seller flag did not carry through to bestSellerItems()');

    await gotoHash(page, '#/product/' + catSlug + '/' + added.idx);
    const pdHtml = await page.evaluate(() => document.getElementById('pdPrice')?.innerHTML || '');
    assert(pdHtml.includes('7.49') && pdHtml.includes('9.99'), `pdPrice HTML missing sale/was price: ${pdHtml}`);
    assert(/price-was/.test(pdHtml), `pdPrice HTML missing .price-was strikethrough element: ${pdHtml}`);

    await page.close();
    assert(errors.length === 0, `admin add-product flow threw: ${errors.join('; ')}`);
  });

  // --- Search: exact substring match and empty-result handling ---
  await check('search returns matches for a known product and nothing for gibberish', async () => {
    const page = await newPage(browser);
    await page.goto(BASE_URL);
    await page.waitForTimeout(700);
    await dismissWelcome(page);

    const knownName = await page.evaluate(() => CATEGORIES[0].products[0].name);
    const results1 = await page.evaluate((name) => searchProducts(name.split(' ')[0]), knownName);
    assert(results1.length > 0, `searchProducts() found nothing for a real product name ("${knownName}")`);

    const results2 = await page.evaluate(() => searchProducts('zzzznonexistentproductxyz'));
    assert(results2.length === 0, `searchProducts() returned ${results2.length} results for a nonsense query, expected 0`);

    await page.close();
  });

  // --- Signup: native validation blocks a too-short password and a malformed email ---
  await check('signup form blocks short password and invalid email before submit', async () => {
    const page = await newPage(browser);
    await page.goto(BASE_URL + '/#/signup');
    await page.waitForTimeout(700);
    await dismissWelcome(page);

    await page.fill('#suName', 'Regression Test');
    await page.fill('#suEmail', 'regression@example.com');
    await page.fill('#suPassword', '123');
    await page.click('button:has-text("Create account")');
    await page.waitForTimeout(200);
    let stillOnSignup = page.url().includes('signup');
    assert(stillOnSignup, 'a 3-character password did not block signup submission');

    await page.fill('#suPassword', 'validpass123');
    await page.fill('#suEmail', 'not-an-email');
    await page.click('button:has-text("Create account")');
    await page.waitForTimeout(200);
    stillOnSignup = page.url().includes('signup');
    assert(stillOnSignup, 'a malformed email did not block signup submission');

    await page.close();
  });

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Failed: ' + failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
})();
