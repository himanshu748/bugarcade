import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import seeds from '../../shared/challenges.json' with { type: 'json' };

const out = process.env.BUGARCADE_UI_EVIDENCE_DIR || 'evidence/ui';
fs.mkdirSync(out, { recursive: true });
test.skip(process.env.BUGARCADE_HOSTED_DEMO !== '1', 'Requires the separately built static arcade without an API proxy.');

// Optional pre-deployment HTTPS simulation: all traffic to the proposed site is
// fulfilled from the reviewed local build. This is not evidence of deployment.
test.beforeEach(async ({ context }) => {
  const artifact = process.env.BUGARCADE_STATIC_ARTIFACT_DIR;
  if (!artifact) return;
  const root = fs.realpathSync(artifact), base = new URL(process.env.BUGARCADE_BASE_URL!);
  test.info().annotations.push({ type: 'origin-simulation', description: 'HTTPS origin simulated from local static files; not deployed.' });
  await context.route(`${base.origin}${base.pathname}**`, async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const relative = pathname.slice(base.pathname.length) || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      await route.fulfill({ status: 404, body: 'Static artifact not found' }); return;
    }
    const mime: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.zip': 'application/zip' };
    await route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
  });
});

for (const seed of seeds) {
  test(`${seed.id}: three buggy failures and three fixed passes through hosted controls`, async ({ page }) => {
    const writes: string[] = [], foreign: string[] = [], errors: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() !== 'GET') writes.push(request.url());
      if (url.origin !== new URL(process.env.BUGARCADE_BASE_URL!).origin) foreign.push(request.url());
      if (url.pathname.includes('/api/')) foreign.push(request.url());
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`#play/${seed.id}`);
    await expect(page.locator('.app-status')).toContainText('Ready to break');
    await expect(page.locator('.app-window iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
    for (const variant of ['buggy', 'fixed'] as const) {
      await page.getByRole('button', { name: variant === 'buggy' ? 'Buggy' : 'Fixed', exact: true }).click();
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        await page.getByRole('button', { name: 'Run same actions', exact: true }).click();
        await expect(page.getByText(variant === 'buggy' ? 'There it is. You broke the app.' : 'The app kept its promise.', { exact: true })).toBeVisible();
        const app = page.frameLocator('.app-window iframe');
        await expect(app.getByTestId(seed.completion.target)).toHaveText(seed.completion.value);
        const actual = await app.getByTestId(seed.assertion.target).textContent();
        const passed = seed.assertion.operator === 'contains' ? actual!.includes(String(seed.assertion.expected)) : actual === String(seed.assertion.expected);
        expect(passed, `${variant} trial${ordinal}: unchanged intended assertion`).toBe(variant === 'fixed');
      }
    }
    await page.screenshot({ path: `${out}/hosted-${seed.id}-fixed.png`, fullPage: true, animations: 'disabled' });
    expect(writes).toEqual([]); expect(foreign).toEqual([]); expect(errors).toEqual([]);
  });
}

