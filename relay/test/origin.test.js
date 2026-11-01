import { describe, expect, it } from 'vitest';
import { relay, SELF_ORIGIN } from './helpers.js';

describe('origin check on /api/*', () => {
	it.each(['https://evil.test', 'null', 'http://gitnote.test', 'https://localhost:8443'])(
		'answers 403 to Origin %s',
		async (origin) => {
			const response = await relay('/api/health', { headers: { Origin: origin } });
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ error: 'origin_not_allowed' });
			expect(response.headers.get('access-control-allow-origin')).toBeNull();
		}
	);

	it('answers 403 to a cross-site browser request that sent no Origin', async () => {
		const response = await relay('/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
		expect(response.status).toBe(403);
	});

	it('serves its own origin without CORS headers', async () => {
		const response = await relay('/api/health', { headers: { Origin: SELF_ORIGIN } });
		expect(response.status).toBe(200);
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('serves same-origin and non-browser requests that send no Origin', async () => {
		const sameOrigin = await relay('/api/health', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
		const plain = await relay('/api/health');
		expect([sameOrigin.status, plain.status]).toEqual([200, 200]);
	});

	it('serves the Capacitor origin with CORS headers', async () => {
		const response = await relay('/api/health', { headers: { Origin: 'https://localhost' } });
		expect(response.status).toBe(200);
		expect(response.headers.get('access-control-allow-origin')).toBe('https://localhost');
		expect(response.headers.get('vary')).toContain('Origin');
	});

	it('answers a CORS preflight from an allowed app shell', async () => {
		const response = await relay('/api/git/github.com/octo/notes.git/git-upload-pack', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://localhost',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'authorization, content-type'
			}
		});
		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe('https://localhost');
		expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST');
		expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
		expect(response.headers.get('access-control-allow-credentials')).toBeNull();
	});

	it('refuses a CORS preflight from any other origin', async () => {
		const response = await relay('/api/oauth/github/token', {
			method: 'OPTIONS',
			headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST' }
		});
		expect(response.status).toBe(403);
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('answers unknown /api paths with a JSON 404', async () => {
		const response = await relay('/api/nope');
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: 'not_found' });
	});
});
