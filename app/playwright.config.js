import { defineConfig, devices } from '@playwright/test';
import { artifactPolicy } from './e2e/artifact-policy.js';
import { STATIC_SHELL_PORT } from './e2e/static-server.js';

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
		// A run with a token records no trace or screenshot; see artifact-policy.js.
		...artifactPolicy(process.env),
		launchOptions: {
			// CHROMIUM_PATH runs a system Chromium instead of Playwright's download,
			// for hosts where `npx playwright install chromium` has no build.
			executablePath: process.env.CHROMIUM_PATH || undefined
		}
	},
	webServer: [
		{
			command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
			url: `http://localhost:${PORT}`,
			// Always build and serve fresh: a reused preview would test a stale build.
			// A busy port fails the run; stop the stale server instead.
			reuseExistingServer: false,
			timeout: 120_000
		},
		{
			// The same build as the Capacitor WebView and Static Assets serve it:
			// files as built, no CSP header. It answers 404 until the build above
			// has written index.html, so the tests start only once both are up.
			command: 'node e2e/static-server.js',
			url: `http://127.0.0.1:${STATIC_SHELL_PORT}`,
			reuseExistingServer: false,
			timeout: 120_000
		}
	]
});
