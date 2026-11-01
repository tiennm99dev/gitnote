/**
 * Stand-ins for what surrounds the auth code in unit tests: the browser's
 * storage, the device's token store and the providers' HTTP answers. Real
 * browser storage and encryption are covered by the Playwright tests.
 */

/**
 * @returns {Storage}
 */
export function memoryStorage() {
	/** @type {Map<string, string>} */
	const items = new Map();
	return {
		get length() {
			return items.size;
		},
		key: (index) => [...items.keys()][index] ?? null,
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => void items.set(key, value),
		removeItem: (key) => void items.delete(key),
		clear: () => items.clear()
	};
}

/**
 * Copies records in and out, as a real store would.
 * @template T
 * @returns {import('../src/lib/auth/token-store.js').TokenStore<T> & { records: Map<string, string> }}
 */
export function memoryTokenStore() {
	/** @type {Map<string, string>} */
	const records = new Map();
	return {
		records,
		get: async (name) => {
			const record = records.get(name);
			return record === undefined ? null : JSON.parse(record);
		},
		set: async (name, value) => void records.set(name, JSON.stringify(value)),
		remove: async (name) => void records.delete(name)
	};
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
export function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A `fetch` answered by a handler, recording every call.
 * @param {(url: URL, init: RequestInit) => Response | Promise<Response>} handler
 * @returns {typeof fetch & { calls: { url: URL, init: RequestInit }[] }}
 */
export function fetchDouble(handler) {
	/** @type {{ url: URL, init: RequestInit }[]} */
	const calls = [];
	const double = async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit} */ init = {}) => {
		const url = new URL(String(input));
		calls.push({ url, init });
		return handler(url, init);
	};
	return Object.assign(double, { calls });
}
