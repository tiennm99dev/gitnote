import { jsonError } from './json-error.js';

/** Request headers a cross-origin app shell may send to the relay. */
const CORS_ALLOWED_HEADERS = 'Authorization, Content-Type, Accept, Git-Protocol';

/**
 * Parses the comma-separated `CORS_ORIGINS` var into a set of origins.
 * @param {string | undefined} value
 * @returns {Set<string>}
 */
export function parseOrigins(value) {
	return new Set(
		(value ?? '')
			.split(',')
			.map((origin) => origin.trim())
			.filter(Boolean)
	);
}

/**
 * Lets `/api/*` requests through only from the Worker's own origin or an
 * app shell listed in `CORS_ORIGINS` (the Capacitor WebView), and answers
 * CORS for those shells.
 *
 * A request with no `Origin` header passes unless `Sec-Fetch-Site` shows a
 * browser sent it from another site: browsers omit `Origin` on same-origin
 * GETs, and non-browser clients cannot be stopped by an origin check at all
 * (the host allowlist and the rate limit bound them).
 * @type {import('hono').MiddlewareHandler<import('./app-env.js').AppEnv>}
 */
export async function originGuard(c, next) {
	const origin = c.req.header('Origin');
	if (origin === undefined) {
		const site = c.req.header('Sec-Fetch-Site');
		if (site !== undefined && site !== 'same-origin' && site !== 'none') {
			return forbidden();
		}
		return next();
	}

	if (origin === new URL(c.req.url).origin) return next();
	if (!parseOrigins(c.env.CORS_ORIGINS).has(origin)) return forbidden();

	if (c.req.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Origin': origin,
				'Access-Control-Allow-Methods': 'GET, POST',
				'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
				'Access-Control-Max-Age': '600',
				Vary: 'Origin'
			}
		});
	}

	await next();
	// Re-wrap so the headers are mutable whatever produced the response.
	c.res = new Response(c.res.body, c.res);
	c.res.headers.set('Access-Control-Allow-Origin', origin);
	c.res.headers.append('Vary', 'Origin');
}

/**
 * @returns {Response}
 */
function forbidden() {
	return jsonError(403, 'origin_not_allowed', 'This origin may not call the gitnote relay.');
}
