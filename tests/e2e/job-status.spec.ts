import { test, expect } from '@playwright/test';

const id = 'ab'.repeat(16);
// Synthetic HTTP state contracts. These tests make no model or sandbox request.
const job = (state: string) => ({ id, mode: 'live', state, events: [{ state, at: 1, message: 'Synthetic job state for UI testing.' }], error: null, result: null });

test('direct job link polls progress and preserves a failed run without fetching a cartridge', async ({ page }) => {
  let reads = 0, packages = 0;
  await page.route(`**/api/jobs/${id}`, route => route.fulfill({ json: ++reads < 3 ? job('investigating') : { ...job('failed'), error: 'Required video capture failed.', result: { provenance: [{ origin: 'synthetic-contract-test' }] } } }));
  await page.route(`**/api/job-artifacts/${id}/challenge.json`, route => { packages++; return route.fulfill({ status: 404, json: { detail: 'No verified cartridge.' } }); });
  await page.goto(`/#job/${id}`);
  await expect(page.getByRole('heading', { name: 'Your bug is under investigation.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Investigation stopped.' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Required video capture failed.');
  await expect(page.getByRole('link', { name: 'Download model provenance' })).toHaveAttribute('href', `/api/job-artifacts/${id}/provenance.json`);
  expect(packages).toBe(0);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('direct running job can be cancelled without creating a challenge', async ({ page }) => {
  let cancelled = false;
  await page.route(`**/api/jobs/${id}`, route => route.fulfill({ json: job(cancelled ? 'cancelled' : 'reproducing') }));
  await page.route(`**/api/jobs/${id}/cancel`, route => { cancelled = true; return route.fulfill({ json: job('cancelled') }); });
  await page.goto(`/#job/${id}`);
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await expect(page.getByRole('heading', { name: 'Investigation cancelled.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('not reproduced has an explicit outcome and no playable result', async ({ page }) => {
  await page.route(`**/api/jobs/${id}`, route => route.fulfill({ json: job('not-reproduced') }));
  await page.goto(`/#job/${id}`);
  await expect(page.getByRole('heading', { name: 'Not reproduced.' })).toBeVisible();
  await expect(page.getByText('No valid reproduction was found within this run’s bounds. No verified challenge was created.')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
});
