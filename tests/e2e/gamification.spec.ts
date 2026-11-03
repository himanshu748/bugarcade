import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import seeds from '../../shared/challenges.json' with { type: 'json' };

const out = process.env.BUGARCADE_UI_EVIDENCE_DIR || 'evidence/ui';
fs.mkdirSync(out, { recursive: true });
const rail = (page: Page) => page.getByRole('region', { name: 'Your case progress' });
const stars = (page: Page, count: number) => rail(page).getByRole('img', { name: `${count} of 3 stars` });

async function manualBug(page: Page, id = 'lost-note') {
  const seed = seeds.find(item => item.id === id)!;
  const app = page.frameLocator('.app-window iframe');
  await expect(page.locator('.app-window')).toHaveAttribute('data-variant', 'buggy');
  await expect(page.locator('.app-status')).toContainText('Ready to break');
  let fills = 0;
  for (const action of seed.actions) {
    if (action.type === 'click') await app.getByTestId(action.target!).click();
    if (action.type === 'fill') {
      await app.getByTestId(action.target!).fill(String(action.value));
      await app.getByTestId(action.target!).press('Tab');
      if (id === 'search') await expect(app.getByTestId(`release-search-${++fills}`)).toBeVisible();
    }
    if (action.type === 'release') await app.getByTestId(`release-${action.request}`).click();
  }
  await expect(page.getByText('There it is. You broke the app.', { exact: true })).toBeVisible();
}

test('manual play earns stars, reset preserves them, fixed replay clears and gallery continues', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#play/lost-note');
  await expect(stars(page, 0)).toBeVisible();
  await manualBug(page);
  await expect(stars(page, 2)).toBeVisible();
  await expect(rail(page)).toContainText('3 moves');
  await expect(page.getByRole('button', { name: 'Test the fix', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset challenge', exact: true }).click();
  await expect(page.locator('.move-count')).toHaveText('00');
  await expect(stars(page, 2)).toBeVisible();
  await page.reload();
  await expect(stars(page, 2)).toBeVisible();
  await page.getByRole('button', { name: 'Test the fix', exact: true }).click();
  await expect(page.getByText('The app kept its promise.', { exact: true })).toBeVisible();
  await expect(stars(page, 3)).toBeVisible();
  const reward = page.getByRole('region', { name: 'Personal case result' });
  await expect(reward).toContainText('CASE CLEARED');
  await expect(reward).toContainText('Personal play progress');
  await reward.screenshot({ path: `${out}/case-cleared-desktop.png`, animations: 'disabled' });
  await expect(reward.getByRole('link', { name: 'Next case' })).toHaveAttribute('href', '#play/rollback');
  await page.getByRole('button', { name: 'All challenges', exact: true }).click();
  const passport = page.getByLabel('Your arcade progress');
  await expect(passport.locator('progress')).toHaveAttribute('value', '1');
  await expect(passport.locator('.passport-star-score')).toContainText('3 / 15');
  await expect(page.locator('.challenge-card').first()).toContainText('CLEARED');
  await passport.screenshot({ path: `${out}/arcade-passport-desktop.png`, animations: 'disabled' });
  await passport.getByRole('button', { name: 'Continue playing' }).click();
  await expect(page).toHaveURL(/#play\/rollback$/);
  expect(errors).toEqual([]);
});

test('automated demonstrations and unrelated manual fixed states cannot earn a clear', async ({ page }) => {
  await page.goto('/#play/lost-note');
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await page.getByRole('button', { name: 'Run same actions', exact: true }).click();
  await expect(page.getByText('There it is. You broke the app.', { exact: true })).toBeVisible();
  await expect(stars(page, 0)).toBeVisible();
  await page.getByRole('button', { name: 'Fixed', exact: true }).click();
  await page.getByRole('button', { name: 'Run same actions', exact: true }).click();
  await expect(page.getByText('The app kept its promise.', { exact: true })).toBeVisible();
  await expect(stars(page, 0)).toBeVisible();
  await page.getByRole('button', { name: 'Buggy', exact: true }).click();
  await manualBug(page);
  await expect(stars(page, 2)).toBeVisible();
  await page.getByRole('button', { name: 'Fixed', exact: true }).click();
  const app = page.frameLocator('.app-window iframe');
  await expect(page.locator('.app-window')).toHaveAttribute('data-variant', 'fixed');
  await expect(page.locator('.app-status')).toHaveText('Fixed build ready. Run the same actions to check it.');
  await app.getByTestId('sync').click();
  await app.getByTestId('add-note').click();
  await app.getByTestId('release-save-1').click();
  await expect(page.getByText('The app kept its promise.', { exact: true })).toBeVisible();
  await expect(stars(page, 2)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Personal case result' })).not.toContainText('CASE CLEARED');
});

test('a longer manual run records its real best, then a shorter run improves it', async ({ page }) => {
  await page.goto('/#play/lost-note');
  const app = page.frameLocator('.app-window iframe');
  await app.getByTestId('draft').fill('A different draft');
  await app.getByTestId('draft').press('Tab');
  await app.getByTestId('draft').fill('Book the demo slot');
  await app.getByTestId('draft').press('Tab');
  await manualBug(page);
  await expect(stars(page, 1)).toBeVisible();
  await expect(rail(page)).toContainText('5 moves');
  await page.getByRole('button', { name: 'Reset challenge', exact: true }).click();
  await manualBug(page);
  await expect(stars(page, 2)).toBeVisible();
  await expect(rail(page)).toContainText('3 moves');
});

test('storage failure keeps mobile keyboard play usable, temporary and still under reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage denied', 'QuotaExceededError'); }; });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#play/lost-note');
  await expect(rail(page)).toContainText('Progress can’t be saved');
  await manualBug(page);
  const check = page.getByRole('button', { name: 'Test the fix', exact: true });
  await check.focus(); await page.keyboard.press('Enter');
  await expect(stars(page, 3)).toBeVisible();
  const reward = page.getByRole('region', { name: 'Personal case result' });
  expect(await reward.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await reward.screenshot({ path: `${out}/case-cleared-mobile.png`, animations: 'disabled' });
  await page.reload();
  await expect(stars(page, 0)).toBeVisible();
  expect(errors).toEqual([]);
});

