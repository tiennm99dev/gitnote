import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startGitHttpServer } from './git-http-server.js';
import { startRelay } from './relay-server.js';
import { GIT_ROOT_ENV, GIT_SERVER_PORT, RELAY_PORT } from './remote-repo.js';

/**
 * Vitest global setup: a local git server and the real relay in front of it.
 * Workers inherit the environment, which is how tests learn the repo root.
 * @returns {Promise<() => Promise<void>>} the teardown
 */
export default async function setup() {
	const root = await mkdtemp(path.join(tmpdir(), 'gitnote-git-'));
	process.env[GIT_ROOT_ENV] = root;
	const stopGit = await startGitHttpServer({ port: GIT_SERVER_PORT, root });
	const stopRelay = await startRelay({
		port: RELAY_PORT,
		gitHost: `localhost:${GIT_SERVER_PORT}`,
		assets: path.resolve(import.meta.dirname, '../static')
	});
	return async () => {
		await stopRelay();
		await stopGit();
		await rm(root, { recursive: true, force: true });
	};
}
