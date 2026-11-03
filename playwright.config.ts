import { defineConfig } from '@playwright/test';
const evidenceRoot = process.env.BUGARCADE_UI_EVIDENCE_DIR || 'evidence/ui';
const baseURL = process.env.BUGARCADE_BASE_URL || 'http://127.0.0.1:5173';
export default defineConfig({
  testDir: './tests/e2e', timeout: 45000, expect: { timeout: 10000 },
  fullyParallel: false, workers: 1, retries: 0,
  reporter: [['list'], ['json', { outputFile: `${evidenceRoot}/playwright-results.json` }]],
  use: { baseURL, channel: 'chromium', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.BUGARCADE_EXISTING_SERVERS ? undefined : { command: 'npm start', url: baseURL, reuseExistingServer: true, timeout: 30000 },
});
