import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unstable_readConfig } from 'wrangler';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDeployableBuild, deployProblem } from './check-deployable-build.js';

/**
 * @param {string} scriptSrc
 * @returns {string} an `index.html` as SvelteKit writes it
 */
const page = (scriptSrc) => `<head><meta http-equiv="content-security-policy" content="default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'"></head>`;

describe('deployProblem', () => {
	it('accepts the web policy, even though styles allow inline', () => {
		expect(deployProblem(page("'self' 'sha256-abc='"))).toBeNull();
	});

	it('refuses the Android policy', () => {
		expect(deployProblem(page("'self' 'unsafe-inline'"))).toContain('Android build');
	});

	it('refuses a page with no script policy', () => {
		expect(deployProblem('<head></head>')).toContain('no script-src');
	});
});

describe('checkDeployableBuild', () => {
	/** @type {string | undefined} */
	let dir;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it('reads the index page of the directory', async () => {
		dir = await mkdtemp(path.join(tmpdir(), 'gitnote-deploy-'));
		await writeFile(path.join(dir, 'index.html'), page("'self' 'unsafe-inline'"));
		expect(await checkDeployableBuild(pathToFileURL(`${dir}/`))).toContain('Android build');
	});

	it('refuses a directory with no build', async () => {
		dir = await mkdtemp(path.join(tmpdir(), 'gitnote-deploy-'));
		expect(await checkDeployableBuild(pathToFileURL(`${dir}/`))).toBe('it holds no build.');
	});
});

it('the Worker cannot be deployed without this check running', () => {
	const config = unstable_readConfig({ config: path.resolve(import.meta.dirname, '../../relay/wrangler.jsonc') });
	expect(config.build.command).toBe('node ../app/scripts/check-deployable-build.js');
});
