import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const evidenceRoot = process.env.BUGARCADE_UI_EVIDENCE_DIR || 'evidence/ui';
fs.mkdirSync(evidenceRoot, { recursive: true });

test('motion follows real moves, reset, replay selection and visible proof stages', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/#play/lost-note');
  const stages = page.getByRole('list', { name: 'Challenge stages' });
  const current = stages.locator('[aria-current="step"]');
  await expect(current).toContainText('Play');
  const app = page.frameLocator('iframe');
  await expect(app.getByTestId('sync')).toBeVisible();
  await expect(page.locator('.move-count')).toHaveText('00');
  await app.getByTestId('sync').click();
  await expect(page.locator('.move-count')).toHaveText('01');
  expect(await page.locator('.move-count').evaluate(element => getComputedStyle(element).animationName)).toBe('arcade-count');
  await app.getByTestId('add-note').click();
  await expect(app.getByTestId('notes')).toContainText('Book the demo slot');
  await app.getByTestId('release-save-1').click();
  await expect(app.getByTestId('notes')).not.toContainText('Book the demo slot');
  await expect(page.getByText('There it is. You broke the app.')).toBeVisible();
  await expect(page.locator('.move-count')).toHaveText('03');
  await expect(current).toContainText('Play');
  await page.screenshot({ path: `${evidenceRoot}/motion-player-failure.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Reset challenge' }).click();
  await expect(page.locator('.move-count')).toHaveText('00');
  expect(await page.locator('.move-count').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await expect(current).toContainText('Reveal');
  await page.getByRole('button', { name: 'Fixed', exact: true }).click();
  await expect(page.locator('.segmented')).toHaveAttribute('data-variant', 'fixed');
  await expect(page.getByRole('button', { name: 'Fixed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const indicator = await page.locator('.segmented').evaluate(element => ({
    duration: getComputedStyle(element, '::before').transitionDuration,
    transform: getComputedStyle(element, '::before').transform,
  }));
  expect(indicator.duration).toContain('0.18s');
  await page.getByRole('button', { name: 'Run same actions' }).click();
  await expect(page.locator('.app-window')).toBeInViewport();
  await expect(page.getByText('The app kept its promise.')).toBeVisible();
  await expect(app.getByTestId('notes')).toContainText('Book the demo slot');
  await page.getByRole('tab', { name: 'The evidence', exact: true }).click();
  await expect(current).toContainText('Evidence');
  await expect(page.getByRole('heading', { name: 'Proof you can inspect.' })).toBeVisible();
  expect(await page.locator('.motion-panel').evaluate(element => getComputedStyle(element).animationName)).toBe('arcade-panel');
  const infinite = await page.evaluate(() => Array.from(document.querySelectorAll('main *')).filter(element => getComputedStyle(element).animationIterationCount === 'infinite').length);
  expect(infinite).toBe(0);
  expect(errors).toEqual([]);
  fs.writeFileSync(`${evidenceRoot}/motion-state-checks.json`, JSON.stringify({
    realBugTriggered: true, resetZeroHasNoCountAnimation: true, fixedReplayRetainedNote: true,
    stagesFollowVisiblePanel: true, indicator, continuousAnimations: infinite, pageErrors: errors,
  }, null, 2));
});

test('a replay waiting for an unavailable app stops and can be retried', async ({ page }) => {
  await page.goto('/#play/lost-note');
  await expect(page.frameLocator('iframe').getByTestId('sync')).toBeVisible();
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await page.route('**/fixture/**', route => route.abort());
  await page.getByRole('button', { name: 'Run same actions' }).click();
  await expect(page.getByText('The app did not become ready. Reset the challenge and try again.')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Run same actions' })).toBeEnabled();
  await expect(page.getByText('There it is. You broke the app.')).toHaveCount(0);
  await page.unroute('**/fixture/**');
  await page.getByRole('button', { name: 'Run same actions' }).click();
  await expect(page.getByText('There it is. You broke the app.')).toBeVisible();
});

test('reduced motion keeps mobile and keyboard interactions still and functional', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const card = page.locator('.challenge-card').first();
  await card.hover();
  await card.focus();
  const cardStyles = await card.evaluate(element => ({
    transform: getComputedStyle(element).transform,
    duration: getComputedStyle(element).transitionDuration,
    artwork: getComputedStyle(element.querySelector('.artwork')!).transform,
    arrow: getComputedStyle(element.querySelector('.card-arrow svg')!).transform,
  }));
  expect(cardStyles).toEqual({ transform: 'none', duration: '0s', artwork: 'none', arrow: 'none' });
  await page.screenshot({ path: `${evidenceRoot}/motion-gallery-mobile.png`, fullPage: true, animations: 'disabled' });
  await card.press('Enter');
  const app = page.frameLocator('iframe');
  await expect(app.getByTestId('sync')).toBeVisible();
  await app.getByTestId('sync').click();
  await expect(page.locator('.move-count')).toHaveText('01');
  expect(await page.locator('.move-count').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('button', { name: /A little nudge/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.hint-copy')).toBeVisible();
  expect(await page.locator('.hint-copy').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await page.getByRole('button', { name: 'Fixed', exact: true }).click();
  const selection = await page.locator('.segmented').evaluate(element => ({
    duration: getComputedStyle(element, '::before').transitionDuration,
    translateX: new DOMMatrixReadOnly(getComputedStyle(element, '::before').transform).m41,
  }));
  expect(selection.duration).toBe('0s');
  expect(selection.translateX).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'The replay', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'The evidence', exact: true })).toBeFocused();
  await expect(page.getByRole('list', { name: 'Challenge stages' }).locator('[aria-current="step"]')).toContainText('Evidence');
  expect(await page.locator('.motion-panel').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidenceRoot}/motion-evidence-mobile.png`, fullPage: true, animations: 'disabled' });
  fs.writeFileSync(`${evidenceRoot}/reduced-motion-checks.json`, JSON.stringify({
    viewport: { width: 390, height: 844 }, cardStyles, selection,
    counterAnimation: 'none', hintAnimation: 'none', panelAnimation: 'none', keyboardTabsWork: true, horizontalOverflow: false,
  }, null, 2));
});
