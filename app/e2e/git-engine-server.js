import { rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { startGitHttpServer } from '../test/git-http-server.js';
import { startRelay } from '../test/relay-server.js';
import { E2E_GIT_PORT, E2E_GIT_ROOT, E2E_RELAY_PORT, E2E_WORK_DIR } from './git-engine-ports.js';

/**
 * Builds the engine test page, then serves it from the real relay in front of
 * a local git server, so the page reaches git through `/api/git` on its own
 * origin exactly as the app does.
 * @returns {Promise<() => Promise<void>>} stops everything
 */
async function start() {
	const pageDir = path.join(E2E_WORK_DIR, 'page');
	await rm(E2E_WORK_DIR, { recursive: true, force: true });
	await mkdir(E2E_GIT_ROOT, { recursive: true });
	await build({
		configFile: false,
		logLevel: 'warn',
		root: path.resolve(import.meta.dirname, 'git-engine'),
		build: { outDir: pageDir, emptyOutDir: true }
	});
	const stopGit = await startGitHttpServer({ port: E2E_GIT_PORT, root: E2E_GIT_ROOT });
	const stopRelay = await startRelay({ port: E2E_RELAY_PORT, gitHost: `localhost:${E2E_GIT_PORT}`, assets: pageDir });
	return async () => {
		await stopGit();
		await stopRelay();
	};
}

if (process.argv[1] === import.meta.filename) {
	// On `exit`, because wrangler's own signal handling can end the process
	// before an async cleanup finishes.
	process.once('exit', () => rmSync(E2E_WORK_DIR, { recursive: true, force: true }));
	const stop = await start();
	for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
		process.once(signal, () => {
			stop().finally(() => process.exit(0));
		});
	}
}
