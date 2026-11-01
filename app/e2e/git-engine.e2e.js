import { expect, test } from '@playwright/test';
import { changeElsewhere, createRemote, pushFromElsewhere, remoteHead, runGit, showRemote } from '../test/remote-repo.js';
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

/**
 * Models the tab dying when LightningFS next saves its directory: `saves` more
 * saves land, then that save and every later IndexedDB write are lost, while
 * what already landed stays. Later steps of the operation run in memory only,
 * as the dead tab they stand for would never have reached them.
 * @param {import('@playwright/test').Page} page
 * @param {number} saves
 * @returns {Promise<unknown>}
 */
function dieAtDirectorySave(page, saves) {
	return page.evaluate(`(() => {
		const { put, delete: remove } = IDBObjectStore.prototype;
		let left = ${saves};
		IDBObjectStore.prototype.put = function (value, key) {
			if (key === '!root' && !globalThis.tabDied) {
				if (left === 0) globalThis.tabDied = true;
				left -= 1;
			}
			return globalThis.tabDied ? this.count() : put.call(this, value, key);
		};
		IDBObjectStore.prototype.delete = function (key) {
			return globalThis.tabDied ? this.count() : remove.call(this, key);
		};
	})()`);
}

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @returns {Promise<import('@playwright/test').Page>}
 */
async function openPage(context) {
	const page = await context.newPage();
	await page.goto(PAGE_URL);
	await page.waitForFunction('typeof callRepo === "function"');
	return page;
}

/**
 * Sets a scene up, kills the tab at the first, second, third... directory save
 * of an operation, and checks the repo on reopening, until the operation runs
 * past every save without dying.
 * @param {import('@playwright/test').Browser} browser
 * @param {object} options
 * @param {(page: import('@playwright/test').Page) => Promise<void>} options.arrange
 * @param {(page: import('@playwright/test').Page) => Promise<unknown>} options.act
 * @param {(page: import('@playwright/test').Page) => Promise<void>} options.check
 */
async function atEveryDirectorySave(browser, { arrange, act, check }) {
	for (let saves = 0; saves < 12; saves += 1) {
		const context = await browser.newContext();
		const page = await openPage(context);
		await arrange(page);
		await dieAtDirectorySave(page, saves);
		await act(page).catch(() => {});
		const died = await page.evaluate('globalThis.tabDied === true');
		await page.close({ runBeforeUnload: false });
		await check(await openPage(context));
		await context.close();
		if (!died) return;
	}
	throw new Error('The operation kept saving past the expected number of times.');
}

