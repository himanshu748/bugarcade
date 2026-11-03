import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import seeds from '../../shared/challenges.json' with { type: 'json' };

const evidenceRoot = process.env.BUGARCADE_UI_EVIDENCE_DIR || 'evidence/ui';
fs.mkdirSync(evidenceRoot, { recursive: true });

test('gallery, keyboard entry, actual three-move bug, reset and fixed replay', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Can you make/ })).toBeVisible();
  await expect(page.locator('.challenge-card')).toHaveCount(5);
  await page.screenshot({ path: `${evidenceRoot}/gallery-desktop.png`, fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  await page.getByRole('button', { name: 'Play the challenge', exact: true }).click();
  const app = page.frameLocator('iframe');
  await expect(app.getByTestId('sync')).toBeVisible();
  await expect(page.getByText('WHAT WENT WRONG')).toHaveCount(0);
  await app.getByTestId('sync').click();
  await app.getByTestId('add-note').click();
  await expect(app.getByTestId('notes')).toContainText('Book the demo slot');
  await app.getByTestId('release-save-1').click();
  await expect(app.getByTestId('notes')).not.toContainText('Book the demo slot');
  await expect(page.getByText('There it is. You broke the app.')).toBeVisible();
  await expect(page.locator('.moves>b')).toHaveText('03');
  await page.screenshot({ path: `${evidenceRoot}/arena-buggy-desktop.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Reset challenge' }).click();
  await expect(page.locator('.moves>b')).toHaveText('00');
  await expect(app.getByTestId('sync-state')).toHaveText('All changes local · 0 added');
  await expect(app.getByText('No requests waiting. Interact with the app above.')).toBeVisible();
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Same moves. Different ending.' })).toBeVisible();
  await page.getByRole('button', { name: 'Fixed', exact: true }).click();
  await expect(app.getByTestId('sync')).toBeVisible();
  await page.getByRole('button', { name: 'Run same actions' }).click();
  await expect(page.getByText('The app kept its promise.')).toBeVisible();
  await expect(app.getByTestId('notes')).toContainText('Book the demo slot');
  await expect(page.locator('.moves>b')).toHaveText('03');
  await page.screenshot({ path: `${evidenceRoot}/arena-fixed-desktop.png`, fullPage: true, animations: 'disabled' });
  await expect(page.getByRole('button', { name: 'Run same actions' })).toBeEnabled();
  await page.getByRole('button', { name: 'Buggy', exact: true }).click();
  await page.getByRole('button', { name: 'Run same actions' }).click();
  await expect(page.getByText('There it is. You broke the app.')).toBeVisible();
  expect(errors).toEqual([]);
});

for (const seed of seeds.filter(c => c.id !== 'lost-note')) {
  test(`${seed.id}: same UI replay breaks buggy and preserves fixed invariant`, async ({ page }) => {
    await page.goto(`/#play/${seed.id}`);
    await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
    await page.getByRole('button', { name: 'Run same actions' }).click();
    await expect(page.getByText('There it is. You broke the app.')).toBeVisible();
    await page.getByRole('button', { name: 'Fixed', exact: true }).click();
    await page.getByRole('button', { name: 'Run same actions' }).click();
    await expect(page.getByText('The app kept its promise.')).toBeVisible();
    await page.screenshot({ path: `${evidenceRoot}/${seed.id}-fixed.png`, fullPage: true, animations: 'disabled' });
  });
}

test('mobile layout, keyboard hints, reduced motion and sandbox messaging', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.screenshot({ path: `${evidenceRoot}/gallery-mobile.png`, fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.challenge-card').first().evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
  await page.getByRole('button', { name: 'Play the challenge', exact: true }).click();
  await expect(page.frameLocator('iframe').getByTestId('sync')).toBeVisible();
  const hint = page.getByRole('button', { name: /A little nudge/ });
  await hint.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /Hide the hint/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.hint-copy')).toBeVisible();
  expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
  await page.evaluate(() => window.postMessage({ type: 'bugarcade:state', challengeId: 'lost-note', moves: 999, ready: true, completed: true, assertionPassed: false }, '*'));
  await expect(page.locator('.moves>b')).toHaveText('00');
  await expect(page.getByText('There it is. You broke the app.')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidenceRoot}/arena-mobile.png`, fullPage: true, animations: 'disabled' });
});

test('creation exposes supported layout and unavailable live credentials honestly', async ({ page }) => {
  await page.goto('/#create');
  await expect(page.getByRole('heading', { name: 'Give your bug a stage.' })).toBeVisible();
  await page.getByRole('radio', { name: /Live agent/ }).check();
  await expect(page.getByText('Live execution is disabled', { exact: true })).toBeVisible();
  const health = await (await page.request.get('/api/health')).json();
  await expect(page.locator('.live-notice')).toContainText(`Model provider: ${health.modelProvider === 'modal' ? 'Modal Shared Endpoint' : 'Baseten'}`);
  if (!health.modelConfigured) await expect(page.locator('.live-notice')).toContainText('access not configured');
  await expect(page.getByRole('button', { name: 'Investigate the bug' })).toBeDisabled();
  const response = await page.request.get('/api/starter');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('zip');
  await page.screenshot({ path: `${evidenceRoot}/create-live-disabled.png`, fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidenceRoot}/create-mobile.png`, fullPage: true, animations: 'disabled' });
});