test('all five real manual cases can be cleared and earn the fifteen-star cabinet', async ({ page }) => {
  test.setTimeout(90000);
  for (const seed of seeds) {
    await page.goto(`/#play/${seed.id}`);
    await manualBug(page, seed.id);
    await expect(stars(page, 2)).toBeVisible();
    await page.getByRole('button', { name: 'Test the fix', exact: true }).click();
    await expect(stars(page, 3)).toBeVisible();
    await expect(page.getByText('The app kept its promise.', { exact: true })).toBeVisible();
  }
  await page.goto('/#challenges');
  const passport = page.getByLabel('Your arcade progress');
  await expect(passport).toContainText('The cabinet is cleared.');
  await expect(passport.locator('progress')).toHaveAttribute('value', '5');
  await expect(passport.locator('.passport-star-score')).toContainText('15 / 15');
  await expect(page.locator('.arcade-card-progress.is-cleared')).toHaveCount(5);
  await passport.screenshot({ path: `${out}/all-five-cleared.png`, animations: 'disabled' });
});

test('a genuinely packaged recorded job earns separate stars and does not inflate seed progress', async ({ page }) => {
  const health = await (await page.request.get('/api/health')).json();
  const jobSeconds = health.limits.jobSeconds as number;
  expect(jobSeconds).toBeGreaterThan(0); expect(jobSeconds).toBeLessThanOrEqual(300);
  test.setTimeout((jobSeconds + 60) * 1000);
  await page.addInitScript(() => {
    const state = window as Window & { heldFinal?: unknown; holdFixedFinal?: boolean };
    state.holdFixedFinal = true;
    window.addEventListener('message', event => {
      if (state.holdFixedFinal && event.data?.type === 'bugarcade:state' && event.data.variant === 'fixed' && event.data.completed === true && event.data.replaying === false) {
        state.heldFinal = event.data; event.stopImmediatePropagation();
      }
    }, true);
  });
  // Optional real captured fixture avoids repeating investigation for this UI test.
  // The separate backend integration test still creates and verifies a fresh job.
  const capturedId = process.env.BUGARCADE_GAME_TEST_JOB_ID;
  if (capturedId) expect(capturedId).toMatch(/^[a-f0-9]{32}$/);
  const response = capturedId ? await page.request.get(`/api/jobs/${capturedId}`)
    : await page.request.post('/api/jobs', { data: { challengeId: 'lost-note', mode: 'recorded', idempotencyKey: crypto.randomUUID() } });
  expect(response.status()).toBe(capturedId ? 200 : 202);
  const job = await response.json();
  try {
    await expect.poll(async () => (await (await page.request.get(`/api/jobs/${job.id}`)).json()).state, { timeout: (jobSeconds + 10) * 1000, intervals: [500, 1000] }).toBe('completed');
  } finally {
    if (!capturedId) {
      const latest = await (await page.request.get(`/api/jobs/${job.id}`)).json();
      if (!['completed', 'failed', 'cancelled', 'not-reproduced'].includes(latest.state)) await page.request.post(`/api/jobs/${job.id}/cancel`);
    }
  }
  const captured = await (await page.request.get(`/api/jobs/${job.id}`)).json();
  expect(captured.result.verified).toBe(true);
  expect(captured.result.mode).toBe('recorded');
  expect(captured.result.modelCalls).toBe(0);
  expect(captured.result.actions).toEqual(seeds[0].actions);
  expect(captured.result.assertion).toEqual(seeds[0].assertion);
  for (const variant of ['buggy', 'fixed']) expect(captured.result.sourceHashes[variant]).toBe(createHash('sha256').update(fs.readFileSync(`fixtures/lost-note/${variant}/App.tsx`)).digest('hex'));
  await page.goto(`/#job/${job.id}`);
  await manualBug(page);
  await page.getByRole('button', { name: 'Test the fix', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { heldFinal?: unknown }).heldFinal))).toBe(true);
  const held = await page.evaluate(() => {
    const state = window as Window & { heldFinal?: unknown; holdFixedFinal?: boolean };
    state.holdFixedFinal = false; return state.heldFinal;
  });
  const app = page.frameLocator('.app-window iframe');
  // Synthetic child error, then its internal reset and real manual fixed actions.
  // None of these may inherit the interrupted replay's eligibility.
  await app.locator('body').evaluate((_element, data) => window.parent.postMessage({ ...data as object, error: 'Synthetic transport failure', replaying: false }, '*'), held);
  await expect(page.getByText('Synthetic transport failure', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: 'Reset cartridge', exact: true }).click();
  await expect(app.getByTestId('sync-state')).toHaveText('All changes local · 0 added');
  await app.getByTestId('sync').click(); await app.getByTestId('add-note').click();
  await app.getByTestId('release-save-1').click();
  await expect(app.getByTestId('notes')).toContainText('Book the demo slot');
  await expect(stars(page, 2)).toBeVisible();
  await expect(page.getByText('Synthetic transport failure', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset challenge', exact: true }).click();
  await page.getByRole('button', { name: 'Run same actions', exact: true }).click();
  await expect(stars(page, 3)).toBeVisible();
  await page.goto('/#challenges');
  const passport = page.getByLabel('Your arcade progress');
  await expect(passport.locator('progress')).toHaveAttribute('value', '0');
  await expect(passport.locator('.passport-star-score')).toContainText('0 / 15');
  fs.writeFileSync(`${out}/gamified-created-job.json`, JSON.stringify({ jobId: job.id, setup: capturedId ? 'existing-real-capture-with-source-action-assertion-checks' : 'fresh-recorded-job', mode: 'recorded', modelCalls: 0, separatePersonalStars: 3, seedStars: 0 }, null, 2));
});

