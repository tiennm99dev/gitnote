import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.js',
	timeout: 30_000,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		...devices['Desktop Chrome'],
		baseURL: `http://localhost:${PORT}`,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		launchOptions: {
			// CHROMIUM_PATH runs a system Chromium instead of Playwright's download,
			// for hosts where `npx playwright install chromium` has no build.
			executablePath: process.env.CHROMIUM_PATH || undefined
		}
	},
	webServer: {
		command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}`,
		// Always build and serve fresh: a reused preview would test a stale build.
		// A busy port fails the run; stop the stale server instead.
		reuseExistingServer: false,
		timeout: 120_000
	}
});
