import { describe, expect, it } from 'vitest';
import { relay, stubUpstream } from './helpers.js';

/**
 * Sends requests until the first 429 and returns how many passed before it.
 * The binding counts in fixed windows, so a run that straddles a window
 * boundary passes between `limit` and `2 * limit` requests; never more.
 * @param {() => Promise<Response>} send
 * @param {number} limit
 * @returns {Promise<number>}
 */
async function passedBeforeLimit(send, limit) {
	for (let passed = 0; passed <= 2 * limit; passed++) {
		const response = await send();
		if (response.status === 429) return passed;
		expect(response.status).toBe(200);
	}
	return Infinity;
}

describe('rate limits', () => {
	it('limits OAuth calls per client IP to 10 a minute', async () => {
		stubUpstream(() => Response.json({ access_token: 'ghu_x' }));
		const call = (/** @type {string} */ ip) =>
			relay('/api/oauth/github/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
				body: JSON.stringify({ code: 'abc' })
			});

		const passed = await passedBeforeLimit(() => call('203.0.113.10'), 10);
		expect(passed).toBeGreaterThanOrEqual(10);
		expect(passed).toBeLessThanOrEqual(20);

		const limited = await call('203.0.113.10');
		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).toBe('60');
		expect(await limited.json()).toMatchObject({ error: 'rate_limited' });

		// Other clients, and the rest of the API for this client, are unaffected.
		expect((await call('203.0.113.11')).status).toBe(200);
		const health = await relay('/api/health', { headers: { 'CF-Connecting-IP': '203.0.113.10' } });
		expect(health.status).toBe(200);
	});

	it('limits all API calls per client IP to 300 a minute', async () => {
		const passed = await passedBeforeLimit(
			() => relay('/api/health', { headers: { 'CF-Connecting-IP': '203.0.113.20' } }),
			300
		);
		expect(passed).toBeGreaterThanOrEqual(300);
		expect(passed).toBeLessThanOrEqual(600);
		// Up to 600 sequential requests: the default 5 s runs out on a loaded host.
	}, 30_000);
});