test('recorded job is real, duplicate requests are idempotent, cancellation terminates', async ({ page }) => {
  await page.goto('/#create');
  await page.getByRole('button', { name: 'Run the recorded demo' }).click();
  await expect(page.getByRole('region', { name: 'Job progress' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Cancel run/ })).toBeVisible();
  await page.getByRole('button', { name: /Cancel run/ }).click();
  await expect(page.locator('.state-pill')).toHaveText('cancelled');
  const data = { challengeId: 'lost-note', mode: 'recorded', idempotencyKey: crypto.randomUUID() };
  const [a, b] = await Promise.all([page.request.post('/api/jobs', { data }), page.request.post('/api/jobs', { data })]);
  expect(a.ok()).toBe(true); expect(b.ok()).toBe(true);
  const aj = await a.json(), bj = await b.json(); expect(aj.id).toBe(bj.id);
  const conflict = await page.request.post('/api/jobs', { data: { ...data, challengeId: 'rollback' } });
  expect(conflict.status()).toBe(409);
  const cancelled = await page.request.post(`/api/jobs/${aj.id}/cancel`); expect((await cancelled.json()).state).toBe('cancelled');
  await page.screenshot({ path: `${evidenceRoot}/job-cancelled.png`, fullPage: true, animations: 'disabled' });
});

