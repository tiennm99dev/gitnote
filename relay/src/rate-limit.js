import { jsonError } from './json-error.js';

/** Seconds a limited client should wait; matches the binding's 60 s period. */
const RETRY_AFTER_SECONDS = 60;

/**
 * Rate-limits requests per client IP with a Workers `ratelimits` binding.
 * The binding counts per Cloudflare location and is approximate; it keeps
 * counters only, never request data.
 *
 * If the binding itself fails, the request goes through: the limit is a soft
 * abuse bound, and the host allowlist still applies.
 * @param {'API_LIMITER' | 'OAUTH_LIMITER'} bindingName
 * @returns {import('hono').MiddlewareHandler<import('./app-env.js').AppEnv>}
 */
export function rateLimit(bindingName) {
	return async (c, next) => {
		const key = c.req.header('CF-Connecting-IP') ?? 'unknown';
		/** @type {boolean} */
		let allowed;
		try {
			({ success: allowed } = await c.env[bindingName].limit({ key }));
		} catch {
			allowed = true;
		}
		if (!allowed) {
			return jsonError(
				429,
				'rate_limited',
				'Too many requests to the gitnote relay. Try again in a minute.',
				{},
				{ 'Retry-After': String(RETRY_AFTER_SECONDS) }
			);
		}
		return next();
	};
}
