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
			adapter: adapter({ fallback: 'index.html' }),
			// Content Security Policy for the SPA shell. SvelteKit writes it into the
			// built index.html as a `<meta http-equiv>` tag, so it also applies inside
			// the Capacitor WebView, where no server sends headers. SvelteKit boots
			// from an inline script, so `script-src 'self'` alone would block the app;
			// hash mode adds that script's hash. CodeMirror injects `<style>` elements
			// at runtime, hence `'unsafe-inline'` for styles only (SvelteKit then adds
			// no style hashes, which would make browsers ignore `'unsafe-inline'`).
			// `connect-src` covers the CORS-enabled GitHub REST and GitLab token APIs.
			// `frame-ancestors` cannot be set from a meta tag; `static/_headers` sends it.
			csp: {
				mode: 'hash',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'blob:', 'data:'],
					'connect-src': [
						'self',
						'https://api.github.com',
						'https://gitlab.com',
						'https://gitnote.miti99.dev'
					],
					'object-src': ['none'],
					'base-uri': ['self']
				}
			}
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
		include: ['src/**/*.{test,spec}.js', 'e2e/**/*.test.js'],
		// A local git server and the real relay in front of it.
		globalSetup: ['test/git-fixture-setup.js'],
		testTimeout: 30_000,
		hookTimeout: 30_000
	}
});
