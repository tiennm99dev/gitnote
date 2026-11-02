import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { LIVE_ORIGIN } from './scripts/live-origin.js';

// `wrangler dev` in relay/ listens here; `npm run dev` forwards /api to it.
const RELAY_DEV_URL = 'http://localhost:8787';

const BUILD_DIR = process.env.GITNOTE_BUILD_DIR || 'build';

// The Android build: `npm run build:native`.
const NATIVE_BUILD = process.env.CAP_BUILD === '1';

export default defineConfig({
	define: {
		'import.meta.env.VITE_RELAY_ORIGIN': JSON.stringify(LIVE_ORIGIN)
	},
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
			// The Worker deploys `build`, so a test build with fixture IDs goes elsewhere.
			adapter: adapter({ fallback: 'index.html', pages: BUILD_DIR, assets: BUILD_DIR }),
			// Content Security Policy for the SPA shell. SvelteKit writes it into the
			// built index.html as a `<meta http-equiv>` tag, so it also applies inside
			// the Capacitor WebView, where no server sends headers. SvelteKit boots
			// from an inline script, so `script-src 'self'` alone would block the app;
			// hash mode adds that script's hash. CodeMirror injects `<style>` elements
			// at runtime, hence `'unsafe-inline'` for styles only (SvelteKit then adds
			// no style hashes, which would make browsers ignore `'unsafe-inline'`).
			// `connect-src` covers the CORS-enabled GitHub REST and GitLab token APIs.
			// `frame-ancestors` cannot be set from a meta tag; `static/_headers` sends it.
			// On older WebViews, Capacitor injects its bridge as a nonce-less inline
			// script, so the native build needs `'unsafe-inline'` for scripts. SvelteKit
			// then adds no script hash, which would make the WebView ignore it. DOMPurify
			// is the only XSS defence there, and this policy must never reach the web.
			csp: {
				mode: 'hash',
				directives: {
					'default-src': ['self'],
					'script-src': NATIVE_BUILD ? ['self', 'unsafe-inline'] : ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'blob:', 'data:'],
					'connect-src': [
						'self',
						'https://api.github.com',
						'https://gitlab.com',
						/** @type {`https://${string}.${string}`} */ (LIVE_ORIGIN)
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
		include: ['src/**/*.{test,spec}.js', 'e2e/**/*.test.js', 'scripts/**/*.test.js'],
		// A local git server and the real relay in front of it.
		globalSetup: ['test/git-fixture-setup.js'],
		testTimeout: 30_000,
		hookTimeout: 30_000
	}
});
