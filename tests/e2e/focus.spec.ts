import { test, expect } from '@playwright/test';

test('deferred section navigation does not steal a subsequent keyboard selection', async ({ page }) => {
  const time = new Date('2026-10-30T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.goto('/');
  await page.getByRole('link', { name: 'How it works', exact: true }).click();
  await expect(page.locator('#about')).toBeFocused();
  await page.getByRole('tab', { name: /Play the app/ }).press('End');
  const verify = page.getByRole('tab', { name: /Test the fix/ });
  await expect(verify).toHaveAttribute('aria-selected', 'true');
  await page.clock.runFor(34);
  await expect(verify).toBeFocused();
});
