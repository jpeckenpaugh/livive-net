import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const qaDir = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(qaDir, '..');
const PORT = Number(process.env.HUB_PORT || 4173);
const hubURL = `http://127.0.0.1:${PORT}/`;

// Three viewports per the smoke-test spec: desktop 1280x800, iPhone 390x844,
// Android 412x915. Chromium only (the harness is a functional smoke test, not a
// rendering engine matrix).
export default defineConfig({
  testDir: path.join(qaDir, 'tests'),
  outputDir: path.join(qaDir, 'test-results'),
  // Keep the per-test screenshot + findings.json for every test so the CI
  // artifact is a complete visual record, not just the failures.
  preserveOutput: 'always',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(qaDir, 'playwright-report'), open: 'never' }],
    ['json', { outputFile: path.join(qaDir, 'test-results', 'results.json') }],
  ],
  use: {
    baseURL: hubURL,
    locale: 'en-US',
    timezoneId: 'UTC',
    // Demos are third-party; tolerate their TLS quirks rather than fail on them.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Escape hatch for constrained sandboxes (e.g. PW_LAUNCH_ARGS="--no-sandbox").
    launchOptions: process.env.PW_LAUNCH_ARGS
      ? { args: process.env.PW_LAUNCH_ARGS.split(/\s+/).filter(Boolean) }
      : undefined,
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'android',
      use: {
        ...devices['Pixel 7'],
        browserName: 'chromium',
        viewport: { width: 412, height: 915 },
      },
    },
  ],
  // Serve the repository as the hub under test, so CI checks the committed site
  // (not the deployed one) before/after deploy.
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    cwd: siteRoot,
    url: `${hubURL}index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
