import { defineConfig, devices } from '@playwright/test';

/**
 * Read environment variables from file if present.
 * See https://playwright.dev/docs/test-configuration.
 */
const PORT = process.env.CI ? 1420 : (process.env.VITE_DEV_SERVER_PORT ? parseInt(process.env.VITE_DEV_SERVER_PORT) : 1420);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 1,
  reporter: process.env.CI ? [['html'], ['github']] : [['html']],
  timeout: 30000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: process.env.CI
    ? {
        command: 'npx vite --port 1420 --strictPort',
        url: `http://localhost:${PORT}`,
        reuseExistingServer: false,
        timeout: 30000,
        cwd: process.cwd(),
      }
    : {
        command: `npm run dev --port ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 60000,
        cwd: process.cwd(),
      },
});
