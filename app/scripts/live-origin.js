/**
 * The address of the deployment this checkout publishes. `APP_ORIGIN` in
 * `relay/wrangler.jsonc` owns it, so a fork changes one line: the app's CSP, the Android
 * build's relay and the live tests all follow, and a fork's token can never reach
 * another deployment's relay.
 */

import { readFileSync } from 'node:fs';

/**
 * @param {string} config the text of `wrangler.jsonc`
 * @returns {string} the origin it names
 */
export function originFromWranglerConfig(config) {
	const origin = /"APP_ORIGIN":\s*"(https:\/\/[^"/]+)"/.exec(config)?.[1];
	if (!origin) throw new Error('relay/wrangler.jsonc has no APP_ORIGIN to take the deployment address from.');
	return origin;
}

export const LIVE_ORIGIN = originFromWranglerConfig(readFileSync(new URL('../../relay/wrangler.jsonc', import.meta.url), 'utf8'));
