import path from 'node:path';
import { unstable_startWorker } from 'wrangler';

const RELAY_CONFIG = path.resolve(import.meta.dirname, '../../relay/wrangler.jsonc');

/**
 * Runs the real relay Worker in workerd, from the same wrangler.jsonc that
 * deploys, allowing one extra loopback git host and lifting the request limit. `assets` replaces the SPA
 * build directory, which does not exist yet when unit tests run.
 * @param {{ port: number, gitHost: string, assets: string }} options
 * @returns {Promise<() => Promise<void>>} stops the Worker
 */
export async function startRelay({ port, gitHost, assets }) {
	const worker = await unstable_startWorker({
		config: RELAY_CONFIG,
		assets,
		bindings: {
			GIT_HOSTS: { type: 'plain_text', value: gitHost },
			// A whole test suite is one client and outruns the per-client limit,
			// which the relay's own tests cover.
			API_LIMITER: { type: 'ratelimit', namespace_id: '4801', simple: { limit: 1_000_000, period: 60 } }
		},
		dev: {
			server: { hostname: '127.0.0.1', port },
			inspector: false,
			watch: false,
			logLevel: 'error'
		}
	});
	await worker.ready;
	return () => worker.dispose();
}
