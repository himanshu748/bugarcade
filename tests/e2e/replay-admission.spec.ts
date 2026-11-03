import { test, expect } from '@playwright/test';

test('replay waits for request admission before typing the next query', async ({ page }) => {
  test.skip(process.env.BUGARCADE_HOSTED_DEMO === '1', 'Exercises the local HTTP simulator.');
  const forwarded: string[] = [];
  let delayed = false;
  await page.route('**/mock/*/request', async route => {
    const body = route.request().postDataJSON();
    if (body.key === 'search') {
      if (!delayed) {
        delayed = true;
        // Deliberate transport fault: the first POST reaches the API late.
        // This delay injects network latency; production replay uses state acknowledgement.
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      forwarded.push(body.payload.query);
    }
    await route.continue();
  });
  await page.goto('/#play/search');
  await page.getByRole('button', { name: 'Reveal the replay', exact: true }).click();
  await page.getByRole('button', { name: 'Fixed', exact: true }).click();
  await page.getByRole('button', { name: 'Run same actions', exact: true }).click();
  await expect(page.getByText('The app kept its promise.', { exact: true })).toBeVisible();
  await expect(page.frameLocator('.app-window iframe').getByTestId('results')).toContainText('React handbook');
  expect(forwarded).toEqual(['re', 'react']);
});