test('landing preview, reset, captured proof and evidence downloads work under a project prefix', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('');
  await expect(page.locator('.challenge-card')).toHaveCount(5);
  await expect(page.getByRole('link', { name: 'Get the starter locally', exact: true })).toHaveAttribute('href', 'https://github.com/himanshu748/bugarcade/blob/main/docs/GETTING_STARTED.md');
  expect(await page.locator('a[href^="/api/"]').count()).toBe(0);
  await page.screenshot({ path: `${out}/hosted-landing-desktop.png`, animations: 'disabled' });
  await page.getByRole('link', { name: 'See it in action', exact: true }).click();
  await page.getByRole('tab', { name: /03 Test the fix/ }).click();
  await expect(page.locator('.lp-result-fail')).toContainText('3 / 3');
  await expect(page.locator('.lp-result-pass')).toContainText('3 / 3');
  await page.getByRole('tab', { name: /01 Play the app/ }).click();
  await page.getByRole('button', { name: 'Play here', exact: true }).click();
  const preview = page.frameLocator('.lp-preview iframe');
  await preview.getByTestId('sync').click(); await preview.getByTestId('add-note').click(); await preview.getByTestId('release-save-1').click();
  await expect(page.locator('.lp-preview-status')).toContainText('The note disappeared');
  await page.getByRole('button', { name: 'Reset inline preview', exact: true }).click();
  await expect(preview.getByTestId('sync-state')).toHaveText('All changes local · 0 added');
  await expect(page.getByRole('link', { name: 'Inspect the Meta case', exact: true })).toHaveAttribute('href', /\/bugarcade\/proof\/view.html$/);
  await page.goto('#play/lost-note');
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await page.getByRole('tab', { name: 'The evidence', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Verify again locally', exact: true })).toHaveCount(0);
  const link = page.getByRole('link', { name: 'Regression test', exact: true });
  await expect(link).toHaveAttribute('href', /\/bugarcade\/_demo\/evidence\/seeds\/lost-note\/regression.test.mjs$/);
  let received: Buffer;
  if (process.env.BUGARCADE_STATIC_ARTIFACT_DIR) {
    // Chromium's file downloader can bypass route fulfillment. The HTTPS simulation
    // checks browser-fetched bytes; local and deployed runs exercise the real download.
    const href = await link.getAttribute('href');
    received = Buffer.from(await page.evaluate(async url => {
      const response = await fetch(url!);
      if (!response.ok) throw new Error('Static test download unavailable');
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, href));
  } else {
    const download = page.waitForEvent('download'); await link.click(); const file = await (await download).path();
    received = fs.readFileSync(file!);
  }
  const original = fs.readFileSync('evidence/seeds/lost-note/regression.test.mjs');
  expect(createHash('sha256').update(received).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
  expect(errors).toEqual([]);
});

test('proof presentation keeps file fingerprints optional and original records reachable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390]) for (const file of ['proof/view.html', 'proof/heldout/view.html']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(file);
    await expect(page.getByRole('link', { name: 'Back to the arcade →', exact: true })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/[a-f0-9]{64}/);
    await page.screenshot({ path: `${out}/presentation-${file.includes('heldout') ? 'coupon' : 'note'}-${width}.png`, animations: 'disabled' });
    const technical = page.locator('details.fingerprint').first();
    await technical.locator('summary').focus();
    await technical.locator('summary').press('Enter');
    await expect(technical).toContainText('SHA-256');
    expect(await technical.innerText()).toMatch(/[a-f0-9]{64}/);
    await expect(page.getByRole('link', { name: 'Open the original evidence page', exact: true })).toHaveAttribute('href', 'index.html');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('creator and job routes stay read-only and mobile keyboard play remains usable', async ({ page }) => {
  const writes: string[] = []; page.on('request', request => { if (request.method() !== 'GET' || new URL(request.url()).pathname.includes('/api/')) writes.push(request.url()); });
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('#create'); await expect(page.getByRole('heading', { name: 'Run the creator locally.', exact: true })).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await page.goto('#job/6d18b3f942ea45698c972d6763ce3383'); await expect(page.getByRole('heading', { name: 'Run the creator locally.', exact: true })).toBeVisible();
  await page.goto(''); await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${out}/hosted-mobile.png`, fullPage: true, animations: 'disabled' });
  await page.goto('#play/lost-note'); const app = page.frameLocator('.app-window iframe');
  await app.getByTestId('sync').click(); await app.getByTestId('add-note').click(); await app.getByTestId('release-save-1').click();
  await expect(page.getByRole('region', { name: 'Your case progress', exact: true }).getByRole('img', { name: '2 of 3 stars', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Test the fix', exact: true }).click(); await expect(page.getByRole('region', { name: 'Your case progress', exact: true }).getByRole('img', { name: '3 of 3 stars', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset challenge', exact: true }).click(); await expect(page.locator('.move-count')).toHaveText('00');
  expect(writes).toEqual([]);
});

test('corrupt cartridge bytes fail closed and reset recovers', async ({ page }) => {
  const pattern = '**/_demo/fixtures/lost-note/buggy.html';
  await page.route(pattern, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>corrupted</p>' }));
  await page.goto('#play/lost-note'); await expect(page.locator('.app-status')).toContainText('did not match its build record');
  await expect(page.frameLocator('.app-window iframe').getByTestId('sync')).toHaveCount(0);
  await page.unroute(pattern); await page.getByRole('button', { name: 'Reset challenge', exact: true }).click();
  await expect(page.locator('.app-status')).toContainText('Ready to break');
});

test('captured Meta investigation and standalone buggy and fixed apps remain accessible', async ({ page }) => {
  await page.goto('proof/index.html');
  await expect(page.getByRole('heading', { name: 'The same test fails buggy and passes fixed.', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Exact exported regression test', exact: true })).toHaveAttribute('href', 'live/regression.test.mjs');
  for (const variant of ['buggy', 'fixed']) {
    await page.goto(`proof/live/player-${variant}.html`);
    await page.getByTestId('sync').click(); await page.getByTestId('add-note').click(); await page.getByTestId('release-save-1').click();
    await expect(page.getByTestId('sync-state')).toHaveText('Synced · 1 added');
    if (variant === 'fixed') await expect(page.getByTestId('notes')).toContainText('Book the demo slot');
    else await expect(page.getByTestId('notes')).not.toContainText('Book the demo slot');
  }
});