test('real backend recorded job completes and exposes truthful evidence', async ({ page }) => {
  const { limits } = await (await page.request.get('/api/health')).json();
  expect(limits.jobSeconds).toBeGreaterThan(0); expect(limits.jobSeconds).toBeLessThanOrEqual(300);
  test.setTimeout((limits.jobSeconds + 60) * 1000);
  await page.goto('/#create');
  await page.getByRole('button', { name: 'Run the recorded demo' }).click();
  await expect(page.locator('.state-pill')).toBeVisible();
  await page.reload();
  await expect(page.locator('.state-pill')).toBeVisible();
  await expect(page.locator('.state-pill')).toHaveText('completed', { timeout: (limits.jobSeconds + 10) * 1000 });
  await page.getByText('Inspect run result and provenance').click();
  await expect(page.locator('.job-progress pre')).toContainText('local-trusted-seeds');
  await expect(page.locator('.job-progress pre')).toContainText('authored-seed-plan');
  fs.writeFileSync(`${evidenceRoot}/real-job-result.json`, await page.locator('.job-progress pre').innerText());
  for (const link of ['Regression test', 'Run evidence', 'Challenge package', 'Starter source']) { const url = await page.getByRole('link', { name: link, exact: true }).getAttribute('href'); expect((await page.request.get(url!)).ok()).toBe(true); }
  await page.screenshot({ path: `${evidenceRoot}/job-completed.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('link', { name: 'Play created challenge', exact: true }).click();
  const packagedApp = page.frameLocator('iframe');
  await expect(packagedApp.getByTestId('sync')).toBeVisible();
  await packagedApp.getByTestId('sync').click();
  await packagedApp.getByTestId('add-note').click();
  await packagedApp.getByTestId('release-save-1').click();
  await expect(page.getByText('There it is. You broke the app.')).toBeVisible();
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await page.getByRole('button', { name: 'Fixed', exact: true }).click();
  await page.getByRole('button', { name: 'Run same actions' }).click();
  await expect(page.getByText('The app kept its promise.')).toBeVisible();
  // Repeat immediately with already-loaded fixed HTML: reset must not reuse stale readiness.
  await page.getByRole('button', { name: 'Run same actions' }).click();
  await expect(page.getByText('The app kept its promise.')).toBeVisible();
  await expect(page.locator('.moves>b')).toHaveText('03');
  await page.getByRole('tab', { name: 'The evidence' }).click();
  await expect(page.locator('.verification-grid')).toContainText('3');
  for (const link of ['Buggy trace', 'Fixed trace', 'Captured recording']) { const url = await page.getByRole('link', { name: link, exact: true }).getAttribute('href'); expect((await page.request.get(url!)).ok()).toBe(true); }
  await page.screenshot({ path: `${evidenceRoot}/created-cartridge.png`, fullPage: true, animations: 'disabled' });
});


test('captured seed evidence downloads all work and tabs support arrow keys', async ({ page }) => {
  await page.goto('/#play/lost-note');
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await page.getByRole('tab', { name: 'The replay', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'The evidence', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Proof you can inspect.' })).toBeVisible();
  await expect(page.locator('.verification-grid')).toContainText('3');
  for (const name of ['Regression test', 'Evidence JSON', 'Buggy trace', 'Fixed trace', 'Captured recording']) {
    const url = await page.getByRole('link', { name, exact: true }).getAttribute('href');
    const response = await page.request.get(url!); expect(response.status()).toBe(200); expect((await response.body()).length).toBeGreaterThan(0);
  }
  await page.screenshot({ path: `${evidenceRoot}/evidence-panel.png`, fullPage: true, animations: 'disabled' });
});

test('starter and real recording upload validates locally while cloud remains disabled', async ({ page }) => {
  test.setTimeout(45000);
  await page.goto('/#create');
  await page.getByRole('radio', { name: /Live agent/ }).check();
  const starter = await page.request.get('/api/starter');
  await page.locator('input[type=file]').nth(0).setInputFiles({ name: 'authorized-starter.zip', mimeType: 'application/zip', buffer: await starter.body() });
  await page.locator('input[type=file]').nth(1).setInputFiles('evidence/seeds/lost-note/buggy-1/recording.webm');
  await page.getByRole('checkbox', { name: /I own this source/ }).check();
  await page.getByRole('button', { name: 'Validate files locally' }).click();
  await expect(page.getByText('Starter and recording validated.')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/4 timestamped frames extracted/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Investigate the bug' })).toBeDisabled();
  await page.screenshot({ path: `${evidenceRoot}/validated-upload.png`, fullPage: true, animations: 'disabled' });
});

test('iframe top navigation is blocked and unavailable fixture has a recoverable error', async ({ page }) => {
  await page.goto('/#play/lost-note');
  await expect(page.frameLocator('iframe').getByTestId('sync')).toBeVisible();
  const app = page.frames().find(frame => frame.url().includes('/fixture/'))!;
  const blocked = await app.evaluate(() => { try { window.top!.location.href = 'http://127.0.0.1:5173/#escaped'; return false; } catch { return true; } });
  expect(blocked).toBe(true);
  expect(page.url()).toContain('#play/lost-note');
  await page.route('**/fixture/**', route => route.abort());
  await page.getByRole('button', { name: 'Reset challenge' }).click();
  await expect(page.getByText('App unavailable. Start the fixture server, then reset.')).toBeVisible({ timeout: 16000 });
  await page.unroute('**/fixture/**');
  await page.getByRole('button', { name: 'Reset challenge' }).click();
  await expect(page.frameLocator('iframe').getByTestId('sync')).toBeVisible();
});
