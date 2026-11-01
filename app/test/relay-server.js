import path from 'node:path';
import { unstable_startWorker } from 'wrangler';

const RELAY_CONFIG = path.resolve(import.meta.dirname, '../../relay/wrangler.jsonc');

/**
 * Runs the real relay Worker in workerd, from the same wrangler.jsonc that
 * deploys, allowing one extra loopback git host. `assets` replaces the SPA
 * build directory, which does not exist yet when unit tests run.
 * @param {{ port: number, gitHost: string, assets: string }} options
 * @returns {Promise<() => Promise<void>>} stops the Worker
 */
export async function startRelay({ port, gitHost, assets }) {
	const worker = await unstable_startWorker({
		config: RELAY_CONFIG,
		assets,
		bindings: { GIT_HOSTS: { type: 'plain_text', value: gitHost } },
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
