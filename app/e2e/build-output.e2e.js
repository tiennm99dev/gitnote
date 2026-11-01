import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { E2E_BUILD_DIR } from './static-server.js';

/** Sign-in client IDs that only the browser tests' build may hold. */
const FIXTURE_IDS = ['e2e-github-client', 'e2e-gitlab-client', 'gitnote-e2e'];

/**
 * @param {string} name a build directory under `app/`
 * @returns {Promise<string>} the text of everything in it; empty when it was never built
 */
async function readBuild(name) {
	const root = fileURLToPath(new URL(`../${name}/`, import.meta.url));
	/** @type {import('node:fs').Dirent[]} */
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true, recursive: true });
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return '';
		throw error;
	}
	const files = entries.filter((entry) => entry.isFile() && /\.(html|js)$/.test(entry.name));
	const texts = await Promise.all(files.map((entry) => readFile(`${entry.parentPath}/${entry.name}`, 'utf8')));
	return texts.join('\n');
}

test('fixture sign-in IDs stay out of the directory the Worker deploys', async () => {
	const tested = await readBuild(E2E_BUILD_DIR);
	const deployed = await readBuild('build');

	// The test build does hold them, so a clean `build` proves something.
	expect(tested).toContain(FIXTURE_IDS[0]);
	for (const id of FIXTURE_IDS) expect(deployed).not.toContain(id);
});