test('independent tabs merge milestones without losing another case', async ({ page, context }) => {
  const second = await context.newPage();
  await page.goto('/#play/lost-note');
  await second.goto('/#play/cleanup');
  await Promise.all([manualBug(page), manualBug(second, 'cleanup')]);
  await page.goto('/#challenges');
  await expect(page.getByLabel('Your arcade progress').locator('.passport-star-score')).toContainText('4 / 15');
  await second.reload();
  await expect(stars(second, 2)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Your arcade progress').locator('.passport-star-score')).toContainText('4 / 15');
});

test('a late passing fixed message cannot earn a star after the parent replay deadline', async ({ page }) => {
  // Synthetic transport delay around a real fixed replay, never live-provider evidence.
  await page.addInitScript(() => {
    const state = window as Window & { heldFinal?: unknown; holdFixedFinal?: boolean };
    state.holdFixedFinal = true;
    window.addEventListener('message', event => {
      if (state.holdFixedFinal && event.data?.type === 'bugarcade:state' && event.data.variant === 'fixed' && event.data.completed === true && event.data.replaying === false) {
        state.heldFinal = event.data;
        event.stopImmediatePropagation();
      }
    }, true);
  });
  await page.goto('/#play/lost-note');
  await manualBug(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Test the fix', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { heldFinal?: unknown }).heldFinal))).toBe(true);
  const nonterminal = await page.evaluate(() => (window as Window & { heldFinal?: unknown }).heldFinal);
  await page.frameLocator('.app-window iframe').locator('body').evaluate((_element, data) => window.parent.postMessage({ ...data as object, completed: false, assertionPassed: null, moves: 0, actions: [], replaying: false }, '*'), nonterminal);
  await expect(page.getByRole('button', { name: 'Test the fix', exact: true })).toBeDisabled();
  await page.clock.fastForward(31000);
  const timeout = page.getByText('Replay exceeded its time limit. Reset the app and try again.', { exact: true });
  await expect(timeout).toBeVisible();
  const held = await page.evaluate(() => {
    const state = window as Window & { heldFinal?: unknown; holdFixedFinal?: boolean };
    state.holdFixedFinal = false;
    return state.heldFinal;
  });
  await page.frameLocator('.app-window iframe').locator('body').evaluate((_element, data) => window.parent.postMessage(data, '*'), held);
  await expect(stars(page, 2)).toBeVisible();
  await expect(timeout).toBeVisible();
  await expect(page.getByRole('region', { name: 'Personal case result' })).not.toContainText('CASE CLEARED');
  await page.getByRole('button', { name: 'Reset challenge', exact: true }).click();
  await page.getByRole('button', { name: 'Run same actions', exact: true }).click();
  await expect(stars(page, 3)).toBeVisible();
});

test('reconciling before persistence preserves progress newer than the initial mount snapshots', async ({ page }) => {
  // Fault injection: both development StrictMode initializer reads see an older value.
  await page.addInitScript(() => {
    const key = 'bugarcade:progress:v1';
    localStorage.setItem(key, JSON.stringify({ version: 1, cases: { 'seed:cleanup': { bugFound: true, targetMet: true, fixedChecked: false, bestMoves: 3 } } }));
    const read = Storage.prototype.getItem;
    let staleReads = 2;
    Storage.prototype.getItem = function (name) {
      if (this === localStorage && name === key && staleReads-- > 0) return null;
      return read.call(this, name);
    };
  });
  await page.goto('/#challenges');
  await expect(page.getByLabel('Your arcade progress').locator('.passport-star-score')).toContainText('2 / 15');
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('bugarcade:progress:v1')!));
  expect(persisted.cases['seed:cleanup'].bestMoves).toBe(3);
});

test('the mastery call to action selects a cleared case that still needs a star', async ({ page }) => {
  // Synthetic personal storage exercises navigation; it is not reproduction evidence.
  await page.addInitScript(ids => {
    const cases = Object.fromEntries(ids.map(id => [`seed:${id}`, { bugFound: true, targetMet: id !== 'cleanup', fixedChecked: true, bestMoves: id === 'cleanup' ? 5 : 3 }]));
    localStorage.setItem('bugarcade:progress:v1', JSON.stringify({ version: 1, cases }));
  }, seeds.map(seed => seed.id));
  await page.goto('/#challenges');
  await page.getByRole('button', { name: 'Chase three stars', exact: true }).click();
  await expect(page).toHaveURL(/#play\/cleanup$/);
});
