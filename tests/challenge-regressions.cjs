const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(process.env.VLM_SOURCE || path.join(__dirname, '../via-location-mask.user.js'), 'utf8');

// Cloudflare challenge documents and Trusted Types pages, served by Playwright
// routing (no real network). Response headers must never switch protection
// off; only the user's site rules decide. Live challenges need a device run.
const settings = { enabled: true, latitude: 35.68, longitude: 139.76, approximateSeed: 1, timezoneEnabled: true, timezone: 'Asia/Tokyo', siteMode: 'all', floatingButtonEnabled: true };
const TT = "default-src 'none'; script-src 'nonce-n' 'unsafe-eval'; style-src 'unsafe-inline'; frame-src *; require-trusted-types-for 'script'";
function injection(uiState, overrides) {
  const stored = JSON.stringify({ ...settings, ...overrides });
  return `(() => { let root = window; try { if (top.__vlmStore) root = top; } catch (_) {}
    root.__vlmStore = root.__vlmStore || { "via-location-mask.settings.v1": ${JSON.stringify(stored)}, "via-location-mask.ui.v1": ${JSON.stringify(uiState)} };
    window.GM_getValue = (k, d) => (k in root.__vlmStore ? root.__vlmStore[k] : d); window.GM_setValue = (k, v) => { root.__vlmStore[k] = v; };
    window.__menus = []; window.GM_registerMenuCommand = (name, fn) => { window.__menus.push(fn); }; })();\n${source}`;
}
function probe() {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ui: document.querySelectorAll('[data-vlm-fab-host],[data-vlm-onboarding-host]').length,
    menus: (window.__menus || []).length,
    violations: (window.__violations || []).slice(),
  };
}

let browser, total = 0, failures = 0;
async function check(name, run) { total++; try { await run(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + '\n' + e.stack); } }
async function visit(url, headers, uiState = '{"onboardingSeen":true}', overrides = {}) {
  const ctx = await browser.newContext({ timezoneId: 'America/New_York' });
  try {
    await ctx.addInitScript(injection(uiState, overrides));
    await ctx.route('**/*', (route) => {
      const url = route.request().url();
      const frame = url.includes('/with-frame') ? '<iframe src="http://widget.test/frame"></iframe>' : '';
      route.fulfill({
        contentType: 'text/html',
        headers: url.includes('widget.test') ? { 'Content-Security-Policy': TT } : headers,
        body: `<!doctype html><body><script nonce="n">window.__violations=[];addEventListener('securitypolicyviolation',e=>__violations.push(e.violatedDirective))</script>${frame}</body>`,
      });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForTimeout(500);
    const top = await page.evaluate(probe);
    const child = page.frames().find((frame) => frame.url().includes('widget.test'));
    const result = { top, child: child ? await child.evaluate(probe) : null, errors };
    result.geo = await page.evaluate(async () => ({
      permission: (await navigator.permissions.query({ name: 'geolocation' })).state,
      position: await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition((p) => resolve(p.coords.latitude.toFixed(2) + ',' + p.coords.longitude.toFixed(2)),
          (e) => resolve('error ' + e.code));
        setTimeout(() => resolve('timeout'), 3000);
      }),
    }));
    if (top.menus) result.panel = await page.evaluate(() => { __menus[0](); return document.querySelectorAll('[data-vlm-panel-host]').length; });
    return result;
  } finally { await ctx.close(); }
}

(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  console.log('Browser ' + browser.version());
  await check('ordinary page is still spoofed (control)', async () => {
    const result = await visit('http://site.test/', {});
    assert.equal(result.top.timezone, 'Asia/Tokyo');
    assert.equal(result.top.menus, 2);
    assert.deepEqual(result.errors, []);
  });
  // A site controls its own Server-Timing names: `chlray` must not disable
  // protection (v1.0.14 did, restoring the native timezone and permission flow).
  await check('a site sending Server-Timing chlray stays protected', async () => {
    const result = await visit('http://site.test/', { 'Server-Timing': 'chlray;desc="8a1b2c3d4e5f6a7b"', 'Content-Security-Policy': TT });
    assert.equal(result.top.timezone, 'Asia/Tokyo');
    assert.equal(result.top.menus, 2);
    assert.equal(result.top.ui, 1);
    assert.deepEqual(result.geo, { permission: 'granted', position: '35.68,139.76' });
    assert.deepEqual(result.errors, []);
  });
  await check('challenges.cloudflare.com follows the default all-sites scope', async () => {
    const result = await visit('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/', { 'Content-Security-Policy': TT });
    assert.equal(result.top.timezone, 'Asia/Tokyo');
    assert.deepEqual(result.errors, []);
  });
  await check('a user denylist entry turns protection off for the challenge frame', async () => {
    const denylist = { siteMode: 'denylist', sitePatterns: ['challenges.cloudflare.com'] };
    const excluded = await visit('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/', { 'Content-Security-Policy': TT }, undefined, denylist);
    assert.equal(excluded.top.timezone, 'America/New_York');
    assert.deepEqual(excluded.errors, []);
    const other = await visit('http://site.test/', {}, undefined, denylist);
    assert.equal(other.top.timezone, 'Asia/Tokyo');
  });
  for (const uiState of ['{"onboardingSeen":true}', '{}']) {
    await check(`Trusted Types page UI raises no errors or violations (${uiState === '{}' ? 'first run' : 'returning'})`, async () => {
      const result = await visit('http://site.test/with-frame', { 'Content-Security-Policy': TT }, uiState);
      assert.deepEqual(result.errors, []);
      assert.equal(result.top.ui, 1);
      assert.deepEqual(result.top.violations, []);
      assert.equal(result.top.timezone, 'Asia/Tokyo');
      // A third-party widget frame is still spoofed but gets no UI or menus.
      assert.deepEqual(result.child, { timezone: 'Asia/Tokyo', ui: 0, menus: 0, violations: [] });
      assert.equal(result.panel, 1, 'settings panel did not open under Trusted Types');
    });
  }
})().catch((e) => { failures++; console.error(e); }).finally(async () => {
  if (browser) await browser.close();
  console.log(`RESULT ${total} groups; ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
});