test.describe('a tab that dies at any directory save', () => {
	test.setTimeout(180_000);

	test('during a commit keeps every commit and leaves a repo that works', async ({ browser }) => {
		/** @type {import('../test/remote-repo.js').Remote} */
		let remote;
		await atEveryDirectorySave(browser, {
			arrange: async (page) => {
				remote = await remoteWith({ 'README.md': 'seed\n', 'other.md': 'other\n' });
				await run(page, remote.url, 'clone', [{ url: remote.url }]);
				await run(page, remote.url, 'writeFile', ['README.md', 'an older unpushed commit\n']);
				await run(page, remote.url, 'commit', [{ paths: ['README.md'], message: 'older', author: AUTHOR }]);
				await run(page, remote.url, 'writeFile', ['other.md', 'being committed\n']);
				await run(page, remote.url, 'writeFile', ['bystander.md', 'staying a draft\n']);
			},
			act: (page) => run(page, remote.url, 'commit', [{ paths: ['other.md'], message: 'new', author: AUTHOR }]),
			check: async (page) => {
				const { files } = await run(page, remote.url, 'status');
				expect(files.map((file) => file.path)).toContain('bystander.md');
				expect(await run(page, remote.url, 'readText', ['other.md'])).toBe('being committed\n');
				if (files.some((file) => file.path === 'other.md')) {
					await run(page, remote.url, 'commit', [{ paths: ['other.md'], message: 'new again', author: AUTHOR }]);
				}
				await run(page, remote.url, 'writeFile', ['third.md', 'after the crash\n']);
				await run(page, remote.url, 'commit', [{ paths: ['third.md'], message: 'after', author: AUTHOR }]);
				expect((await run(page, remote.url, 'push')).pushed).toBe(true);
				await runGit(['fsck', '--no-dangling'], remote.bare);
				expect(await showRemote(remote, 'main:README.md')).toBe('an older unpushed commit\n');
				expect(await showRemote(remote, 'main:other.md')).toBe('being committed\n');
				expect(await showRemote(remote, 'main:third.md')).toBe('after the crash\n');
				expect((await runGit(['ls-tree', '-r', '--name-only', 'main'], remote.bare))).not.toContain('bystander.md');
			}
		});
	});

	test('during a pull that conflicts either undoes it or leaves the whole conflict', async ({ browser }) => {
		/** @type {import('../test/remote-repo.js').Remote} */
		let remote;
		await atEveryDirectorySave(browser, {
			arrange: async (page) => {
				remote = await remoteWith({ 'clash.md': 'base\n', 'calm.md': 'calm\n' });
				await run(page, remote.url, 'clone', [{ url: remote.url }]);
				await pushFromElsewhere(remote, { 'clash.md': 'remote side\n', 'calm.md': 'calm remote\n' }, 'remote');
				await run(page, remote.url, 'writeFile', ['clash.md', 'local side\n']);
				await run(page, remote.url, 'commit', [{ paths: ['clash.md'], message: 'local', author: AUTHOR }]);
			},
			act: (page) => run(page, remote.url, 'pull', [{ author: AUTHOR }]),
			check: async (page) => {
				if ((await run(page, remote.url, 'getMergeState'))) {
					expect(await run(page, remote.url, 'readText', ['clash.md'])).toContain('<<<<<<< main');
					expect(await run(page, remote.url, 'readText', ['calm.md'])).toBe('calm remote\n');
				} else {
					expect((await run(page, remote.url, 'status')).clean).toBe(true);
					expect(await run(page, remote.url, 'readText', ['clash.md'])).toBe('local side\n');
					expect(await run(page, remote.url, 'readText', ['calm.md'])).toBe('calm\n');
					expect((await run(page, remote.url, 'pull', [{ author: AUTHOR }])).status).toBe('conflict');
				}
				await run(page, remote.url, 'writeFile', ['clash.md', 'resolved\n']);
				await run(page, remote.url, 'completeMerge', [{ author: AUTHOR }]);
				expect((await run(page, remote.url, 'push')).pushed).toBe(true);
				await runGit(['fsck', '--no-dangling'], remote.bare);
				expect(await showRemote(remote, 'main:clash.md')).toBe('resolved\n');
				expect(await showRemote(remote, 'main:calm.md')).toBe('calm remote\n');
			}
		});
	});

	test('while finishing a merge never loses the merge', async ({ browser }) => {
		/** @type {import('../test/remote-repo.js').Remote} */
		let remote;
		await atEveryDirectorySave(browser, {
			arrange: async (page) => {
				remote = await remoteWith({ 'clash.md': 'base\n', 'calm.md': 'calm\n' });
				await run(page, remote.url, 'clone', [{ url: remote.url }]);
				await pushFromElsewhere(remote, { 'clash.md': 'remote side\n', 'calm.md': 'calm remote\n' }, 'remote');
				await run(page, remote.url, 'writeFile', ['clash.md', 'local side\n']);
				await run(page, remote.url, 'commit', [{ paths: ['clash.md'], message: 'local', author: AUTHOR }]);
				await run(page, remote.url, 'pull', [{ author: AUTHOR }]);
				await run(page, remote.url, 'writeFile', ['clash.md', 'resolved\n']);
			},
			act: (page) => run(page, remote.url, 'completeMerge', [{ author: AUTHOR }]),
			check: async (page) => {
				if (await run(page, remote.url, 'getMergeState')) await run(page, remote.url, 'completeMerge', [{ author: AUTHOR }]);
				expect((await run(page, remote.url, 'status')).clean).toBe(true);
				expect((await run(page, remote.url, 'push')).pushed).toBe(true);
				await runGit(['fsck', '--no-dangling'], remote.bare);
				expect(await showRemote(remote, 'main:clash.md')).toBe('resolved\n');
				expect(await showRemote(remote, 'main:calm.md')).toBe('calm remote\n');
			}
		});
	});

	test('during an abort keeps drafts and can be finished', async ({ browser }) => {
		/** @type {import('../test/remote-repo.js').Remote} */
		let remote;
		await atEveryDirectorySave(browser, {
			arrange: async (page) => {
				remote = await remoteWith({ 'clash.md': 'base\n', 'calm.md': 'calm\n' });
				await run(page, remote.url, 'clone', [{ url: remote.url }]);
				await pushFromElsewhere(remote, { 'clash.md': 'remote side\n', 'calm.md': 'calm remote\n' }, 'remote');
				await run(page, remote.url, 'writeFile', ['clash.md', 'local side\n']);
				await run(page, remote.url, 'commit', [{ paths: ['clash.md'], message: 'local', author: AUTHOR }]);
				await run(page, remote.url, 'pull', [{ author: AUTHOR }]);
				await run(page, remote.url, 'writeFile', ['calm.md', 'my draft\n']);
			},
			act: (page) => run(page, remote.url, 'abortMerge'),
			check: async (page) => {
				if (await run(page, remote.url, 'getMergeState')) await run(page, remote.url, 'abortMerge');
				expect(await run(page, remote.url, 'readText', ['calm.md'])).toBe('my draft\n');
				expect(await run(page, remote.url, 'readText', ['clash.md'])).toBe('local side\n');
				expect((await run(page, remote.url, 'status')).files).toEqual([{ path: 'calm.md', change: 'modified' }]);
			}
		});
	});
});

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

	test('a resolved conflict keeps the remote edit, addition and deletion, read back with native git', async ({ page }) => {
		const remote = await remoteWith({ 'clash.md': 'line\n', 'calm.md': 'calm\n', 'folder/gone.md': 'gone\n' });
		await run(page, remote.url, 'clone', [{ url: remote.url }]);
		await changeElsewhere(remote, { 'clash.md': 'theirs\n', 'calm.md': 'calm remote\n', 'added.md': 'added\n' }, async (work) => {
			await runGit(['rm', '--quiet', 'folder/gone.md'], work);
		});
		await run(page, remote.url, 'writeFile', ['clash.md', 'ours\n']);
		await run(page, remote.url, 'commit', [{ paths: ['clash.md'], message: 'ours', author: AUTHOR }]);
		const theirs = await remoteHead(remote);

		expect((await run(page, remote.url, 'pull', [{ author: AUTHOR }])).status).toBe('conflict');
		expect((await run(page, remote.url, 'status')).files).toEqual([{ path: 'clash.md', change: 'modified' }]);

		// The merge stays resumable, with its staged half, across a reload.
		await page.reload();
		await page.waitForFunction('typeof callRepo === "function"');
		expect((await run(page, remote.url, 'status')).files).toEqual([{ path: 'clash.md', change: 'modified' }]);

		await run(page, remote.url, 'writeFile', ['clash.md', 'resolved\n']);
		const { parents } = await run(page, remote.url, 'completeMerge', [{ author: AUTHOR }]);
		expect(parents[1]).toBe(theirs);
		expect((await run(page, remote.url, 'status')).clean).toBe(true);
		expect(await run(page, remote.url, 'aheadBehind')).toMatchObject({ ahead: 2, behind: 0 });
		expect((await run(page, remote.url, 'push')).pushed).toBe(true);

		await runGit(['fsck', '--no-dangling'], remote.bare);
		expect((await runGit(['ls-tree', '-r', '--name-only', 'main'], remote.bare)).trim().split('\n')).toEqual(['added.md', 'calm.md', 'clash.md']);
		expect(await showRemote(remote, 'main:clash.md')).toBe('resolved\n');
		expect(await showRemote(remote, 'main:calm.md')).toBe('calm remote\n');
	});

	test('a tab closed in the middle of a clone leaves a clone that can be retried', async ({ page, context }) => {
		const remote = await remoteWith({ 'README.md': 'seed\n' });
		// The download never finishes, so the clone is still running when the tab goes.
		const request = page.waitForRequest((candidate) => candidate.url().endsWith('/git-upload-pack'));
		await page.route('**/git-upload-pack', () => {});
		void run(page, remote.url, 'clone', [{ url: remote.url }]).catch(() => {});
		await request;
		await page.close({ runBeforeUnload: false });

		const next = await context.newPage();
		await next.goto(PAGE_URL);
		await next.waitForFunction('typeof callRepo === "function"');
		expect(await run(next, remote.url, 'isCloned')).toBe(false);
		expect((await run(next, remote.url, 'clone', [{ url: remote.url }])).branch).toBe('main');
		expect(await run(next, remote.url, 'readText', ['README.md'])).toBe('seed\n');
		expect((await run(next, remote.url, 'status')).clean).toBe(true);
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

	test('two long-lived tabs keep each other\'s same-size edits', async ({ page, context }) => {
		const remote = await remoteWith({ 'a.md': 'aaaa\n', 'b.md': 'bbbb\n' });
		await run(page, remote.url, 'clone', [{ url: remote.url }]);
		const second = await context.newPage();
		await second.goto(PAGE_URL);
		await second.waitForFunction('typeof callRepo === "function"');
		// Both tabs have read the index, so each has it parsed in its cache.
		expect((await run(page, remote.url, 'status')).clean).toBe(true);
		expect((await run(second, remote.url, 'status')).clean).toBe(true);

		await run(page, remote.url, 'writeFile', ['a.md', 'AAAA\n']);
		await run(page, remote.url, 'commit', [{ paths: ['a.md'], message: 'a', author: AUTHOR }]);
		await run(second, remote.url, 'writeFile', ['b.md', 'BBBB\n']);
		await run(second, remote.url, 'commit', [{ paths: ['b.md'], message: 'b', author: AUTHOR }]);

		expect((await run(page, remote.url, 'status')).files).toEqual([]);
		expect((await run(second, remote.url, 'status')).files).toEqual([]);
		expect(await run(page, remote.url, 'aheadBehind')).toMatchObject({ ahead: 2 });
		const pushed = await run(page, remote.url, 'push');
		expect(pushed.pushed).toBe(true);
		expect(await showRemote(remote, 'main:a.md')).toBe('AAAA\n');
		expect(await showRemote(remote, 'main:b.md')).toBe('BBBB\n');
	});

	test('a wipe waits for the repo lock, reaches a second tab, and the repo can be cloned again', async ({ page, context }) => {
		const remote = await remoteWith({ 'README.md': 'seed\n' });
		await run(page, remote.url, 'clone', [{ url: remote.url }]);
		await run(page, remote.url, 'writeFile', ['draft.md', 'draft\n']);
		const second = await context.newPage();
		await second.goto(PAGE_URL);
		await second.waitForFunction('typeof callRepo === "function"');
		expect((await run(second, remote.url, 'status')).files).toEqual([{ path: 'draft.md', change: 'added' }]);

		const lockName = `gitnote:repo:${new URL(remote.url).host}${new URL(remote.url).pathname.replace(/\.git$/, '')}`;
		const order = await page.evaluate(
			`(async () => {
				const order = [];
				let release;
				const held = new Promise((resolve) => { release = resolve; });
				const lock = navigator.locks.request(${JSON.stringify(lockName)}, () => held);
				const wipe = wipeRepo(${JSON.stringify(remote.url)}).then(() => order.push('wiped'));
				await new Promise((resolve) => setTimeout(resolve, 200));
				order.push('released');
				release();
				await Promise.all([lock, wipe]);
				return order;
			})()`
		);
		expect(order).toEqual(['released', 'wiped']);

		expect(await run(second, remote.url, 'isCloned')).toBe(false);
		expect((await run(page, remote.url, 'clone', [{ url: remote.url }])).branch).toBe('main');
		expect((await run(page, remote.url, 'status')).clean).toBe(true);
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
