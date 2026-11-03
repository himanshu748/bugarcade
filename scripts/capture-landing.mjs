// Capture the running local UI without replacing app content or editing pixels.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.env.BUGARCADE_UI_EVIDENCE_DIR || 'evidence/landing');
const baseURL = process.env.BUGARCADE_BASE_URL || 'http://127.0.0.1:5173';
await fs.mkdir(root, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
const manifest = { capturedAt: new Date().toISOString(), browserVersion: browser.version(), captures: [], pageErrors: [], consoleErrors: [] };
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', error => manifest.pageErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') manifest.consoleErrors.push(message.text()); });
async function capture(name, locator = null, fullPage = false) {
  const file = path.join(root, name);
  if (locator) await locator.screenshot({ path: file, animations: 'disabled' });
  else await page.screenshot({ path: file, fullPage, animations: 'disabled' });
  manifest.captures.push({ name, viewport: page.viewportSize(), fullPage, element: locator ? await locator.evaluate(element => ({ tag: element.tagName, id: element.id, className: element.className, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })) : null,
    sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') });
}
try {
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: /Can you make/ })).toBeVisible();
  await capture('landing-desktop-hero.png');
  await capture('landing-desktop-full.png', null, true);
  await page.getByRole('link', { name: 'See it in action' }).click();
  await page.getByRole('button', { name: 'Play here', exact: true }).click();
  const app = page.frameLocator('.lp-preview iframe');
  await app.getByTestId('sync').click();
  await app.getByTestId('add-note').click();
  await app.getByTestId('release-save-1').click();
  await expect(page.locator('.lp-preview-status')).toContainText('The note disappeared.');
  // Keep the complete app onscreen so Chromium paints the entire iframe surface.
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.locator('#about').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await app.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await capture('landing-inline-bug.png', page.locator('#about'));
  await page.getByRole('tab', { name: /Test the fix/ }).click();
  await expect(page.locator('.lp-result-pass')).toContainText('3 / 3 passes');
  await capture('landing-verification.png', page.locator('#about'));
  await page.getByRole('button', { name: 'Try the fixed build' }).click();
  await app.getByTestId('sync').click();
  await app.getByTestId('add-note').click();
  await app.getByTestId('release-save-1').click();
  await expect(app.getByTestId('notes')).toContainText('Book the demo slot');
  await expect(page.locator('.lp-preview-status')).toContainText('The note survived.');
  await page.locator('#about').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await app.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await capture('landing-inline-fixed.png', page.locator('#about'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await capture('landing-mobile-hero.png');
  await capture('landing-mobile-full.png', null, true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await capture('landing-mobile-menu.png');
  await page.getByRole('link', { name: 'How it works', exact: true }).click();
  await page.getByRole('button', { name: 'Play here', exact: true }).click();
  await expect(app.getByTestId('sync')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.locator('.lp-preview').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await app.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await capture('landing-mobile-app.png', page.locator('.lp-preview'));
  manifest.note = 'Normal interaction viewports are 1440x1000 and 390x844. Expanded capture heights keep full iframes onscreen. No screenshots are composited or retouched.';
  if (manifest.pageErrors.length || manifest.consoleErrors.length) throw new Error('Inspect captured browser errors before accepting this pass.');
} finally {
  await fs.writeFile(path.join(root, 'capture-manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
}
console.log(`Captured ${manifest.captures.length} UI views in ${root}`);
