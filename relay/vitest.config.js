import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd against the same wrangler.jsonc that deploys.
// The bindings below override it for tests only: a loopback git host for
// fixtures, and placeholder GitHub App credentials (not real secrets; the
// tests stub GitHub's token endpoint).
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				bindings: {
					GIT_HOSTS: 'github.com,gitlab.com,localhost:8174',
					CORS_ORIGINS: 'https://localhost',
					GITHUB_CLIENT_ID: 'test-client-id',
					GITHUB_CLIENT_SECRET: 'test-client-secret'
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		include: ['test/**/*.test.js'],
		restoreMocks: true
	}
});
