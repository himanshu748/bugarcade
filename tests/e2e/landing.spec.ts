import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const evidenceRoot = process.env.BUGARCADE_UI_EVIDENCE_DIR || 'evidence/ui';
fs.mkdirSync(evidenceRoot, { recursive: true });

test('landing calls to action and section links enter real destinations', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  await expect(page.locator('.challenge-card')).toHaveCount(5);
  await page.locator('.lp-final-cta').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'BugArcade home' }).click();
  await expect(page.getByRole('heading', { name: /Can you make/ })).toBeInViewport();
  await page.getByRole('link', { name: 'See it in action' }).click();
  await expect(page.locator('#about')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Play here', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Open the full challenge', exact: true }).click();
  await expect(page).toHaveURL(/#play\/lost-note$/);
  await expect(page.frameLocator('iframe').getByTestId('sync')).toBeVisible();
  await page.getByRole('link', { name: 'The proof', exact: true }).click();
  await expect(page.locator('#proof')).toBeFocused();
  await expect(page.locator('.lp-artifacts')).toBeInViewport();
  await page.locator('header').getByRole('button', { name: 'Create a challenge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Give your bug a stage.' })).toBeVisible();
  await page.getByRole('link', { name: 'The arcade', exact: true }).click();
  await expect(page.locator('#challenges')).toBeFocused();
  const expected = ['lost-note', 'rollback', 'search', 'duplicate', 'cleanup'];
  for (let index = 0; index < expected.length; index++) {
    await page.locator('.challenge-card').nth(index).click();
    await expect(page).toHaveURL(new RegExp(`#play/${expected[index]}$`));
    await expect(page.frameLocator('iframe').locator('#app-root')).toBeVisible();
    await page.getByRole('link', { name: 'The arcade', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Start with the lost note' }).click();
  await expect(page).toHaveURL(/#play\/lost-note$/);
});

test('inline tour loses a real note, resets cleanly, and preserves it in the fixed build', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#about');
  await expect(page.locator('.lp-tour-sequence')).toHaveCount(0);
  await expect(page.locator('.lp-preview iframe')).toHaveCount(0);
  await page.getByRole('button', { name: 'Play here', exact: true }).click();
  const app = page.frameLocator('.lp-preview iframe');
  await expect(app.getByTestId('sync')).toBeVisible();
  await expect(page.locator('.lp-preview iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await page.evaluate(() => window.postMessage({ type: 'bugarcade:state', challengeId: 'lost-note', variant: 'buggy', moves: 99, ready: true, completed: true, assertionPassed: false }, '*'));
  await expect(page.locator('.lp-preview-status b')).toHaveText('00 MOVES');
  const moves = async () => {
    await app.getByTestId('sync').click();
    await app.getByTestId('add-note').click();
    await expect(app.getByTestId('notes')).toContainText('Book the demo slot');
    await app.getByTestId('release-save-1').click();
  };
  await moves();
  await expect(app.getByTestId('notes')).not.toContainText('Book the demo slot');
  await expect(page.locator('.lp-preview-status')).toContainText('There it is. The note disappeared.');
  await expect(page.locator('.lp-preview-status b')).toHaveText('03 MOVES');
  await page.getByRole('button', { name: 'Reset inline preview' }).click();
  await expect(page.locator('.lp-preview-status b')).toHaveText('00 MOVES');
  await expect(app.getByTestId('sync-state')).toHaveText('All changes local · 0 added');
  await expect(app.getByText('No requests waiting. Interact with the app above.')).toBeVisible();
  await page.getByRole('tab', { name: /Test the fix/ }).click();
  await expect(page.locator('.lp-result-fail')).toContainText('3 / 3 failures');
  await expect(page.locator('.lp-result-pass')).toContainText('3 / 3 passes');
  await page.getByRole('button', { name: 'Try the fixed build' }).click();
  await expect(page.locator('.lp-preview iframe')).toHaveAttribute('title', /fixed$/);
  await moves();
  await expect(app.getByTestId('notes')).toContainText('Book the demo slot');
  await expect(page.locator('.lp-preview-status')).toContainText('The note survived. Same moves, fixed build.');
  await expect(page.locator('.lp-preview-status b')).toHaveText('03 MOVES');
  expect(errors).toEqual([]);
  fs.writeFileSync(`${evidenceRoot}/landing-interaction.json`, JSON.stringify({ realBugInThreeMoves: true, resetClearedSchedule: true, sameFixedMovesRetainedNote: true, parentMessageRejected: true, pageErrors: errors }, null, 2));
});

test('opt-in reveal plays the captured recording and artifact links download real files', async ({ page }) => {
  await page.goto('/#about');
  await page.getByRole('tab', { name: /Reveal the cause/ }).click();
  await expect(page.locator('.lp-tour-copy')).toContainText('This is the solution.');
  await expect(page.locator('.lp-tour-sequence li')).toHaveCount(3);
  const video = page.locator('.lp-recording video');
  await expect(video).toHaveAttribute('preload', 'none');
  expect(await video.evaluate((element: HTMLVideoElement) => ({ autoplay: element.autoplay, paused: element.paused, controls: element.controls }))).toEqual({ autoplay: false, paused: true, controls: true });
  await video.scrollIntoViewIfNeeded();
  // Invoke the native media control action to exercise the actual captured WebM decoder.
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  const decoded = await video.evaluate((element: HTMLVideoElement) => ({ width: element.videoWidth, duration: element.duration, error: element.error }));
  expect(decoded.width).toBeGreaterThan(0);
  expect(decoded.duration).toBeGreaterThan(0);
  expect(decoded.error).toBeNull();
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  const downloads: { label: string; filename: string; bytes: number }[] = [];
  for (const label of ['The regression test', 'The browser trace', 'The evidence record', 'Download Starter v1']) {
    const link = page.getByRole('link', { name: new RegExp(`^${label}`) });
    const waiting = page.waitForEvent('download');
    await link.click();
    const download = await waiting;
    const saved = await download.path();
    expect(await download.failure()).toBeNull();
    const bytes = fs.statSync(saved!).size;
    expect(bytes).toBeGreaterThan(100);
    downloads.push({ label, filename: download.suggestedFilename(), bytes });
  }
  fs.writeFileSync(`${evidenceRoot}/landing-downloads.json`, JSON.stringify(downloads, null, 2));
  fs.writeFileSync(`${evidenceRoot}/landing-recording.json`, JSON.stringify({ src: '/api/artifacts/lost-note/buggy-1/recording.webm', decoded, autoplay: false, controls: true, textAlternative: 'authored action sequence' }, null, 2));
});

test('missing and weakened evidence cannot show a verified result and retry recovers', async ({ page }) => {
  await page.route('**/api/challenges/lost-note/evidence', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Captured evidence is temporarily offline.' }) }));
  await page.goto('/#about');
  await page.getByRole('tab', { name: /Test the fix/ }).click();
  await expect(page.locator('#tour-panel')).toContainText('Captured evidence is unavailable.');
  await expect(page.locator('.lp-result-pass')).toHaveCount(0);
  await page.unroute('**/api/challenges/lost-note/evidence');
  await page.route('**/api/challenges/lost-note/evidence', async route => {
    const response = await route.fetch();
    const body = await response.json(); body.assertion.expected = 'Ship the rough cut';
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Retry evidence' }).click();
  await expect(page.locator('#tour-panel')).toContainText('has not met the verification contract');
  await expect(page.locator('.lp-result-pass')).toHaveCount(0);
  await page.unroute('**/api/challenges/lost-note/evidence');
  await page.route('**/api/artifacts/lost-note/fixed-2/result.json', async route => {
    const response = await route.fetch();
    const body = await response.json(); body.status = 'failed'; body.error = 'browser timeout';
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Retry evidence' }).click();
  await expect(page.locator('#tour-panel')).toContainText('Three matching buggy failures and fixed passes are required');
  await expect(page.locator('.lp-result-pass')).toHaveCount(0);
  await page.unroute('**/api/artifacts/lost-note/fixed-2/result.json');
  await page.getByRole('button', { name: 'Retry evidence' }).click();
  await expect(page.locator('.lp-result-pass')).toContainText('3 / 3 passes');
});

test('unavailable inline app reports startup failure and reset recovers', async ({ page }) => {
  await page.route('**/fixture/**', route => route.abort());
  await page.goto('/#about');
  await page.getByRole('button', { name: 'Play here', exact: true }).click();
  await expect(page.locator('.lp-preview-status')).toContainText('The preview did not start. Reset it to try again.', { timeout: 15000 });
  await expect(page.locator('.lp-preview-status')).not.toContainText('The note disappeared.');
  await page.unroute('**/fixture/**');
  await page.getByRole('button', { name: 'Reset inline preview' }).click();
  await expect(page.frameLocator('.lp-preview iframe').getByTestId('sync')).toBeVisible();
  await expect(page.locator('.lp-preview-status')).toContainText('You control the app');
});

test('stalled evidence reaches its deadline without claiming verification', async ({ page }) => {
  await page.route('**/api/challenges/lost-note/evidence', () => { /* Simulate a connection that never responds. */ });
  await page.goto('/#about');
  await page.getByRole('tab', { name: /Test the fix/ }).click();
  await expect(page.locator('#tour-panel')).toContainText('Evidence request timed out. Try again.', { timeout: 15000 });
  await expect(page.locator('.lp-result-pass')).toHaveCount(0);
  await page.unroute('**/api/challenges/lost-note/evidence');
  await page.getByRole('button', { name: 'Retry evidence' }).click();
  await expect(page.locator('.lp-result-pass')).toContainText('3 / 3 passes');
});

test('mobile menu, keyboard tour, FAQ and reduced-motion layouts remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await expect(page.locator('header nav')).not.toBeVisible();
  await menu.press('Enter');
  await expect(page.getByRole('link', { name: 'The arcade', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.press('Enter');
  await page.getByRole('link', { name: 'How it works', exact: true }).click();
  await expect(page.locator('#about')).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  const play = page.getByRole('tab', { name: /Play the app/ });
  await play.press('End');
  await expect(page.getByRole('tab', { name: /Test the fix/ })).toBeFocused();
  await expect(page.getByRole('tab', { name: /Test the fix/ })).toHaveAttribute('aria-selected', 'true');
  expect(await page.locator('.lp-tour-panel').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.keyboard.press('Home');
  await expect(play).toBeFocused();
  await page.getByRole('button', { name: 'Play here', exact: true }).click();
  await expect(page.frameLocator('.lp-preview iframe').getByTestId('sync')).toBeVisible();
  expect(await page.frameLocator('.lp-preview iframe').locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.lp-faq-items summary').first().press('Enter');
  await expect(page.locator('.lp-faq-items details').first()).toHaveAttribute('open', '');
  await expect(page.locator('.lp-faq-items details').first().locator('p')).toBeVisible();
  const layout: unknown[] = [];
  for (const width of [360, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const state = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, continuousAnimations: [...document.querySelectorAll('main *')].filter(element => getComputedStyle(element).animationIterationCount === 'infinite').length }));
    expect(state.scrollWidth).toBe(state.width);
    expect(state.continuousAnimations).toBe(0);
    layout.push(state);
  }
  fs.writeFileSync(`${evidenceRoot}/landing-accessibility.json`, JSON.stringify({ rovingTabs: true, menuEscapeFocus: true, sectionFocus: true, FAQKeyboard: true, reducedPanelAnimation: 'none', layouts: layout }, null, 2));
});
