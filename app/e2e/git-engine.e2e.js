import { expect, test } from '@playwright/test';
import { createRemote, pushFromElsewhere, remoteHead, runGit, showRemote } from '../test/remote-repo.js';
import { E2E_GIT_PORT, E2E_GIT_ROOT, E2E_RELAY_PORT } from './git-engine-ports.js';

const PAGE_URL = `http://127.0.0.1:${E2E_RELAY_PORT}/`;
const AUTHOR = { name: 'Local Author', email: 'local@example.com' };

/** @typedef {import('../src/lib/git/repo.js').Repo} Repo */

/**
 * Runs one engine operation inside the page.
 * @template {Exclude<keyof Repo, 'id' | 'dir'>} K
 * @param {import('@playwright/test').Page} page
 * @param {string} url the repo's URL
 * @param {K} operation
 * @param {unknown[]} [args]
 * @returns {Promise<Awaited<ReturnType<Repo[K]>>>}
 */
async function run(page, url, operation, args = []) {
	const result = await page.evaluate(`callRepo(${JSON.stringify(url)}, ${JSON.stringify(operation)}, ${JSON.stringify(args)})`);
	return /** @type {Awaited<ReturnType<Repo[K]>>} */ (result);
}

/**
 * @param {Record<string, string>} files
 * @returns {Promise<import('../test/remote-repo.js').Remote>}
 */
function remoteWith(files) {
	return createRemote(files, { root: E2E_GIT_ROOT, port: E2E_GIT_PORT });
}

