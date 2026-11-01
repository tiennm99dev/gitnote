import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd against the same wrangler.jsonc that deploys.
export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
	test: {
		expect: { requireAssertions: true },
		include: ['test/**/*.test.js']
	}
});
