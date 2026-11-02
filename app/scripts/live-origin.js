/**
 * The address of the deployment this checkout publishes. `routes` in
 * `relay/wrangler.jsonc` owns it, so a fork changes one line: the app's CSP, the Android
 * build's relay and the live tests all follow, and a fork's token can never reach
 * another deployment's relay.
 */

import { readFileSync } from 'node:fs';

/**
 * @param {string} config the text of `wrangler.jsonc`
 * @returns {string} the origin of its custom-domain route
 */
export function originFromWranglerConfig(config) {
	const host = /"pattern":\s*"([^"/*]+)"/.exec(config)?.[1];
	if (!host) throw new Error('relay/wrangler.jsonc has no custom-domain route to take the deployment address from.');
	return `https://${host}`;
}

export const LIVE_ORIGIN = originFromWranglerConfig(readFileSync(new URL('../../relay/wrangler.jsonc', import.meta.url), 'utf8'));