test.describe('git engine on LightningFS', () => {
	test.beforeEach(async ({ page }) => {
		const errors = /** @type {string[]} */ ([]);
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(PAGE_URL);
		await page.waitForFunction('typeof callRepo === "function"');
		expect(errors).toEqual([]);
	});

	test('clones, commits and pushes through the relay, and keeps it all across a reload', async ({ page }) => {
		const remote = await remoteWith({ 'README.md': 'seed\n', 'notes/a.md': 'old\n' });

		const cloned = await run(page, remote.url, 'clone', [{ url: remote.url }]);
		expect(cloned.branch).toBe('main');
		expect(typeof cloned.persisted).toBe('boolean');
		expect(await run(page, remote.url, 'readText', ['notes/a.md'])).toBe('old\n');

		await run(page, remote.url, 'writeFile', ['notes/a.md', 'new\n']);
		await run(page, remote.url, 'writeFile', ['notes/deep/b.md', 'added\n']);
		expect((await run(page, remote.url, 'status')).files).toEqual([
			{ path: 'notes/a.md', change: 'modified' },
			{ path: 'notes/deep/b.md', change: 'added' }
		]);
		const { oid } = await run(page, remote.url, 'commit', [{ paths: ['notes/a.md', 'notes/deep/b.md'], message: 'edit notes', author: AUTHOR }]);
		expect((await run(page, remote.url, 'push')).pushed).toBe(true);

		expect(await remoteHead(remote)).toBe(oid);
		expect(await showRemote(remote, 'main:notes/a.md')).toBe('new\n');
		expect(await showRemote(remote, 'main:notes/deep/b.md')).toBe('added\n');
		// A note must not turn executable just because the browser file system says so.
		expect(await runGit(['ls-tree', '-r', '--format=%(objectmode) %(path)', 'main'], remote.bare)).toBe(
			'100644 README.md\n100644 notes/a.md\n100644 notes/deep/b.md\n'
		);
		await runGit(['fsck', '--no-dangling'], remote.bare);

		await page.reload();
		await page.waitForFunction('typeof callRepo === "function"');
		expect((await run(page, remote.url, 'status')).clean).toBe(true);
		expect(await run(page, remote.url, 'aheadBehind')).toEqual({ branch: 'main', ahead: 0, behind: 0, hasRemote: true });
		expect(await run(page, remote.url, 'readText', ['notes/deep/b.md'])).toBe('added\n');
	});

	test('keeps a commit when the tab closes right after it resolves', async ({ page, context }) => {
		const remote = await remoteWith({ 'README.md': 'seed\n' });
		await run(page, remote.url, 'clone', [{ url: remote.url }]);
		await run(page, remote.url, 'writeFile', ['saved.md', 'keep me\n']);
		const { oid } = await run(page, remote.url, 'commit', [{ paths: ['saved.md'], message: 'keep', author: AUTHOR }]);

		// Well inside LightningFS's 500 ms superblock debounce.
		await page.close({ runBeforeUnload: false });

		const next = await context.newPage();
		await next.goto(PAGE_URL);
		await next.waitForFunction('typeof callRepo === "function"');
		expect(await run(next, remote.url, 'aheadBehind')).toMatchObject({ ahead: 1 });
		expect((await run(next, remote.url, 'status')).clean).toBe(true);
		expect(await run(next, remote.url, 'readText', ['saved.md'])).toBe('keep me\n');
		expect((await run(next, remote.url, 'push')).oid).toBe(oid);
	});

	test('merges after a depth-1 clone when both sides moved', async ({ page }) => {
		const remote = await remoteWith({ 'README.md': 'seed\n' });
		await run(page, remote.url, 'clone', [{ url: remote.url }]);
		await pushFromElsewhere(remote, { 'one.md': '1\n' }, 'one');
		await pushFromElsewhere(remote, { 'two.md': '2\n' }, 'two');
		await run(page, remote.url, 'writeFile', ['local.md', 'local\n']);
		await run(page, remote.url, 'commit', [{ paths: ['local.md'], message: 'local', author: AUTHOR }]);

		expect((await run(page, remote.url, 'pull', [{ author: AUTHOR }])).status).toBe('merged');
		expect(await run(page, remote.url, 'readText', ['two.md'])).toBe('2\n');
		expect((await run(page, remote.url, 'push')).pushed).toBe(true);
		expect(await showRemote(remote, 'main:local.md')).toBe('local\n');
	});

	test('keeps a conflict open across a reload', async ({ page }) => {
		const remote = await remoteWith({ 'clash.md': 'line\n' });
		await run(page, remote.url, 'clone', [{ url: remote.url }]);
		await pushFromElsewhere(remote, { 'clash.md': 'theirs\n' }, 'theirs');
		await run(page, remote.url, 'writeFile', ['clash.md', 'ours\n']);
		await run(page, remote.url, 'commit', [{ paths: ['clash.md'], message: 'ours', author: AUTHOR }]);

		const pulled = await run(page, remote.url, 'pull', [{ author: AUTHOR }]);
		expect(pulled.status).toBe('conflict');

		await page.reload();
		await page.waitForFunction('typeof callRepo === "function"');
		const merge = await run(page, remote.url, 'getMergeState');
		expect(merge?.theirsOid).toBe(await remoteHead(remote));
		expect(merge?.conflictedPaths).toEqual(['clash.md']);
		expect(await run(page, remote.url, 'readText', ['clash.md'])).toContain('<<<<<<< main');
	});

	test('two tabs committing at once both land', async ({ page, context }) => {
		const remote = await remoteWith({ 'README.md': 'seed\n' });
		await run(page, remote.url, 'clone', [{ url: remote.url }]);
		await run(page, remote.url, 'writeFile', ['one.md', '1\n']);
		const second = await context.newPage();
		await second.goto(PAGE_URL);
		await second.waitForFunction('typeof callRepo === "function"');
		await run(second, remote.url, 'writeFile', ['two.md', '2\n']);

		await Promise.all([
			run(page, remote.url, 'commit', [{ paths: ['one.md'], message: 'one', author: AUTHOR }]),
			run(second, remote.url, 'commit', [{ paths: ['two.md'], message: 'two', author: AUTHOR }])
		]);

		expect(await run(page, remote.url, 'aheadBehind')).toMatchObject({ ahead: 2 });
		expect((await run(second, remote.url, 'status')).clean).toBe(true);
	});

	test('reports storage quota, and wiping a repo removes it', async ({ page }) => {
		const remote = await remoteWith({ 'README.md': 'seed\n' });
		await run(page, remote.url, 'clone', [{ url: remote.url }]);

		const usage = /** @type {import('../src/lib/git/fs.js').StorageUsage | null} */ (await page.evaluate('getStorageUsage()'));
		expect(usage?.quota).toBeGreaterThan(0);
		expect(usage?.usage).toBeGreaterThan(0);

		await page.evaluate(`wipeRepo(${JSON.stringify(remote.url)})`);
		expect(await run(page, remote.url, 'isCloned')).toBe(false);
	});
});
