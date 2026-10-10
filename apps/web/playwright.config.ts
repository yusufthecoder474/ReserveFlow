import { defineConfig, devices } from '@playwright/test';

const root = '../..';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome']
  },
  webServer: [
    {
      command: `cd ${root} && npm run dev:api`,
      url: 'http://127.0.0.1:4000/api/health/live',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000
    },
    {
      command: 'npm run dev -- --host 127.0.0.1',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000
    }
  ]
});
