import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

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
