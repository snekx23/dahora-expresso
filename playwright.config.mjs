import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser_e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'on-first-retry',
    geolocation: { latitude: -30.0346, longitude: -51.2177 }, // Porto Alegre
    permissions: ['geolocation']
  },
  projects: [
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'Notebook 1366',
      use: { viewport: { width: 1366, height: 768 } }
    },
    {
      name: 'Mobile Chrome (390x844)',
      use: { viewport: { width: 390, height: 844 }, isMobile: true }
    }
  ],
  webServer: {
    command: 'node serve.js',
    url: 'http://localhost:8000',
    reuseExistingServer: true,
    timeout: 10000
  }
});
