import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const liveId = '6d18b3f942ea45698c972d6763ce3383';
const recordedId = '8201bb48771d4760ad8aee993b7c9107';
const out = process.env.BUGARCADE_UI_EVIDENCE_DIR || 'evidence/ui';
fs.mkdirSync(out, { recursive: true });

async function openProof(page: Page, id = liveId) {
  await page.goto(`/#job/${id}`);
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await page.getByRole('tab', { name: 'The evidence', exact: true }).click();
  return page.getByRole('region', { name: 'Investigation decision record' });
}

test('actual Muse capture links proposals to browser actions, sampled input and six observable outcomes', async ({ page }) => {
  await page.goto('/#proof');
  const showcase = page.getByRole('complementary', { name: 'Captured Meta investigation' });
  await expect(showcase).toContainText('REAL MUSE PROPOSALS · ONE KNOWN SEED');
  await showcase.getByRole('link', { name: 'Inspect the Meta case' }).click();
  await expect(page).toHaveURL(new RegExp(`#job/${liveId}$`));
  await expect(page.getByRole('region', { name: 'Investigation decision record' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await page.getByRole('tab', { name: 'The evidence', exact: true }).click();
  const proof = page.getByRole('region', { name: 'Investigation decision record' });
  await expect(proof.getByRole('heading', { name: 'Model proposed. Browser judged.' })).toBeVisible();
  await expect(proof.locator('.decision-actions li')).toHaveCount(4);
  await expect(proof.locator('.removed-action')).toHaveText('REMOVED IN MINIMIZATION');
  await proof.getByRole('tab', { name: /Browser execution/ }).click();
  await expect(proof.locator('.decision-actions li').first()).toContainText('Worker +2.720s');
  await proof.getByRole('tab', { name: /Minimized replay/ }).click();
  await expect(proof.locator('.decision-actions li')).toHaveCount(3);
  await expect(proof.locator('.decision-actions')).not.toContainText('Observe sync state');
  await proof.getByText('Inspect recording samples and model configuration', { exact: true }).click();
  await expect(proof.locator('.input-frame-records li')).toHaveCount(4);
  await expect(proof.locator('.input-frame-records')).toContainText('0.720s');
  await expect(proof.locator('.model-configuration')).toContainText('1,918 input + 921 output tokens');
  await expect(proof.locator('.model-input-content')).toContainText('sampling can miss fast interactions');
  const runImages: { variant: string; ordinal: number; sha256: string }[] = [];
  for (let ordinal = 1; ordinal <= 3; ordinal++) {
    for (const variant of ['buggy', 'fixed']) {
      await proof.getByRole('button', { name: `Inspect ${variant} run ${ordinal}`, exact: true }).click();
      await expect(proof.locator('.validation-observation')).toContainText(variant === 'buggy' ? 'ASSERTION FAILED' : 'ASSERTION PASSED');
      await expect(proof.locator('.validation-observation dd').nth(0)).toHaveText('"Book the demo slot"');
      await expect(proof.locator('.validation-observation dd').nth(1)).toHaveText(variant === 'buggy' ? '"Ship the rough cut"' : '"Ship the rough cutBook the demo slot"');
      const frame = proof.getByRole('img', { name: `${variant} validation run ${ordinal}, captured final browser state`, exact: true });
      await frame.scrollIntoViewIfNeeded();
      await expect.poll(() => frame.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
      const source = await frame.getAttribute('src');
      const response = await page.request.get(source!); expect(response.ok()).toBe(true);
      const hash = createHash('sha256').update(await response.body()).digest('hex');
      const original = fs.readFileSync(`evidence/jobs/${source!.slice('/api/job-artifacts/'.length)}`);
      expect(hash).toBe(createHash('sha256').update(original).digest('hex'));
      runImages.push({ variant, ordinal, sha256: hash });
    }
  }
  await proof.getByRole('button', { name: 'Inspect fixed run 3', exact: true }).click();
  await expect(proof.locator('.validation-observation')).toContainText('ASSERTION PASSED');
  await expect(proof.locator('.validation-observation')).toContainText('Book the demo slot');
  const image = proof.getByRole('img', { name: 'fixed validation run 3, captured final browser state', exact: true });
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  const downloaded: string[] = [];
  for (const [name, relative] of [['Download model provenance', 'provenance.json'], ['This run’s result', '15-validation-fixed/result.json'], ['This run’s trace', '15-validation-fixed/trace.zip']]) {
    const href = await proof.getByRole('link', { name, exact: true }).getAttribute('href');
    const response = await page.request.get(href!); expect(response.ok()).toBe(true);
    const bytes = await response.body(), local = fs.readFileSync(`evidence/jobs/${liveId}/${relative}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(local).digest('hex'));
    downloaded.push(relative);
  }
  await proof.getByText('Inspect recording samples and model configuration', { exact: true }).click();
  await proof.getByRole('tab', { name: /Model proposal/ }).click();
  await proof.screenshot({ path: `${out}/live-decision-desktop.png`, animations: 'disabled' });
  fs.writeFileSync(`${out}/live-proof-downloads.json`, JSON.stringify({ jobId: liveId, actualCapturedJob: true, newModelCalls: 0, downloadsMatchOriginalFiles: downloaded, allSixDisplayedImagesMatchOriginals: runImages }, null, 2));
});

test('mobile keyboard selection and reduced motion inspect actual buggy/fixed screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const proof = await openProof(page);
  const proposal = proof.getByRole('tab', { name: /Model proposal/ });
  await proposal.focus(); await page.keyboard.press('ArrowRight');
  await expect(proof.getByRole('tab', { name: /Browser execution/ })).toBeFocused();
  await page.keyboard.press('End');
  await expect(proof.getByRole('tab', { name: /Minimized replay/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home'); await expect(proposal).toBeFocused();
  const fixed = proof.getByRole('button', { name: 'Inspect fixed run 2', exact: true });
  await fixed.focus(); await page.keyboard.press('Enter');
  await expect(fixed).toHaveAttribute('aria-pressed', 'true');
  await expect(proof.locator('.validation-observation')).toContainText('ASSERTION PASSED');
  await proof.getByText('Inspect recording samples and model configuration', { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await proof.getByText('Inspect recording samples and model configuration', { exact: true }).click();
  const screenshot = proof.locator('.validation-frame img');
  await screenshot.scrollIntoViewIfNeeded();
  await expect.poll(() => screenshot.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('.skip-link')).not.toBeFocused();
  expect(await page.locator('.skip-link').evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
  await proof.screenshot({ path: `${out}/live-decision-mobile.png`, animations: 'disabled' });
  await proof.getByRole('heading', { name: 'Model proposed. Browser judged.', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/live-decision-mobile-viewport.png`, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('genuine recorded job stays authored and exposes its actual observed run values', async ({ page }) => {
  const proof = await openProof(page, recordedId);
  await expect(proof.getByRole('heading', { name: 'Authored plan. Browser judged.' })).toBeVisible();
  await expect(proof.locator('.decision-mode')).toHaveText('0 MODEL CALLS');
  await expect(proof.getByRole('tab', { name: /Model proposal/ })).toHaveCount(0);
  await expect(proof.getByRole('link', { name: 'Download model provenance' })).toHaveCount(0);
  await expect(proof.locator('.validation-observation')).toContainText('Ship the rough cut');
  await proof.getByRole('button', { name: 'Inspect fixed run 1', exact: true }).click();
  await expect(proof.locator('.validation-observation')).toContainText('Book the demo slot');
});

test('contradictory evidence cannot show verified counts or a model plan, and reload recovers', async ({ page }) => {
  const summary = JSON.parse(fs.readFileSync(`evidence/jobs/${liveId}/summary.json`, 'utf8'));
  summary.runs.find((row: { phase: string; variant: string }) => row.phase === 'validation' && row.variant === 'fixed').result.assertion.actual = 'The note is missing';
  const pattern = `**/api/job-artifacts/${liveId}/summary.json`;
  await page.route(pattern, route => route.fulfill({ json: summary }));
  await openProof(page);
  await expect(page.getByRole('alert')).toContainText('observed value');
  await expect(page.locator('.verification-grid')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Investigation decision record' })).toHaveCount(0);
  await page.unroute(pattern);
  await page.getByRole('button', { name: 'Reload captured evidence', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Investigation decision record' })).toBeVisible();
});

test('missing and mismatched Meta captures show a usable unavailable state without a false claim', async ({ page }) => {
  const actual = await (await page.request.get(`/api/jobs/${liveId}`)).json();
  let mode: 'missing' | 'other-model' | 'actual' = 'missing';
  await page.route(`**/api/jobs/${liveId}`, route => {
    if (mode === 'missing') return route.fulfill({ status: 404, json: { detail: 'No captured example in this installation.' } });
    const job = structuredClone(actual);
    if (mode === 'other-model') {
      job.result.model = 'other-model.us-west.modal.direct';
      job.result.provenance[0].model = job.result.model;
    }
    return route.fulfill({ json: job });
  });
  await page.goto('/#proof');
  await expect(page.getByText('Captured Meta example unavailable here.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Inspect the Meta case' })).toHaveCount(0);
  mode = 'other-model';
  await page.locator('.capture-unavailable').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.capture-unavailable')).toContainText('does not match the reviewed Muse example');
  mode = 'actual';
  await page.locator('.capture-unavailable').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Captured Meta investigation' })).toBeVisible();
});

test('a stalled evidence response times out without showing a success, then manual retry works', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pattern = `**/api/job-artifacts/${liveId}/summary.json`;
  await page.route(pattern, async route => { await gate; await route.abort().catch(() => {}); });
  await page.goto(`/#job/${liveId}`);
  await page.clock.install();
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await page.getByRole('tab', { name: 'The evidence', exact: true }).click();
  await page.clock.fastForward(12001);
  await expect(page.getByRole('alert')).toContainText('Captured evidence request timed out');
  await expect(page.locator('.verification-grid')).toHaveCount(0);
  release(); await page.unroute(pattern);
  await page.getByRole('button', { name: 'Reload captured evidence', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Investigation decision record' })).toBeVisible();
});
