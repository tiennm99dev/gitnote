/**
 * Refuses to deploy a directory that does not hold the web build. `npm run
 * android:sync` writes to the directory the Worker deploys, and that build's Content
 * Security Policy allows inline scripts, so `relay/wrangler.jsonc` runs this as its
 * build command: a bare `wrangler deploy` goes through it too.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Wrangler commands that publish nothing, so they may run on any build. */
const LOCAL_COMMANDS = new Set(['dev', 'types']);

/**
 * @param {string} html the built `index.html`
 * @returns {string | null} why it must not go to the web; null when it may
 */
export function deployProblem(html) {
	const policy = /<meta http-equiv="content-security-policy" content="([^"]+)"/.exec(html)?.[1];
	const scriptSrc = policy?.split(';').find((part) => part.trim().startsWith('script-src'));
	if (!scriptSrc) return 'it has no script-src policy.';
	return scriptSrc.includes("'unsafe-inline'") ? 'it is an Android build, whose policy allows inline scripts.' : null;
}

/**
 * @param {URL | string} buildDir
 * @returns {Promise<string | null>} why this directory must not be deployed; null when it may
 */
export async function checkDeployableBuild(buildDir) {
	try {
		return deployProblem(await readFile(new URL('index.html', buildDir), 'utf8'));
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return 'it holds no build.';
		throw error;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !LOCAL_COMMANDS.has(process.env.WRANGLER_COMMAND ?? '')) {
	const problem = await checkDeployableBuild(new URL('../build/', import.meta.url));
	if (problem) {
		console.error(`app/build cannot be deployed: ${problem} Use \`npm run deploy\`, which builds it first.`);
		process.exit(1);
	}
}
