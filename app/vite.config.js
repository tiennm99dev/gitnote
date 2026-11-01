import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// `wrangler dev` in relay/ listens here; `npm run dev` forwards /api to it.
const RELAY_DEV_URL = 'http://localhost:8787';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// One SPA build serves both the web and the Capacitor shell: every
			// unknown path falls back to index.html and the client router takes over.
			adapter: adapter({ fallback: 'index.html' })
		})
	],
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			'/api': { target: RELAY_DEV_URL, changeOrigin: false }
		}
	},
	preview: {
		port: 4173,
		strictPort: true
	},
	test: {
		expect: { requireAssertions: true },
		environment: 'node',
		include: ['src/**/*.{test,spec}.js']
	}
});
