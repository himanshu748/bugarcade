import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const out = process.env.BUGARCADE_UI_EVIDENCE_DIR || 'evidence/ui';
fs.mkdirSync(out, { recursive: true });

test('real product and play action fit the first desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const heading = page.locator('#hero-title');
  const action = page.getByRole('button', { name: 'Play the challenge', exact: true });
  const shot = page.locator('.hero-product-shot img');
  await expect.poll(() => shot.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1280);
  await expect(shot).toHaveAttribute('fetchpriority', 'high');
  await expect(shot).not.toHaveAttribute('loading', 'lazy');
  for (const item of [heading, page.locator('.hero-subtitle'), action]) {
    const rect = await item.boundingBox();
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(800);
  }
  const visual = await shot.boundingBox();
  expect(visual!.y + visual!.height / 2).toBeLessThan(800);
  expect(await page.locator('.window-dots').count()).toBe(0);
  await page.screenshot({ path: `${out}/landing-1280.png`, animations: 'disabled' });
  await action.click();
  await expect(page).toHaveURL(/#play\/lost-note$/);
  await expect(page.frameLocator('iframe').getByTestId('sync')).toBeVisible();
});

test('the mobile arena puts actual play before guidance and personal scoring', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#play/lost-note');
  const app = page.locator('.app-window');
  await expect(page.frameLocator('iframe').getByTestId('sync')).toBeVisible();
  await expect(page.locator('.app-status')).toContainText('Ready to break.');
  const appRect = await app.boundingBox();
  const railRect = await page.getByRole('region', { name: 'Your case progress' }).boundingBox();
  expect(appRect!.y).toBeLessThan(500);
  expect(appRect!.y + appRect!.height).toBeLessThan(railRect!.y);
  await expect(page.getByRole('button', { name: 'Reset challenge' })).toBeVisible();
  expect(await page.locator('.window-dots').count()).toBe(0);
  await page.locator('iframe').focus();
  await expect.poll(() => page.locator('iframe').evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  expect(await page.locator('iframe').evaluate(el => parseFloat(getComputedStyle(el).outlineWidth))).toBeGreaterThanOrEqual(2);
  await page.frameLocator('iframe').getByTestId('sync').focus();
  await expect(page.locator('iframe')).toHaveAttribute('data-embedded-focus', '');
  await page.getByRole('button', { name: 'Reset challenge' }).focus();
  await expect(page.locator('iframe')).not.toHaveAttribute('data-embedded-focus', '');
  await page.screenshot({ path: `${out}/arena-mobile-viewport.png`, animations: 'disabled' });
});

test('case selection stays readable, bounded and keyboard usable across screen sizes', async ({ page }) => {
  await page.goto('/#challenges');
  await expect(page.locator('.challenge-card')).toHaveCount(5);
  const sizes: unknown[] = [];
  for (const width of [320, 390, 768, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await page.evaluate(() => ({ width: innerWidth, contentWidth: document.documentElement.scrollWidth,
      titleSizes: [...document.querySelectorAll('.challenge-card h3')].map(el => parseFloat(getComputedStyle(el).fontSize)),
      titleWidths: [...document.querySelectorAll('.challenge-card h3')].map(el => el.getBoundingClientRect().width),
      titleLines: [...document.querySelectorAll('.challenge-card h3')].map(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
      caseWidths: [...document.querySelectorAll('.challenge-card')].map(el => el.getBoundingClientRect().width) }));
    expect(layout.contentWidth).toBe(width);
    expect(layout.titleSizes.every(size => size >= 20)).toBe(true);
    expect(layout.titleWidths.every(size => size >= 160)).toBe(true);
    expect(layout.titleLines.every(lines => lines <= 3.05)).toBe(true);
    expect(layout.caseWidths.every(size => size <= width)).toBe(true);
    sizes.push(layout);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#challenges').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/case-selection-desktop.png`, animations: 'disabled' });
  await page.setViewportSize({ width: 375, height: 844 });
  await page.locator('#challenges').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/case-selection-mobile.png`, animations: 'disabled' });
  await page.locator('.challenge-card').nth(1).focus();
  await expect(page.locator('.challenge-card').nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#play\/rollback$/);
  await expect(page.frameLocator('iframe').locator('#app-root')).toBeVisible();
  fs.writeFileSync(`${out}/redesign-layouts.json`, JSON.stringify(sizes, null, 2));
});
