import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { relay } from './helpers.js';

describe('GET /api/health', () => {
	it('answers 200 with an ok status as JSON', async () => {
		const response = await exports.default.fetch('http://gitnote.test/api/health');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toMatch(/^application\/json/);
		expect(await response.json()).toEqual({ status: 'ok' });
	});

	it('does not answer other methods', async () => {
		const response = await exports.default.fetch('http://gitnote.test/api/health', {
			method: 'POST'
		});
		expect(response.status).toBe(404);
	});
});

describe('/api/* response headers', () => {
	it.each([
		['the health probe', '/api/health', {}, 200],
		['an unknown endpoint', '/api/nope', {}, 404],
		['a refused origin', '/api/health', { headers: { Origin: 'https://evil.test' } }, 403],
		['a refused git target', '/api/git/example.com/o/r.git/info/refs?service=git-upload-pack', {}, 403]
	])('marks %s nosniff and sandboxed', async (_name, path, init, status) => {
		const response = await relay(path, init);
		expect(response.status).toBe(status);
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
		await response.arrayBuffer();
	});
});
