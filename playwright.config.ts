import { defineConfig, devices } from '@playwright/test';

const port = process.env.E2E_PORT ?? '3000';
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: process.env.E2E_SERVER_COMMAND ?? `pnpm dev --port ${port}`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          E2E_TEST_MODE: '1',
          E2E_TEST_SECRET: process.env.E2E_TEST_SECRET ?? 'local-e2e-fixture',
          ROOM_STORE_FILE: '.data/e2e-rooms.json',
          UPSTASH_REDIS_REST_URL: '',
          UPSTASH_REDIS_REST_TOKEN: '',
          KV_REST_API_URL: '',
          KV_REST_API_TOKEN: '',
          QSTASH_TOKEN: '',
          VERCEL: '',
        },
      },
});
