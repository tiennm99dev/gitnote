import { defineConfig, devices } from '@playwright/test';
import { artifactPolicy } from './e2e/artifact-policy.js';
import { LIVE_ORIGIN } from './scripts/live-origin.js';

/**
 * The deployed site, tested with no stand-ins and no local servers. `npm run e2e`
 * covers the same app against fixtures; this one answers what only the real edge and
 * the real providers can.
 */
export default defineConfig({
	testDir: 'e2e/live',
	testMatch: '**/*.live.js',
	timeout: 120_000,
	// The note test resets and pushes to one branch, and a retry would hide a flaky edge.
	workers: 1,
	retries: 0,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		...devices['Desktop Chrome'],
		baseURL: process.env.GITNOTE_LIVE_URL || LIVE_ORIGIN,
		...artifactPolicy(process.env),
		launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined }
	}
});
