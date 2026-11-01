import { exports } from 'cloudflare:workers';
import { vi } from 'vitest';

/** The relay's own origin in tests. */
export const SELF_ORIGIN = 'https://gitnote.test';

let nextClient = 1;

/**
 * Sends a request to the Worker. Each call gets its own client IP unless the
 * caller sets `CF-Connecting-IP`, so rate limits only bite where a test means
 * them to.
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function relay(path, init = {}) {
	const headers = new Headers(init.headers);
	if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', `192.0.2.${nextClient++ % 250}`);
	return exports.default.fetch(`${SELF_ORIGIN}${path}`, { ...init, headers });
}

/**
 * @typedef {object} UpstreamCall
 * @property {string} url
 * @property {RequestInit} init
 * @property {Headers} headers
 */

/**
 * Replaces the global `fetch` the Worker uses to reach git hosts and GitHub,
 * recording each call. Restored after every test by `restoreMocks`.
 * @param {(call: UpstreamCall) => Response | Promise<Response>} respond
 * @returns {UpstreamCall[]}
 */
export function stubUpstream(respond) {
	/** @type {UpstreamCall[]} */
	const calls = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
		const call = { url: String(input), init, headers: new Headers(init.headers) };
		calls.push(call);
		return respond(call);
	});
	return calls;
}

/**
 * Spies on every console method, so a test can prove the Worker logged
 * nothing.
 * @returns {() => unknown[][]} all arguments passed to any console method
 */
export function spyConsole() {
	const methods = /** @type {const} */ (['log', 'info', 'warn', 'error', 'debug', 'trace']);
	const spies = methods.map((method) => vi.spyOn(console, method));
	return () => spies.flatMap((spy) => spy.mock.calls);
}
