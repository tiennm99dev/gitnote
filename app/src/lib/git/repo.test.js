import git from 'isomorphic-git';
import { chmod, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { memfs } from 'memfs';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_CREDENTIAL } from '../../../test/git-http-server.js';
import { createRemote, changeElsewhere, nativeBlobHash as runGitHash, pushFromElsewhere, rejectPushes, RELAY_PORT, remoteHead, runGit, showRemote } from '../../../test/remote-repo.js';
import { ErrorCode, GitEngineError } from './errors.js';
import { createGitHttp } from './http.js';
import { createRepo, normalizePath } from './repo.js';

const AUTHOR = { name: 'Local Author', email: 'local@example.com' };
const RELAY_ORIGIN = `http://127.0.0.1:${RELAY_PORT}`;
const MB = 1_000_000;

/** @typedef {import('./repo.js').FsClient} FsClient */

/**
 * The real relay client, with a count of the requests it sends, so a test can
 * prove a refused operation never reached the network.
 * @returns {{ http: import('isomorphic-git').HttpClient, requests: () => number }}
 */
function countingHttp() {
	const http = createGitHttp({ relayOrigin: RELAY_ORIGIN });
	let count = 0;
	return {
		http: {
			request: (request) => {
				count += 1;
				return http.request(request);
			}
		},
		requests: () => count
	};
}

/**
 * @param {import('../../../test/remote-repo.js').Remote} remote
 * @param {Partial<import('./repo.js').RepoOptions>} [options]
 * @returns {import('./repo.js').Repo}
 */
function openRepo(remote, options = {}) {
	return createRepo({
		id: remote.id,
		fs: /** @type {FsClient} */ (/** @type {unknown} */ (memfs().fs)),
		http: createGitHttp({ relayOrigin: RELAY_ORIGIN }),
		provider: 'github',
		getCredential: () => FIXTURE_CREDENTIAL,
		...options
	});
}

/**
 * @param {Record<string, string | Uint8Array>} [files]
 * @returns {Promise<{ remote: import('../../../test/remote-repo.js').Remote, repo: import('./repo.js').Repo, fs: FsClient }>}
 */
async function clonedRepo(files = { 'README.md': 'hello\n' }) {
	const remote = await createRemote(files);
	const fs = /** @type {FsClient} */ (/** @type {unknown} */ (memfs().fs));
	const repo = openRepo(remote, { fs });
	await repo.clone({ url: remote.url });
	return { remote, repo, fs };
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<GitEngineError>} the rejection, checked to be an engine error
 */
async function rejection(promise) {
	const error = await promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(/** @type {unknown} */ reason) => reason
	);
	expect(error).toBeInstanceOf(GitEngineError);
	return /** @type {GitEngineError} */ (error);
}

/**
 * @param {import('./repo.js').Repo} repo
 * @param {string} path
 * @param {string} content
 * @returns {Promise<string>} the new commit's oid
 */
async function commitFile(repo, path, content) {
	await repo.writeFile(path, content);
	const { oid } = await repo.commit({ paths: [path], message: `change ${path}`, author: AUTHOR });
	return oid;
}

/**
 * Makes matching writes to the file system fail, as a full quota would.
 * @param {FsClient} fs
 * @param {(path: string, data: unknown) => boolean} matches
 * @returns {() => void} stops the failures
 */
function failWrites(fs, matches) {
	const original = fs.promises.writeFile;
	fs.promises.writeFile = (/** @type {string} */ path, /** @type {unknown} */ data, /** @type {unknown} */ options) => {
		if (matches(path, data)) return Promise.reject(Object.assign(new Error(`ENOSPC: no space left, ${path}`), { code: 'ENOSPC' }));
		return original.call(fs.promises, path, data, options);
	};
	return () => {
		fs.promises.writeFile = original;
	};
}

/**
 * Records flushes and file writes in order, the sequence a dying tab cuts short.
 * @param {FsClient} fs
 * @returns {string[]} `flush` and `write <path>` entries, filled as they happen
 */
function recordWrites(fs) {
	/** @type {string[]} */
	const events = [];
	const promises = /** @type {{ flush?: () => Promise<void>, writeFile: (path: string, data: unknown, options: unknown) => Promise<void> }} */ (/** @type {unknown} */ (fs.promises));
	const original = promises.writeFile;
	promises.flush = async () => void events.push('flush');
	promises.writeFile = (path, data, options) => {
		events.push(`write ${path}`);
		return original.call(fs.promises, path, data, options);
	};
	return events;
}

/**
 * LightningFS overwrites existing files at once but records new files only at a
 * flush, so a ref or an index must never be written over objects not yet saved.
 * @param {string[]} events from `recordWrites`
 */
function expectObjectsSavedBeforeNamed(events) {
	let unsaved = false;
	for (const event of events) {
		if (event === 'flush') unsaved = false;
		else if (event.includes('.git/objects/')) unsaved = true;
		else if (/\.git\/(index$|refs\/heads\/)/.test(event)) expect(unsaved, `${event} in ${events.join(', ')}`).toBe(false);
	}
	expect(unsaved).toBe(false);
	expect(events.at(-1)).toBe('flush');
}

/**
 * A client whose receive-pack POST never answers until its signal aborts.
 * @returns {{ http: import('isomorphic-git').HttpClient, stall: (on: boolean) => void, sending: Promise<void> }}
 */
function stallingPushHttp() {
	const http = createGitHttp({ relayOrigin: RELAY_ORIGIN });
	let stalled = false;
	/** @type {() => void} */
	let markSending = () => {};
	const sending = new Promise((resolve) => {
		markSending = () => resolve(undefined);
	});
	return {
		http: {
			request: (request) => {
				if (!stalled || request.method !== 'POST') return http.request(request);
				markSending();
				return new Promise((_resolve, reject) => {
					request.signal?.addEventListener('abort', () => reject(request.signal?.reason));
				});
			}
		},
		stall: (on) => {
			stalled = on;
		},
		sending: /** @type {Promise<void>} */ (sending)
	};
}

/**
 * Pushes a repo that just finished a merge and reads the commit back with
 * native git, the independent witness of the merge's tree.
 * @param {import('../../../test/remote-repo.js').Remote} remote
 * @param {import('./repo.js').Repo} repo
 * @returns {Promise<string[]>} the tree's file paths on the remote
 */
async function pushedTree(remote, repo) {
	expect((await repo.push()).pushed).toBe(true);
	await runGit(['fsck', '--no-dangling'], remote.bare);
	return (await runGit(['ls-tree', '-r', '--name-only', 'main'], remote.bare)).trim().split('\n');
}

/**
 * A repo with one commit on each side that clash over one file, plus the
 * remote changes in `theirs`.
 * @param {Record<string, string | Uint8Array>} seed
 * @param {Record<string, string | Uint8Array>} theirs
 * @param {(work: string) => Promise<void>} [theirsExtra] more changes to the remote's clone
 * @returns {ReturnType<typeof clonedRepo>}
 */
async function divergedRepo(seed, theirs, theirsExtra) {
	const cloned = await clonedRepo({ ...seed, 'clash.md': 'line\n' });
	await changeElsewhere(cloned.remote, { ...theirs, 'clash.md': 'theirs\n' }, theirsExtra);
	await commitFile(cloned.repo, 'clash.md', 'ours\n');
	return cloned;
}

describe('clone', () => {
	it('checks out the default branch shallowly and records it', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n', 'notes/a.md': '# a\n' });
		await pushFromElsewhere(remote, { 'notes/b.md': '# b\n' }, 'second');
		const fs = /** @type {FsClient} */ (/** @type {unknown} */ (memfs().fs));
		const persist = vi.fn(async () => true);
		const repo = openRepo(remote, { fs, storage: { persist } });
		const phases = new Set();

		const result = await repo.clone({ url: remote.url, onProgress: (event) => void phases.add(event.phase) });

		expect(result).toEqual({ branch: 'main', oid: await remoteHead(remote), persisted: true });
		expect(phases.size).toBeGreaterThan(0);
		expect(persist).toHaveBeenCalledOnce();
		expect(await repo.listTree()).toEqual([
			{ path: 'README.md', size: 5 },
			{ path: 'notes/a.md', size: 4 },
			{ path: 'notes/b.md', size: 4 }
		]);
		const shallow = await fs.promises.readFile('/repo/.git/shallow', { encoding: 'utf8' });
		expect(shallow.trim()).toBe(result.oid);
		const config = await fs.promises.readFile('/repo/.git/config', { encoding: 'utf8' });
		expect(config).toContain('defaultBranch = main');
	});

	it('checks out the branch the user picked, and pushes that branch', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		await runGit(['branch', 'drafts', 'main'], remote.bare);
		await pushFromElsewhere(remote, { 'only-on-main.md': 'main\n' }, 'main moves on');
		const fs = /** @type {FsClient} */ (/** @type {unknown} */ (memfs().fs));
		const repo = openRepo(remote, { fs });

		const result = await repo.clone({ url: remote.url, ref: 'drafts' });

		expect(result.branch).toBe('drafts');
		expect((await repo.listTree()).map((file) => file.path)).toEqual(['README.md']);
		await commitFile(repo, 'new.md', 'on drafts\n');
		expect((await repo.push()).pushed).toBe(true);
		expect(await showRemote(remote, 'drafts:new.md')).toBe('on drafts\n');
		await expect(showRemote(remote, 'main:new.md')).rejects.toThrow();
	});

	it('names a missing branch and leaves nothing behind', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const repo = openRepo(remote);

		const error = await rejection(repo.clone({ url: remote.url, ref: 'gone' }));

		expect(error.code).toBe(ErrorCode.BRANCH_NOT_FOUND);
		expect(error.message).toContain('gone');
		expect(await repo.isCloned()).toBe(false);
		expect((await repo.clone({ url: remote.url })).branch).toBe('main');
	});

	it.each(['-upload-pack=x', '../main', 'a b', 'a..b', 'x.lock', ''])('refuses the branch name %j before any request', async (ref) => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const { http, requests } = countingHttp();

		const error = await rejection(openRepo(remote, { http }).clone({ url: remote.url, ref }));

		expect(error.code).toBe(ErrorCode.INVALID_ARGUMENT);
		expect(requests()).toBe(0);
	});

	it('leaves nothing behind when cancelled, so it can be retried', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const repo = openRepo(remote);
		const controller = new AbortController();

		const error = await rejection(
			repo.clone({
				url: remote.url,
				onProgress: () => controller.abort(),
				signal: controller.signal
			})
		);

		expect(error.code).toBe(ErrorCode.CANCELLED);
		expect(await repo.isCloned()).toBe(false);
		expect((await repo.clone({ url: remote.url })).branch).toBe('main');
	});

	it('recovers from an interrupted clone, which no catch block ever saw', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const fs = /** @type {FsClient} */ (/** @type {unknown} */ (memfs().fs));
		const repo = openRepo(remote, { fs });
		// What a tab that died mid-download leaves behind.
		await fs.promises.mkdir('/repo');
		await git.init({ fs, dir: '/repo', defaultBranch: 'main' });
		await git.addRemote({ fs, dir: '/repo', remote: 'origin', url: remote.url });
		await fs.promises.writeFile('/repo/left-over.md', 'partial\n');

		expect(await repo.isCloned()).toBe(false);
		expect((await rejection(repo.status())).code).toBe(ErrorCode.NOT_CLONED);
		expect((await rejection(repo.aheadBehind())).code).toBe(ErrorCode.NOT_CLONED);
		expect((await rejection(repo.pull({ author: AUTHOR }))).code).toBe(ErrorCode.NOT_CLONED);
		expect((await rejection(repo.readText('left-over.md'))).code).toBe(ErrorCode.NOT_CLONED);

		expect((await repo.clone({ url: remote.url })).branch).toBe('main');
		expect((await repo.status()).clean).toBe(true);
		expect((await repo.listTree()).map((entry) => entry.path)).toEqual(['README.md']);
	});

	it('saves what it wrote before it calls itself a clone', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const fs = /** @type {FsClient} */ (/** @type {unknown} */ (memfs().fs));
		const events = recordWrites(fs);

		await openRepo(remote, { fs }).clone({ url: remote.url });

		const config = events.findLastIndex((event) => event.endsWith('/.git/config'));
		expect(events.slice(0, config).at(-1)).toBe('flush');
		expect(events.at(-1)).toBe('flush');
	});

	it('keeps a complete clone when the optional storage request fails', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const repo = openRepo(remote, { storage: { persist: () => Promise.reject(new Error('denied')) } });

		expect((await repo.clone({ url: remote.url })).persisted).toBeNull();
		expect(await repo.isCloned()).toBe(true);
	});

	it('asks the browser for persistent storage when the caller says nothing', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const persist = vi.fn(async () => true);
		vi.stubGlobal('navigator', { storage: { persist } });
		try {
			expect((await openRepo(remote).clone({ url: remote.url })).persisted).toBe(true);
			expect(persist).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('refuses a URL with a credential before storing anything', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const fs = /** @type {FsClient} */ (/** @type {unknown} */ (memfs().fs));
		const counted = countingHttp();
		const repo = openRepo(remote, { fs, http: counted.http });

		const error = await rejection(repo.clone({ url: remote.url.replace('http://', 'http://x-access-token:SECRET@') }));

		expect(error.code).toBe(ErrorCode.INVALID_ARGUMENT);
		expect(counted.requests()).toBe(0);
		expect(await repo.isCloned()).toBe(false);
		await expect(fs.promises.lstat('/repo')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it.each(['not a url', 'ssh://github.com/o/r.git'])('refuses the URL %j', async (url) => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		expect((await rejection(openRepo(remote).clone({ url }))).code).toBe(ErrorCode.INVALID_ARGUMENT);
	});

	it('reports any abort as a cancel, whatever its reason', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const controller = new AbortController();
		const repo = openRepo(remote);

		const error = await rejection(
			repo.clone({ url: remote.url, onProgress: () => controller.abort(new Error('user left')), signal: controller.signal })
		);

		expect(error.code).toBe(ErrorCode.CANCELLED);
		expect(await repo.isCloned()).toBe(false);
	});

	it('refuses to clone over an existing clone', async () => {
		const { remote, repo } = await clonedRepo();
		expect((await rejection(repo.clone({ url: remote.url }))).code).toBe(ErrorCode.ALREADY_CLONED);
	});

	it('explains that an empty repository cannot be cloned', async () => {
		const remote = await createRemote({});
		const repo = openRepo(remote);

		const error = await rejection(repo.clone({ url: remote.url }));

		expect(error.code).toBe(ErrorCode.EMPTY_REPO);
		expect(await repo.isCloned()).toBe(false);
	});

	it('reports a missing repository', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const repo = openRepo(remote);
		const error = await rejection(repo.clone({ url: remote.url.replace('.git', '-missing.git') }));
		expect(error.code).toBe(ErrorCode.REPO_NOT_FOUND);
		expect(await repo.isCloned()).toBe(false);
	});
});

describe('working tree', () => {
	it('reports added, modified and deleted files', async () => {
		const { repo } = await clonedRepo({ 'keep.md': 'keep\n', 'edit.md': 'old\n', 'gone.md': 'gone\n' });
		expect((await repo.status()).clean).toBe(true);

		await repo.writeFile('new/deep/added.md', 'new\n');
		await repo.writeFile('edit.md', 'changed\n');
		await repo.remove('gone.md');

		expect(await repo.status()).toEqual({
			clean: false,
			merge: null,
			files: [
				{ path: 'edit.md', change: 'modified' },
				{ path: 'gone.md', change: 'deleted' },
				{ path: 'new/deep/added.md', change: 'added' }
			]
		});
		expect(await repo.readText('new/deep/added.md')).toBe('new\n');
	});

	it('sees a same-size edit made in the second of the last commit', async () => {
		const { repo } = await clonedRepo({ 'a.md': 'aaaa\n' });
		await repo.writeFile('a.md', 'bbbb\n');
		await repo.commit({ paths: ['a.md'], message: 'first', author: AUTHOR });

		await repo.writeFile('a.md', 'cccc\n');

		expect((await repo.status()).files).toEqual([{ path: 'a.md', change: 'modified' }]);
	});

	it('shows no change after rewriting a file with the same content', async () => {
		const { repo } = await clonedRepo({ 'a.md': 'same\n' });
		await repo.writeFile('a.md', 'same\n');
		expect((await repo.status()).clean).toBe(true);
	});

	it('deletes the old file only after the file system has saved the new one', async () => {
		const { repo, fs } = await clonedRepo({ 'a.md': 'old\n' });
		/** @type {string[]} */
		const events = [];
		const promises = /** @type {{ flush?: () => Promise<void>, unlink: (path: string) => Promise<void> }} */ (/** @type {unknown} */ (fs.promises));
		const unlink = promises.unlink;
		promises.flush = async () => void events.push('flush');
		promises.unlink = (path) => {
			events.push(`unlink ${path}`);
			return unlink.call(fs.promises, path);
		};

		await repo.writeFile('a.md', 'new\n');

		expect(events).toEqual(['flush', 'unlink /repo/.git/gitnote-write.bak', 'flush']);
		expect(await repo.readText('a.md')).toBe('new\n');
	});

	it('clears a backup a closed tab left behind', async () => {
		const { repo, fs } = await clonedRepo({ 'a.md': 'old\n' });
		await fs.promises.writeFile('/repo/.git/gitnote-write.bak', 'stale');

		await repo.writeFile('a.md', 'new\n');
		await repo.writeFile('fresh.md', 'new\n');

		await expect(fs.promises.lstat('/repo/.git/gitnote-write.bak')).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await repo.readText('a.md')).toBe('new\n');
	});

	it('round-trips bytes unchanged', async () => {
		const { repo } = await clonedRepo();
		const bytes = Uint8Array.from([0, 255, 1, 254, 10]);
		await repo.writeFile('image.bin', bytes);
		expect([...(await repo.readFile('image.bin'))]).toEqual([...bytes]);
	});

	it('renames files and folders, and never overwrites', async () => {
		const { repo } = await clonedRepo({ 'a.md': 'a\n', 'dir/b.md': 'b\n', 'c.md': 'c\n' });

		await repo.rename('a.md', 'moved/a.md');
		await repo.rename('dir', 'folder');

		expect((await repo.listTree()).map((entry) => entry.path)).toEqual(['c.md', 'folder/b.md', 'moved/a.md']);
		expect((await rejection(repo.rename('c.md', 'moved/a.md'))).code).toBe(ErrorCode.PATH_EXISTS);
		expect((await rejection(repo.rename('nope.md', 'x.md'))).code).toBe(ErrorCode.PATH_NOT_FOUND);
		expect((await rejection(repo.rename('folder', 'folder/inner'))).code).toBe(ErrorCode.INVALID_PATH);
	});

	it('removes folders recursively', async () => {
		const { repo } = await clonedRepo({ 'dir/a.md': 'a\n', 'dir/sub/b.md': 'b\n', 'c.md': 'c\n' });
		await repo.remove('dir');
		expect((await repo.listTree()).map((entry) => entry.path)).toEqual(['c.md']);
	});

	it.each(['', '/etc/passwd', '../outside.md', 'a/../b.md', 'a//b.md', 'a/', '.git/config', 'sub/.GIT/hooks', 'a\\b.md', 'a\0b'])(
		'rejects the path %j',
		(path) => {
			expect(() => normalizePath(path)).toThrowError(GitEngineError);
		}
	);

	it('refuses to write into the git directory', async () => {
		const { repo, fs } = await clonedRepo();
		const before = await fs.promises.readFile('/repo/.git/config', { encoding: 'utf8' });
		expect((await rejection(repo.writeFile('.git/config', 'evil'))).code).toBe(ErrorCode.INVALID_PATH);
		expect(await fs.promises.readFile('/repo/.git/config', { encoding: 'utf8' })).toBe(before);
	});

	it('answers not cloned before a clone exists', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const repo = openRepo(remote);
		expect((await rejection(repo.status())).code).toBe(ErrorCode.NOT_CLONED);
		expect((await rejection(repo.writeFile('a.md', 'a'))).code).toBe(ErrorCode.NOT_CLONED);
	});
});

describe('commit', () => {
	it('stages only the selected paths', async () => {
		const { repo } = await clonedRepo({ 'a.md': 'a\n', 'b.md': 'b\n', 'gone.md': 'gone\n' });
		await repo.writeFile('a.md', 'a2\n');
		await repo.writeFile('b.md', 'b2\n');
		await repo.remove('gone.md');

		const result = await repo.commit({ paths: ['a.md', 'gone.md'], message: 'edit a, drop gone', author: AUTHOR });

		expect(result.paths).toEqual(['a.md', 'gone.md']);
		expect(result.warnings).toEqual([]);
		expect((await repo.status()).files).toEqual([{ path: 'b.md', change: 'modified' }]);
		expect((await repo.aheadBehind()).ahead).toBe(1);
	});

	it('refuses an empty commit', async () => {
		const { repo } = await clonedRepo();
		const error = await rejection(repo.commit({ paths: ['README.md'], message: 'nothing', author: AUTHOR }));
		expect(error.code).toBe(ErrorCode.NOTHING_TO_COMMIT);
	});

	it('requires a message and an author', async () => {
		const { repo } = await clonedRepo();
		await repo.writeFile('README.md', 'x\n');
		expect((await rejection(repo.commit({ paths: ['README.md'], message: '  ', author: AUTHOR }))).code).toBe(ErrorCode.INVALID_ARGUMENT);
		expect((await rejection(repo.commit({ paths: ['README.md'], message: 'm', author: { name: '', email: '' } }))).code).toBe(
			ErrorCode.INVALID_ARGUMENT
		);
		expect((await rejection(repo.commit({ paths: [], message: 'm', author: AUTHOR }))).code).toBe(ErrorCode.INVALID_ARGUMENT);
	});

	it.each([
		['a line break in the name', { name: 'Eve\ncommitter Forged', email: 'e@example.com' }],
		['a line break in the email', { name: 'Eve', email: 'e@example.com\nx' }],
		['a control character', { name: 'E\u0007ve', email: 'e@example.com' }],
		['an angle bracket in the name', { name: 'Eve <x>', email: 'e@example.com' }],
		['an angle bracket in the email', { name: 'Eve', email: '<a>b@example.com' }]
	])('refuses an author with %s, which would break the commit header', async (_name, author) => {
		const { repo } = await clonedRepo();
		await repo.writeFile('README.md', 'x\n');
		expect((await rejection(repo.commit({ paths: ['README.md'], message: 'm', author }))).code).toBe(ErrorCode.INVALID_ARGUMENT);
		expect((await repo.aheadBehind()).ahead).toBe(0);
	});

	it('accepts an author name with accents and punctuation', async () => {
		const { remote, repo } = await clonedRepo();
		await repo.writeFile('README.md', 'x\n');
		await repo.commit({ paths: ['README.md'], message: 'm', author: { name: "Nguyễn O'Neil, Jr.", email: 'n+tag@example.com' } });
		await repo.push();
		expect((await runGit(['log', '-1', '--format=%an', 'main'], remote.bare)).trim()).toBe("Nguyễn O'Neil, Jr.");
	});

	it('resolves only after the file system flushed', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const fs = /** @type {FsClient} */ (/** @type {unknown} */ (memfs().fs));
		/** @type {string[]} */
		const events = [];
		const promises = /** @type {{ flush?: () => Promise<void> }} */ (fs.promises);
		promises.flush = async () => {
			events.push('flush-start');
			await new Promise((resolve) => setTimeout(resolve, 20));
			events.push('flush-end');
		};
		const repo = openRepo(remote, { fs });
		await repo.clone({ url: remote.url });
		await repo.writeFile('README.md', 'edited\n');
		events.length = 0;

		await repo.commit({ paths: ['README.md'], message: 'edit', author: AUTHOR });
		events.push('resolved');

		expect(events.slice(-3)).toEqual(['flush-start', 'flush-end', 'resolved']);
	});

	it('saves blobs before the index names them, and the commit before the branch moves', async () => {
		const { repo, fs } = await clonedRepo({ 'README.md': 'seed\n' });
		await repo.writeFile('README.md', 'edited\n');
		await repo.writeFile('new/added.md', 'added\n');
		const events = recordWrites(fs);

		await repo.commit({ paths: ['README.md', 'new/added.md'], message: 'edit', author: AUTHOR });

		expect(events.some((event) => event.endsWith('/refs/heads/main'))).toBe(true);
		expectObjectsSavedBeforeNamed(events);
	});

	it('leaves out what a closed tab left staged', async () => {
		const { remote, repo, fs } = await clonedRepo({ 'a.md': 'a\n', 'b.md': 'b\n' });
		await repo.writeFile('a.md', 'staged by a tab that died\n');
		await git.add({ fs, dir: '/repo', gitdir: '/repo/.git', filepath: 'a.md' });
		await repo.writeFile('new.md', 'also staged\n');
		await git.add({ fs, dir: '/repo', gitdir: '/repo/.git', filepath: 'new.md' });
		await repo.writeFile('b.md', 'the commit\n');

		await repo.commit({ paths: ['b.md'], message: 'only b', author: AUTHOR });

		expect((await repo.status()).files).toEqual([
			{ path: 'a.md', change: 'modified' },
			{ path: 'new.md', change: 'added' }
		]);
		await repo.push();
		expect(await showRemote(remote, 'main:a.md')).toBe('a\n');
		expect((await runGit(['ls-tree', '-r', '--name-only', 'main'], remote.bare)).trim().split('\n')).toEqual(['a.md', 'b.md']);
	});

	it('names the damage when the commit behind the branch is gone', async () => {
		const { remote, repo, fs } = await clonedRepo();
		const oid = await commitFile(repo, 'README.md', 'lost\n');
		await fs.promises.unlink(`/repo/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
		const reloaded = openRepo(remote, { fs });

		for (const operation of [() => reloaded.status(), () => reloaded.aheadBehind(), () => reloaded.push(), () => reloaded.pull({ author: AUTHOR })]) {
			expect((await rejection(operation())).code).toBe(ErrorCode.REPO_DAMAGED);
		}
	});

	it('keeps both commits when two tabs commit at once', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const fs = /** @type {FsClient} */ (/** @type {unknown} */ (memfs().fs));
		const tabOne = openRepo(remote, { fs });
		const tabTwo = openRepo(remote, { fs });
		await tabOne.clone({ url: remote.url });
		await tabOne.writeFile('one.md', '1\n');
		await tabTwo.writeFile('two.md', '2\n');

		await Promise.all([
			tabOne.commit({ paths: ['one.md'], message: 'one', author: AUTHOR }),
			tabTwo.commit({ paths: ['two.md'], message: 'two', author: AUTHOR })
		]);

		expect((await tabOne.status()).clean).toBe(true);
		expect((await tabOne.aheadBehind()).ahead).toBe(2);
	});
});

describe('push', () => {
	it('round-trips clone, edit, commit and push to the bare repo', async () => {
		const { remote, repo } = await clonedRepo({ 'notes/a.md': 'old\n' });
		await repo.writeFile('notes/a.md', 'new\n');
		await repo.writeFile('notes/b.md', 'added\n');
		const { oid } = await repo.commit({ paths: ['notes/a.md', 'notes/b.md'], message: 'edit notes', author: AUTHOR });
		expect(await repo.aheadBehind()).toEqual({ branch: 'main', ahead: 1, behind: 0, hasRemote: true });

		const result = await repo.push();

		expect(result).toEqual({ pushed: true, oid, bytes: 'new\n'.length + 'added\n'.length });
		expect(await remoteHead(remote)).toBe(oid);
		expect(await showRemote(remote, 'main:notes/a.md')).toBe('new\n');
		expect(await showRemote(remote, 'main:notes/b.md')).toBe('added\n');
		const author = await runGit(['log', '-1', '--format=%an <%ae>|%s', 'main'], remote.bare);
		expect(author.trim()).toBe('Local Author <local@example.com>|edit notes');
		expect(await runGit(['fsck', '--no-dangling'], remote.bare)).toBeDefined();
		expect(await repo.aheadBehind()).toEqual({ branch: 'main', ahead: 0, behind: 0, hasRemote: true });
	});

	it('does nothing when there is nothing to push', async () => {
		const counted = countingHttp();
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const repo = openRepo(remote, { http: counted.http });
		await repo.clone({ url: remote.url });
		const before = counted.requests();
		expect((await repo.push()).pushed).toBe(false);
		expect(counted.requests()).toBe(before);
	});

	it('needs a credential to write', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const repo = openRepo(remote, { getCredential: undefined });
		await repo.clone({ url: remote.url });
		await commitFile(repo, 'README.md', 'edit\n');
		expect((await rejection(repo.push())).code).toBe(ErrorCode.AUTH_REQUIRED);
	});

	it('asks again once when a credential is refused, then gives up', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		/** @type {boolean[]} */
		const asked = [];
		const refreshing = openRepo(remote, {
			getCredential: ({ failed }) => {
				asked.push(failed);
				return failed ? FIXTURE_CREDENTIAL : { username: 'x-access-token', password: 'expired' };
			}
		});
		await refreshing.clone({ url: remote.url });
		await commitFile(refreshing, 'README.md', 'edit\n');

		expect((await refreshing.push()).pushed).toBe(true);
		expect(asked).toEqual([false, true]);

		const stuck = openRepo(remote, { getCredential: () => ({ username: 'x-access-token', password: 'expired' }) });
		await stuck.clone({ url: remote.url });
		await commitFile(stuck, 'README.md', 'edit again\n');
		expect((await rejection(stuck.push())).code).toBe(ErrorCode.AUTH_REQUIRED);
	});

	it('explains a host rejection that arrives over sideband through the relay', async () => {
		const { remote, repo } = await clonedRepo();
		await rejectPushes(remote, 'error: GH001: Large files detected.');
		const before = await remoteHead(remote);
		await commitFile(repo, 'big.md', 'pretend this is large\n');

		const error = await rejection(repo.push());

		expect(error.code).toBe(ErrorCode.HOST_FILE_TOO_LARGE);
		expect(await remoteHead(remote)).toBe(before);
		expect((await repo.aheadBehind()).ahead).toBe(1);
	});

	it('takes a stalled push off the lock: saves and reads go on and the push cancels', async () => {
		const remote = await createRemote({ 'a.md': 'seed\n' });
		const { http, stall, sending } = stallingPushHttp();
		const repo = openRepo(remote, { http });
		await repo.clone({ url: remote.url });
		await commitFile(repo, 'a.md', 'local\n');
		const before = await remoteHead(remote);
		stall(true);
		const controller = new AbortController();

		const pushing = rejection(repo.push({ signal: controller.signal }));
		await sending;
		await repo.writeFile('draft.md', 'saved during the stall\n');
		expect(await repo.readText('a.md')).toBe('local\n');
		expect((await repo.status()).files).toEqual([{ path: 'draft.md', change: 'added' }]);
		controller.abort(new Error('user left'));

		expect((await pushing).code).toBe(ErrorCode.CANCELLED);
		expect(await remoteHead(remote)).toBe(before);
		expect((await repo.aheadBehind()).ahead).toBe(1);
		stall(false);
		expect((await repo.push()).pushed).toBe(true);
	});

	it('sends the commit it checked when another lands during the send', async () => {
		const remote = await createRemote({ 'a.md': 'seed\n' });
		const http = createGitHttp({ relayOrigin: RELAY_ORIGIN });
		/** @type {null | (() => Promise<unknown>)} */
		let beforeSend = null;
		const repo = openRepo(remote, {
			http: {
				request: async (request) => {
					if (request.method === 'POST' && beforeSend) {
						const hook = beforeSend;
						beforeSend = null;
						await hook();
					}
					return http.request(request);
				}
			}
		});
		await repo.clone({ url: remote.url });
		const checked = await commitFile(repo, 'a.md', 'checked\n');
		beforeSend = () => commitFile(repo, 'later.md', 'later\n');

		expect(await repo.push()).toMatchObject({ pushed: true, oid: checked });

		expect(await remoteHead(remote)).toBe(checked);
		expect(await repo.aheadBehind()).toMatchObject({ ahead: 1, behind: 0 });
		expect((await repo.push()).pushed).toBe(true);
		expect(await showRemote(remote, 'main:later.md')).toBe('later\n');
	});

	it('lets one push finish before the next starts, so the second has nothing to send', async () => {
		const { repo } = await clonedRepo();
		await commitFile(repo, 'README.md', 'edit\n');

		const [first, second] = await Promise.all([repo.push(), repo.push()]);

		expect(first.pushed).toBe(true);
		expect(second.pushed).toBe(false);
	});

	it('asks for a pull when the remote moved after the last fetch', async () => {
		const { remote, repo } = await clonedRepo();
		await commitFile(repo, 'local.md', 'local\n');
		await pushFromElsewhere(remote, { 'other.md': 'other\n' }, 'elsewhere');

		const error = await rejection(repo.push());

		expect(error.code).toBe(ErrorCode.NON_FAST_FORWARD);
		expect(await runGit(['log', '--format=%s', 'main'], remote.bare)).toBe('elsewhere\nseed\n');
	});

	it('refuses before any request while a pull left a merge open', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const counted = countingHttp();
		const repo = openRepo(remote, { http: counted.http });
		await repo.clone({ url: remote.url });
		await pushFromElsewhere(remote, { 'README.md': 'theirs\n' }, 'theirs');
		await commitFile(repo, 'README.md', 'ours\n');
		const pulled = await repo.pull({ author: AUTHOR });
		expect(pulled.status).toBe('conflict');
		const before = counted.requests();

		expect((await rejection(repo.push())).code).toBe(ErrorCode.MERGE_IN_PROGRESS);
		expect(counted.requests()).toBe(before);
	});
});

describe('pull', () => {
	it('fast-forwards a clean tree', async () => {
		const { remote, repo } = await clonedRepo();
		await pushFromElsewhere(remote, { 'README.md': 'updated\n', 'new.md': 'new\n' }, 'elsewhere');

		const result = await repo.pull({ author: AUTHOR });

		expect(result).toEqual({ status: 'fast_forward', oid: await remoteHead(remote) });
		expect(await repo.readText('README.md')).toBe('updated\n');
		expect(await repo.readText('new.md')).toBe('new\n');
		expect((await repo.status()).clean).toBe(true);
	});

	it('answers up to date when nothing changed or only local commits exist', async () => {
		const { repo } = await clonedRepo();
		expect((await repo.pull({ author: AUTHOR })).status).toBe('up_to_date');
		await commitFile(repo, 'README.md', 'local\n');
		expect((await repo.pull({ author: AUTHOR })).status).toBe('up_to_date');
		expect(await repo.readText('README.md')).toBe('local\n');
	});

	it('merges after a depth-1 clone when the remote gained two commits and local one', async () => {
		const { remote, repo } = await clonedRepo({ 'README.md': 'seed\n', 'shared.md': 'one\ntwo\nthree\n' });
		await pushFromElsewhere(remote, { 'remote-1.md': 'r1\n' }, 'remote one');
		await pushFromElsewhere(remote, { 'remote-2.md': 'r2\n' }, 'remote two');
		await commitFile(repo, 'local.md', 'local\n');
		expect((await repo.aheadBehind()).ahead).toBe(1);

		const result = await repo.pull({ author: AUTHOR });

		expect(result.status).toBe('merged');
		for (const [path, content] of Object.entries({ 'local.md': 'local\n', 'remote-1.md': 'r1\n', 'remote-2.md': 'r2\n' })) {
			expect(await repo.readText(path)).toBe(content);
		}
		expect((await repo.status()).clean).toBe(true);
		// The local commit and the merge commit; the remote has the shallow boundary.
		expect(await repo.aheadBehind()).toEqual({ branch: 'main', ahead: 2, behind: 0, hasRemote: true });

		expect((await repo.push()).pushed).toBe(true);
		const parents = await runGit(['log', '-1', '--format=%p', 'main'], remote.bare);
		expect(parents.trim().split(' ')).toHaveLength(2);
		expect(await showRemote(remote, 'main:local.md')).toBe('local\n');
		expect(await runGit(['fsck', '--no-dangling'], remote.bare)).toBeDefined();
	});

	it('merges edits to different lines of one file without conflict', async () => {
		const { remote, repo } = await clonedRepo({ 'shared.md': 'one\ntwo\nthree\nfour\nfive\n' });
		await pushFromElsewhere(remote, { 'shared.md': 'ONE\ntwo\nthree\nfour\nfive\n' }, 'remote edit');
		await commitFile(repo, 'shared.md', 'one\ntwo\nthree\nfour\nFIVE\n');

		expect((await repo.pull({ author: AUTHOR })).status).toBe('merged');
		expect(await repo.readText('shared.md')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
	});

	it('keeps U+2028, U+2029 and a lone CR through a clean merge', async () => {
		const seed = 'first\nkeep\u2028this\nand\u2029that\nold\rmac\nline5\nline6\nlast\n';
		const { remote, repo } = await clonedRepo({ 'n.md': seed });
		await pushFromElsewhere(remote, { 'n.md': seed.replace('last', 'theirs') }, 'remote edit');
		await commitFile(repo, 'n.md', seed.replace('first', 'ours'));

		expect((await repo.pull({ author: AUTHOR })).status).toBe('merged');

		expect(await repo.readText('n.md')).toBe('ours\nkeep\u2028this\nand\u2029that\nold\rmac\nline5\nline6\ntheirs\n');
	});

	it('fetches again when a closed tab kept the remote ref but lost what it fetched', async () => {
		const { remote, fs } = await clonedRepo();
		await pushFromElsewhere(remote, { 'new.md': 'new\n' }, 'elsewhere');
		await fs.promises.writeFile('/repo/.git/refs/remotes/origin/main', `${await remoteHead(remote)}\n`);
		const reloaded = openRepo(remote, { fs });

		expect((await reloaded.status()).clean).toBe(true);
		expect((await reloaded.pull({ author: AUTHOR })).status).toBe('fast_forward');
		expect(await reloaded.readText('new.md')).toBe('new\n');
		await commitFile(reloaded, 'new.md', 'edited\n');
		expect((await reloaded.push()).pushed).toBe(true);
	});

	it('still pushes when a closed tab kept the remote ref but lost what it fetched', async () => {
		const { remote, repo, fs } = await clonedRepo();
		await commitFile(repo, 'local.md', 'local\n');
		await pushFromElsewhere(remote, { 'new.md': 'new\n' }, 'elsewhere');
		await fs.promises.writeFile('/repo/.git/refs/remotes/origin/main', `${await remoteHead(remote)}\n`);
		const reloaded = openRepo(remote, { fs });

		// The host still refuses, since it has commits this device has not seen.
		expect((await rejection(reloaded.push())).code).toBe(ErrorCode.NON_FAST_FORWARD);
		expect((await reloaded.pull({ author: AUTHOR })).status).toBe('merged');
		expect((await reloaded.push()).pushed).toBe(true);
	});

	it('refuses a dirty tree and leaves the branch ref unchanged, with no request', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const counted = countingHttp();
		const repo = openRepo(remote, { http: counted.http });
		await repo.clone({ url: remote.url });
		await pushFromElsewhere(remote, { 'README.md': 'updated\n' }, 'elsewhere');
		await repo.writeFile('README.md', 'my draft\n');
		const before = await repo.aheadBehind();
		const requests = counted.requests();

		const error = await rejection(repo.pull({ author: AUTHOR }));

		expect(error.code).toBe(ErrorCode.DIRTY_TREE);
		expect(counted.requests()).toBe(requests);
		expect(await repo.aheadBehind()).toEqual(before);
		expect(await repo.readText('README.md')).toBe('my draft\n');
	});

	it('refuses a same-size draft made right after the clone', async () => {
		const { remote, repo } = await clonedRepo({ 'a.md': 'seed\n' });
		await pushFromElsewhere(remote, { 'a.md': 'next\n' }, 'elsewhere');
		await repo.writeFile('a.md', 'mine\n');

		expect((await rejection(repo.pull({ author: AUTHOR }))).code).toBe(ErrorCode.DIRTY_TREE);
		expect(await repo.readText('a.md')).toBe('mine\n');
	});

	it('yields conflict markers and the conflicted paths, without moving the branch', async () => {
		const { remote, repo } = await clonedRepo({ 'clash.md': 'line\n', 'calm.md': 'calm\n' });
		await pushFromElsewhere(remote, { 'clash.md': 'theirs\n', 'calm.md': 'calm remote\n' }, 'remote edit');
		const oursOid = await commitFile(repo, 'clash.md', 'ours\n');

		const result = await repo.pull({ author: AUTHOR });

		expect(result.status).toBe('conflict');
		if (result.status !== 'conflict') return;
		expect(result.oid).toBe(oursOid);
		expect(result.merge).toMatchObject({
			branch: 'main',
			oursOid,
			theirsOid: await remoteHead(remote),
			conflictedPaths: ['clash.md'],
			binaryPaths: []
		});
		expect(await repo.readText('clash.md')).toBe('<<<<<<< main\nours\n=======\ntheirs\n>>>>>>> origin/main\n');
		expect(await repo.readText('calm.md')).toBe('calm remote\n');
		expect((await repo.status()).files).toEqual([{ path: 'clash.md', change: 'modified' }]);
		const ahead = await repo.aheadBehind();
		expect(ahead.ahead).toBe(1);
		expect(ahead.behind).toBe(1);
	});

	it('conflicts when both sides add the same file with different content', async () => {
		const { remote, repo } = await clonedRepo();
		await pushFromElsewhere(remote, { 'new.md': 'theirs\n' }, 'remote add');
		await commitFile(repo, 'new.md', 'ours\n');

		const result = await repo.pull({ author: AUTHOR });

		expect(result.status).toBe('conflict');
		expect(await repo.readText('new.md')).toContain('<<<<<<< main');
	});

	it('changes nothing when a merge is not possible', async () => {
		const { remote, repo } = await clonedRepo();
		await pushFromElsewhere(remote, { 'thing/inner.md': 'theirs\n' }, 'remote folder');
		const oid = await commitFile(repo, 'thing', 'ours\n');

		const error = await rejection(repo.pull({ author: AUTHOR }));

		expect(error.code).toBe(ErrorCode.MERGE_NOT_SUPPORTED);
		expect(await repo.readText('thing')).toBe('ours\n');
		expect((await repo.status()).clean).toBe(true);
		expect(await repo.getMergeState()).toBeNull();
		expect((await repo.aheadBehind()).ahead).toBe(1);
		expect(oid).toMatch(/^[0-9a-f]{40}$/);
	});

	it('keeps a conflict across a reload, with its stored theirs commit', async () => {
		const { remote, repo, fs } = await clonedRepo({ 'clash.md': 'line\n' });
		await pushFromElsewhere(remote, { 'clash.md': 'theirs\n' }, 'remote edit');
		await commitFile(repo, 'clash.md', 'ours\n');
		const pulled = await repo.pull({ author: AUTHOR });
		expect(pulled.status).toBe('conflict');

		const reloaded = openRepo(remote, { fs });

		const merge = await reloaded.getMergeState();
		expect(merge?.theirsOid).toBe(await remoteHead(remote));
		expect(merge?.conflictedPaths).toEqual(['clash.md']);
		const status = await reloaded.status();
		expect(status.clean).toBe(false);
		expect(status.merge).toEqual(merge);
		expect(status.files.map((file) => file.path)).toContain('clash.md');
		expect(await reloaded.readText('clash.md')).toContain('<<<<<<<');

		expect((await rejection(reloaded.pull({ author: AUTHOR }))).code).toBe(ErrorCode.MERGE_IN_PROGRESS);
		await reloaded.writeFile('clash.md', 'resolved\n');
		expect((await rejection(reloaded.commit({ paths: ['clash.md'], message: 'm', author: AUTHOR }))).code).toBe(
			ErrorCode.MERGE_IN_PROGRESS
		);
	});

	it('gives a binary conflict our exact bytes and no markers', async () => {
		const seed = Uint8Array.from([0, 1, 2, 200, 10]);
		const ours = Uint8Array.from([0, 9, 9, 201, 255, 10]);
		const theirs = Uint8Array.from([0, 7, 7, 202, 254, 10]);
		const { remote, repo } = await clonedRepo({ 'image.bin': seed, 'clash.md': 'line\n' });
		await pushFromElsewhere(remote, { 'image.bin': theirs, 'clash.md': 'theirs\n' }, 'remote edit');
		await repo.writeFile('image.bin', ours);
		await repo.writeFile('clash.md', 'ours\n');
		await repo.commit({ paths: ['image.bin', 'clash.md'], message: 'local edit', author: AUTHOR });

		const result = await repo.pull({ author: AUTHOR });

		expect(result.status).toBe('conflict');
		if (result.status !== 'conflict') return;
		expect(result.merge.conflictedPaths).toEqual(['clash.md', 'image.bin']);
		expect(result.merge.binaryPaths).toEqual(['image.bin']);
		expect([...(await repo.readFile('image.bin'))]).toEqual([...ours]);
		expect(await repo.readText('clash.md')).toContain('<<<<<<<');
	});

	it('treats a binary file changed on both sides as a conflict even when lines would merge', async () => {
		const seed = Buffer.from('\0a\nb\nc\nd\ne\n');
		const ours = Buffer.from('\0A\nb\nc\nd\ne\n');
		const theirs = Buffer.from('\0a\nb\nc\nd\nE\n');
		const { remote, repo } = await clonedRepo({ 'data.bin': seed });
		await pushFromElsewhere(remote, { 'data.bin': theirs }, 'remote edit');
		await repo.writeFile('data.bin', ours);
		await repo.commit({ paths: ['data.bin'], message: 'local edit', author: AUTHOR });

		const result = await repo.pull({ author: AUTHOR });

		expect(result.status).toBe('conflict');
		expect(Buffer.from(await repo.readFile('data.bin')).equals(ours)).toBe(true);
	});

	it('takes a stalled fetch off the lock: a save completes and the pull cancels', async () => {
		const remote = await createRemote({ 'a.md': 'seed\n' });
		const http = createGitHttp({ relayOrigin: RELAY_ORIGIN });
		let stalled = false;
		const repo = openRepo(remote, {
			http: {
				request: (request) =>
					stalled
						? new Promise((_resolve, reject) => {
								request.signal?.addEventListener('abort', () => reject(request.signal?.reason));
							})
						: http.request(request)
			}
		});
		await repo.clone({ url: remote.url });
		await pushFromElsewhere(remote, { 'a.md': 'remote\n' }, 'remote edit');
		stalled = true;
		const controller = new AbortController();

		const pulling = rejection(repo.pull({ author: AUTHOR, signal: controller.signal }));
		await repo.writeFile('draft.md', 'saved during the stall\n');
		expect(await repo.readText('draft.md')).toBe('saved during the stall\n');
		controller.abort(new Error('user left'));

		expect((await pulling).code).toBe(ErrorCode.CANCELLED);
		expect(await repo.readText('a.md')).toBe('seed\n');
		expect((await repo.aheadBehind()).behind).toBe(0);
	});

	it('refuses to merge over a draft saved during the fetch, and keeps what it fetched', async () => {
		const remote = await createRemote({ 'a.md': 'seed\n' });
		const http = createGitHttp({ relayOrigin: RELAY_ORIGIN });
		/** @type {null | (() => Promise<void>)} */
		let beforeRequest = null;
		const repo = openRepo(remote, {
			http: {
				request: async (request) => {
					const hook = beforeRequest;
					beforeRequest = null;
					await hook?.();
					return http.request(request);
				}
			}
		});
		await repo.clone({ url: remote.url });
		await pushFromElsewhere(remote, { 'a.md': 'remote\n' }, 'remote edit');
		beforeRequest = () => repo.writeFile('a.md', 'my draft\n');

		expect((await rejection(repo.pull({ author: AUTHOR }))).code).toBe(ErrorCode.DIRTY_TREE);

		expect(await repo.readText('a.md')).toBe('my draft\n');
		expect(await repo.aheadBehind()).toMatchObject({ ahead: 0, behind: 1 });
	});
});

describe('conflict state', () => {
	it('records what each side did, for text and binary files, in both delete directions', async () => {
		const bytes = Uint8Array.from([0, 255, 1, 10]);
		const { remote, repo } = await clonedRepo({ 'we-keep.md': 'base\n', 'we-keep.bin': bytes, 'they-keep.md': 'base\n', 'they-keep.bin': bytes });
		const theirText = 'theirs\n';
		const theirBytes = Uint8Array.from([0, 254, 2, 10]);
		await changeElsewhere(remote, { 'they-keep.md': theirText, 'they-keep.bin': theirBytes }, async (work) => {
			await runGit(['rm', '--quiet', 'we-keep.md', 'we-keep.bin'], work);
		});
		const ourBytes = Uint8Array.from([0, 253, 3, 10]);
		await repo.writeFile('we-keep.md', 'ours\n');
		await repo.writeFile('we-keep.bin', ourBytes);
		await repo.remove('they-keep.md');
		await repo.remove('they-keep.bin');
		await repo.commit({ paths: ['we-keep.md', 'we-keep.bin', 'they-keep.md', 'they-keep.bin'], message: 'local', author: AUTHOR });

		const result = await repo.pull({ author: AUTHOR });

		expect(result.status).toBe('conflict');
		if (result.status !== 'conflict') return;
		expect(result.merge.conflicts).toEqual([
			{ path: 'they-keep.bin', kind: 'deleted_by_us', binary: true },
			{ path: 'they-keep.md', kind: 'deleted_by_us', binary: false },
			{ path: 'we-keep.bin', kind: 'deleted_by_theirs', binary: true },
			{ path: 'we-keep.md', kind: 'deleted_by_theirs', binary: false }
		]);
		expect(result.merge.binaryPaths).toEqual(['they-keep.bin', 'we-keep.bin']);
		expect(await repo.readText('they-keep.md')).toBe(theirText);
		expect([...(await repo.readFile('they-keep.bin'))]).toEqual([...theirBytes]);
		expect(await repo.readText('we-keep.md')).toBe('ours\n');
		expect([...(await repo.readFile('we-keep.bin'))]).toEqual([...ourBytes]);
		expect((await repo.status()).files.map((file) => file.path)).toEqual(['they-keep.bin', 'they-keep.md', 'we-keep.bin', 'we-keep.md']);
	});

	it('saves the tree before the record calls the merge conflicted', async () => {
		const { repo, fs } = await divergedRepo({ 'calm.md': 'calm\n' }, { 'calm.md': 'remote\n', 'added.md': 'added\n' });
		const events = recordWrites(fs);

		expect((await repo.pull({ author: AUTHOR })).status).toBe('conflict');

		// The conflicted record is the last write to the merge state.
		const record = events.findLastIndex((event) => event.endsWith('gitnote-merge.json'));
		expect(events.slice(0, record).at(-1)).toBe('flush');
		expect(events.slice(record + 1)).toEqual(['flush']);
	});

	it('starts each marker on its own line in a note with no final newline', async () => {
		const { remote, repo } = await clonedRepo({ 'n.md': 'base' });
		await pushFromElsewhere(remote, { 'n.md': 'theirs' }, 'remote edit');
		await commitFile(repo, 'n.md', 'ours');

		await repo.pull({ author: AUTHOR });

		expect(await repo.readText('n.md')).toBe('<<<<<<< main\nours\n=======\ntheirs\n>>>>>>> origin/main\n');
	});
});

describe('completeMerge', () => {
	it('keeps every clean remote change alongside a conflict, read back with native git', async () => {
		const bytes = Uint8Array.from([0, 255, 1, 10]);
		const theirBytes = Uint8Array.from([0, 254, 2, 10]);
		const { remote, repo } = await divergedRepo(
			{ 'calm.md': 'calm\n', 'gone.md': 'gone\n', 'folder/only.md': 'only\n', 'pic.bin': bytes, 'same.bin': bytes, 'both.md': 'one\ntwo\nthree\nfour\n' },
			{ 'calm.md': 'calm remote\n', 'added.md': 'added\n', 'deep/er/new.md': 'new\n', 'pic.bin': theirBytes, 'both.md': 'ONE\ntwo\nthree\nfour\n' },
			async (work) => {
				await runGit(['rm', '--quiet', 'gone.md', 'folder/only.md'], work);
			}
		);
		await commitFile(repo, 'both.md', 'one\ntwo\nthree\nFOUR\n');
		await commitFile(repo, 'ours-only.md', 'ours only\n');
		const theirsOid = await remoteHead(remote);

		const pulled = await repo.pull({ author: AUTHOR });

		expect(pulled.status).toBe('conflict');
		expect((await repo.status()).files).toEqual([{ path: 'clash.md', change: 'modified' }]);
		const paths = (await repo.listTree()).map((entry) => entry.path);
		expect(paths).not.toContain('gone.md');
		expect(paths).not.toContain('folder/only.md');
		expect(await repo.readText('both.md')).toBe('ONE\ntwo\nthree\nFOUR\n');

		await repo.writeFile('clash.md', 'resolved\n');
		const { oid, parents } = await repo.completeMerge({ author: AUTHOR });

		expect(parents[1]).toBe(theirsOid);
		expect((await repo.status()).clean).toBe(true);
		expect(await repo.getMergeState()).toBeNull();
		expect(await repo.aheadBehind()).toMatchObject({ behind: 0 });
		expect(await pushedTree(remote, repo)).toEqual(['added.md', 'both.md', 'calm.md', 'clash.md', 'deep/er/new.md', 'ours-only.md', 'pic.bin', 'same.bin']);
		expect(await remoteHead(remote)).toBe(oid);
		expect((await runGit(['log', '-1', '--format=%P', 'main'], remote.bare)).trim().split(' ')).toEqual(parents);
		expect(await showRemote(remote, 'main:clash.md')).toBe('resolved\n');
		expect(await showRemote(remote, 'main:calm.md')).toBe('calm remote\n');
		expect(await showRemote(remote, 'main:both.md')).toBe('ONE\ntwo\nthree\nFOUR\n');
		expect(await showRemote(remote, 'main:deep/er/new.md')).toBe('new\n');
		expect(Buffer.from(await repo.readFile('pic.bin')).equals(Buffer.from(theirBytes))).toBe(true);
		expect(Buffer.from(await repo.readFile('same.bin')).equals(Buffer.from(bytes))).toBe(true);
		expect((await runGit(['rev-parse', 'main:pic.bin'], remote.bare)).trim()).toBe(await runGitHash(theirBytes));
	});

	it('keeps an executable remote file executable', async () => {
		const { remote, repo } = await divergedRepo({}, {}, async (work) => {
			await writeFile(path.join(work, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
			await runGit(['add', 'run.sh'], work);
		});

		await repo.pull({ author: AUTHOR });
		await repo.writeFile('clash.md', 'resolved\n');
		await repo.completeMerge({ author: AUTHOR });
		await repo.push();

		expect(await runGit(['ls-tree', 'main', 'run.sh'], remote.bare)).toMatch(/^100755 /);
	});

	it('keeps a remote symbolic link a link', async () => {
		const { remote, repo } = await divergedRepo({}, {}, async (work) => {
			await symlink('clash.md', path.join(work, 'link.md'));
			await runGit(['add', 'link.md'], work);
		});

		await repo.pull({ author: AUTHOR });
		await repo.writeFile('clash.md', 'resolved\n');
		await repo.completeMerge({ author: AUTHOR });
		await repo.push();

		expect(await runGit(['ls-tree', 'main', 'link.md'], remote.bare)).toMatch(/^120000 /);
	});

	it('keeps a remote mode change on a file we edited, as a merge with no conflict does', async () => {
		const { remote, repo } = await clonedRepo({ 'run.sh': '#!/bin/sh\necho hi\n', 'clash.md': 'line\n' });
		await changeElsewhere(remote, { 'clash.md': 'theirs\n' }, async (work) => {
			await chmod(path.join(work, 'run.sh'), 0o755);
			await runGit(['add', 'run.sh'], work);
		});
		await repo.writeFile('run.sh', '#!/bin/sh\necho ours\n');
		await repo.writeFile('clash.md', 'ours\n');
		await repo.commit({ paths: ['run.sh', 'clash.md'], message: 'local', author: AUTHOR });

		await repo.pull({ author: AUTHOR });
		await repo.writeFile('clash.md', 'resolved\n');
		await repo.completeMerge({ author: AUTHOR });
		await pushedTree(remote, repo);

		expect(await runGit(['ls-tree', 'main', 'run.sh'], remote.bare)).toMatch(/^100755 /);
		expect(await showRemote(remote, 'main:run.sh')).toBe('#!/bin/sh\necho ours\n');
	});

	it('keeps a remote edit on a file whose mode we changed', async () => {
		const { remote, repo, fs } = await clonedRepo({ 'run.sh': '#!/bin/sh\necho hi\n', 'clash.md': 'line\n' });
		await changeElsewhere(remote, { 'clash.md': 'theirs\n', 'run.sh': '#!/bin/sh\necho theirs\n' });
		await fs.promises.chmod?.('/repo/run.sh', 0o755);
		// The engine has no chmod of its own; only the index carries this change.
		await git.add({ fs, dir: '/repo', gitdir: '/repo/.git', filepath: 'run.sh' });
		await repo.writeFile('clash.md', 'ours\n');
		await repo.commit({ paths: ['clash.md'], message: 'local', author: AUTHOR });

		await repo.pull({ author: AUTHOR });
		await repo.writeFile('clash.md', 'resolved\n');
		await repo.completeMerge({ author: AUTHOR });
		await pushedTree(remote, repo);

		expect(await runGit(['ls-tree', 'main', 'run.sh'], remote.bare)).toMatch(/^100755 /);
		expect(await showRemote(remote, 'main:run.sh')).toBe('#!/bin/sh\necho theirs\n');
	});

	it('saves blobs before the index names them, and the commit before the branch moves', async () => {
		const { repo, fs } = await divergedRepo({}, {});
		await repo.pull({ author: AUTHOR });
		await repo.writeFile('clash.md', 'resolved\n');
		const events = recordWrites(fs);

		await repo.completeMerge({ author: AUTHOR });

		expect(events.some((event) => event.endsWith('/refs/heads/main'))).toBe(true);
		expectObjectsSavedBeforeNamed(events);
	});

	describe('conflicts with no markers', () => {
		const OURS = Uint8Array.from([0, 9, 9, 10]);
		const THEIRS = Uint8Array.from([0, 7, 7, 10]);

		/** @returns {ReturnType<typeof clonedRepo>} one binary conflict and one delete in each direction */
		async function markerlessConflicts() {
			const cloned = await clonedRepo({ 'b.bin': Uint8Array.from([0, 1, 10]), 'del.md': 'base\n', 'mod.md': 'base\n' });
			await changeElsewhere(cloned.remote, { 'b.bin': THEIRS, 'mod.md': 'theirs\n' }, async (work) => {
				await runGit(['rm', '--quiet', 'del.md'], work);
			});
			await cloned.repo.writeFile('b.bin', OURS);
			await cloned.repo.writeFile('del.md', 'ours\n');
			await cloned.repo.remove('mod.md');
			await cloned.repo.commit({ paths: ['b.bin', 'del.md', 'mod.md'], message: 'local', author: AUTHOR });
			expect((await cloned.repo.pull({ author: AUTHOR })).status).toBe('conflict');
			return cloned;
		}

		it('refuses until each is decided, naming the undecided ones', async () => {
			const { repo } = await markerlessConflicts();

			const error = await rejection(repo.completeMerge({ author: AUTHOR }));

			expect(error.code).toBe(ErrorCode.CONFLICTS_UNRESOLVED);
			expect(error.detail.paths).toEqual(['b.bin', 'del.md', 'mod.md']);
			expect(await repo.getMergeState()).not.toBeNull();
			expect((await rejection(repo.completeMerge({ author: AUTHOR, allowMarkers: true }))).code).toBe(ErrorCode.CONFLICTS_UNRESOLVED);
		});

		it('takes an explicit choice, even for the bytes already in place, across a reload', async () => {
			const { remote, repo, fs } = await markerlessConflicts();
			await repo.resolveConflict({ path: 'b.bin', side: 'ours' });
			await repo.resolveConflict({ path: 'del.md', side: 'ours' });

			const reloaded = openRepo(remote, { fs });
			expect((await reloaded.getMergeState())?.resolvedPaths).toEqual(['b.bin', 'del.md']);
			expect((await rejection(reloaded.completeMerge({ author: AUTHOR }))).detail.paths).toEqual(['mod.md']);

			await reloaded.resolveConflict({ path: 'mod.md', side: 'theirs' });
			await reloaded.completeMerge({ author: AUTHOR });
			expect(await pushedTree(remote, reloaded)).toEqual(['b.bin', 'del.md', 'mod.md']);
			expect((await runGit(['rev-parse', 'main:b.bin'], remote.bare)).trim()).toBe(await runGitHash(OURS));
		});

		it('counts an edit or a removal as a decision', async () => {
			const { remote, repo } = await markerlessConflicts();
			await repo.writeFile('b.bin', Uint8Array.from([0, 5, 10]));
			await repo.remove('del.md');
			await repo.remove('mod.md');

			await repo.completeMerge({ author: AUTHOR });

			expect(await pushedTree(remote, repo)).toEqual(['b.bin']);
		});

		it('takes the other side of a delete', async () => {
			const { remote, repo } = await markerlessConflicts();
			await repo.resolveConflict({ path: 'b.bin', side: 'theirs' });
			await repo.resolveConflict({ path: 'del.md', side: 'theirs' });
			await repo.resolveConflict({ path: 'mod.md', side: 'ours' });

			await repo.completeMerge({ author: AUTHOR });

			expect(await pushedTree(remote, repo)).toEqual(['b.bin']);
			expect((await runGit(['rev-parse', 'main:b.bin'], remote.bare)).trim()).toBe(await runGitHash(THEIRS));
		});
	});

	it('leaves an edit made during the merge uncommitted, and shows it', async () => {
		const { remote, repo } = await divergedRepo({ 'calm.md': 'calm\n', 'mine.md': 'mine\n' }, { 'calm.md': 'calm remote\n' });
		await repo.pull({ author: AUTHOR });
		await repo.writeFile('mine.md', 'edited during the merge\n');
		await repo.writeFile('calm.md', 'edited over the merge\n');
		await repo.writeFile('scratch.md', 'new\n');

		expect((await repo.status()).files).toEqual([
			{ path: 'calm.md', change: 'modified' },
			{ path: 'clash.md', change: 'modified' },
			{ path: 'mine.md', change: 'modified' },
			{ path: 'scratch.md', change: 'added' }
		]);

		await repo.writeFile('clash.md', 'resolved\n');
		await repo.completeMerge({ author: AUTHOR });

		expect((await repo.status()).files).toEqual([
			{ path: 'calm.md', change: 'modified' },
			{ path: 'mine.md', change: 'modified' },
			{ path: 'scratch.md', change: 'added' }
		]);
		await pushedTree(remote, repo);
		expect(await showRemote(remote, 'main:calm.md')).toBe('calm remote\n');
		expect(await showRemote(remote, 'main:mine.md')).toBe('mine\n');
	});

	it('refuses while markers remain, unless told they are the real content', async () => {
		const { remote, repo } = await divergedRepo({}, {});
		await repo.pull({ author: AUTHOR });

		const error = await rejection(repo.completeMerge({ author: AUTHOR }));

		expect(error.code).toBe(ErrorCode.CONFLICTS_UNRESOLVED);
		expect(error.detail.paths).toEqual(['clash.md']);
		expect(await repo.getMergeState()).not.toBeNull();

		await repo.completeMerge({ author: AUTHOR, allowMarkers: true });
		await pushedTree(remote, repo);
		expect(await showRemote(remote, 'main:clash.md')).toContain('<<<<<<<');
	});

	it('stages a conflicted file the user removed as a deletion', async () => {
		const { remote, repo } = await divergedRepo({ 'other.md': 'other\n' }, {});
		await repo.pull({ author: AUTHOR });
		await repo.remove('clash.md');

		expect((await repo.status()).files).toEqual([{ path: 'clash.md', change: 'deleted' }]);
		await repo.completeMerge({ author: AUTHOR, message: 'drop the clash' });

		expect(await pushedTree(remote, repo)).toEqual(['other.md']);
		expect((await runGit(['log', '-1', '--format=%s', 'main'], remote.bare)).trim()).toBe('drop the clash');
	});

	it('takes one side of a binary conflict with its exact bytes', async () => {
		const seed = Uint8Array.from([0, 1, 10]);
		const ours = Uint8Array.from([0, 2, 255, 10]);
		const theirs = Uint8Array.from([0, 3, 254, 10]);
		const { remote, repo } = await clonedRepo({ 'img.bin': seed });
		await pushFromElsewhere(remote, { 'img.bin': theirs }, 'remote');
		await repo.writeFile('img.bin', ours);
		await repo.commit({ paths: ['img.bin'], message: 'local', author: AUTHOR });
		await repo.pull({ author: AUTHOR });

		await repo.resolveConflict({ path: 'img.bin', side: 'theirs' });
		expect([...(await repo.readFile('img.bin'))]).toEqual([...theirs]);
		await repo.resolveConflict({ path: 'img.bin', side: 'ours' });
		expect([...(await repo.readFile('img.bin'))]).toEqual([...ours]);
		await repo.resolveConflict({ path: 'img.bin', side: 'theirs' });
		await repo.completeMerge({ author: AUTHOR });
		await repo.push();

		expect((await runGit(['rev-parse', 'main:img.bin'], remote.bare)).trim()).toBe(await runGitHash(theirs));
	});

	it('lets a side that deleted the file win', async () => {
		const { remote, repo } = await clonedRepo({ 'n.md': 'base\n', 'keep.md': 'keep\n' });
		await changeElsewhere(remote, {}, async (work) => {
			await runGit(['rm', '--quiet', 'n.md'], work);
		});
		await commitFile(repo, 'n.md', 'ours\n');
		await repo.pull({ author: AUTHOR });

		await repo.resolveConflict({ path: 'n.md', side: 'theirs' });
		await repo.completeMerge({ author: AUTHOR });

		expect((await repo.status()).clean).toBe(true);
		expect(await pushedTree(remote, repo)).toEqual(['keep.md']);
	});

	it('refuses to choose a side where no conflict is', async () => {
		const { repo } = await divergedRepo({ 'other.md': 'other\n' }, {});
		expect((await rejection(repo.resolveConflict({ path: 'clash.md', side: 'ours' }))).code).toBe(ErrorCode.NO_OPEN_MERGE);
		await repo.pull({ author: AUTHOR });
		expect((await rejection(repo.resolveConflict({ path: 'other.md', side: 'ours' }))).code).toBe(ErrorCode.INVALID_ARGUMENT);
	});

	it('answers plainly when no merge is open', async () => {
		const { repo } = await clonedRepo();
		expect((await rejection(repo.completeMerge({ author: AUTHOR }))).code).toBe(ErrorCode.NO_OPEN_MERGE);
		expect((await rejection(repo.abortMerge())).code).toBe(ErrorCode.NO_OPEN_MERGE);
	});

	it('closes the merge state when a closed tab left it after the merge commit', async () => {
		const { remote, repo, fs } = await divergedRepo({}, {});
		await repo.pull({ author: AUTHOR });
		const stored = await fs.promises.readFile('/repo/.git/gitnote-merge.json', { encoding: 'utf8' });
		await repo.writeFile('clash.md', 'resolved\n');
		const { oid } = await repo.completeMerge({ author: AUTHOR });
		await fs.promises.writeFile('/repo/.git/gitnote-merge.json', stored);

		const reloaded = openRepo(remote, { fs });

		expect(await reloaded.getMergeState()).toBeNull();
		expect((await reloaded.status()).clean).toBe(true);
		expect((await reloaded.push()).oid).toBe(oid);
	});
});

describe('abortMerge', () => {
	it('goes back to our commit, keeps other edits, and lets the next pull start over', async () => {
		const { remote, repo } = await divergedRepo(
			{ 'calm.md': 'calm\n', 'gone.md': 'gone\n', 'mine.md': 'mine\n' },
			{ 'calm.md': 'calm remote\n', 'fresh/new.md': 'new\n' },
			async (work) => {
				await runGit(['rm', '--quiet', 'gone.md'], work);
			}
		);
		const pulled = await repo.pull({ author: AUTHOR });
		await repo.writeFile('clash.md', 'half resolved\n');

		expect(await repo.abortMerge()).toEqual({ oid: pulled.oid });

		expect(await repo.getMergeState()).toBeNull();
		expect((await repo.status()).clean).toBe(true);
		expect(await repo.readText('clash.md')).toBe('ours\n');
		expect(await repo.readText('calm.md')).toBe('calm\n');
		expect(await repo.readText('gone.md')).toBe('gone\n');
		expect((await rejection(repo.readText('fresh/new.md'))).code).toBe(ErrorCode.PATH_NOT_FOUND);
		expect((await repo.listTree()).map((entry) => entry.path)).toEqual(['calm.md', 'clash.md', 'gone.md', 'mine.md']);
		expect((await rejection(repo.remove('fresh'))).code).toBe(ErrorCode.PATH_NOT_FOUND);
		expect(await repo.aheadBehind()).toMatchObject({ ahead: 1, behind: 1 });

		expect((await repo.pull({ author: AUTHOR })).status).toBe('conflict');
		await repo.writeFile('clash.md', 'resolved\n');
		await repo.completeMerge({ author: AUTHOR });
		expect(await pushedTree(remote, repo)).toEqual(['calm.md', 'clash.md', 'fresh/new.md', 'mine.md']);
	});

	it('keeps an edit to a file the merge did not touch', async () => {
		const { repo } = await divergedRepo({ 'mine.md': 'mine\n' }, {});
		await repo.pull({ author: AUTHOR });
		await repo.writeFile('mine.md', 'edited\n');

		await repo.abortMerge();

		expect((await repo.status()).files).toEqual([{ path: 'mine.md', change: 'modified' }]);
	});

	it('keeps a draft on a file only we committed', async () => {
		const { repo } = await divergedRepo({ 'mine.md': 'mine\n' }, {});
		await commitFile(repo, 'mine.md', 'mine committed\n');
		await repo.pull({ author: AUTHOR });
		await repo.writeFile('mine.md', 'DRAFT ON TOP\n');

		await repo.abortMerge();

		expect(await repo.readText('mine.md')).toBe('DRAFT ON TOP\n');
		expect((await repo.status()).files).toEqual([{ path: 'mine.md', change: 'modified' }]);
	});

	it('keeps a draft on a file only the remote changed, or only the remote has', async () => {
		const { repo } = await divergedRepo({ 'calm.md': 'calm\n' }, { 'calm.md': 'calm remote\n', 'fresh.md': 'fresh\n' });
		await repo.pull({ author: AUTHOR });
		await repo.writeFile('calm.md', 'DRAFT ON TOP\n');
		await repo.writeFile('fresh.md', 'ALSO A DRAFT\n');
		expect((await repo.status()).files.map((file) => file.path)).toEqual(['calm.md', 'clash.md', 'fresh.md']);

		await repo.abortMerge();

		expect(await repo.readText('calm.md')).toBe('DRAFT ON TOP\n');
		expect(await repo.readText('fresh.md')).toBe('ALSO A DRAFT\n');
		expect(await repo.readText('clash.md')).toBe('ours\n');
		expect((await repo.status()).files).toEqual([
			{ path: 'calm.md', change: 'modified' },
			{ path: 'fresh.md', change: 'added' }
		]);
	});

	it('still puts back a file the merge changed when nobody edited it', async () => {
		const { repo } = await divergedRepo({ 'calm.md': 'calm\n' }, { 'calm.md': 'calm remote\n' });
		await repo.pull({ author: AUTHOR });
		await repo.writeFile('scratch.md', 'draft\n');

		await repo.abortMerge();

		expect(await repo.readText('calm.md')).toBe('calm\n');
		expect((await repo.status()).files).toEqual([{ path: 'scratch.md', change: 'added' }]);
	});

	it('keeps drafts when the tab dies during the abort', async () => {
		const { remote, repo, fs } = await divergedRepo({ 'calm.md': 'calm\n', 'other.md': 'other\n' }, { 'calm.md': 'calm remote\n', 'other.md': 'other remote\n' });
		await repo.pull({ author: AUTHOR });
		await repo.writeFile('other.md', 'DRAFT ON TOP\n');
		let dead = false;
		const heal = failWrites(fs, (path) => {
			dead ||= path.endsWith('calm.md');
			return dead;
		});

		await rejection(repo.abortMerge());
		heal();
		const reloaded = openRepo(remote, { fs });

		expect(await reloaded.getMergeState()).toBeNull();
		expect(await reloaded.readText('other.md')).toBe('DRAFT ON TOP\n');
		expect(await reloaded.readText('calm.md')).toBe('calm\n');
		expect((await reloaded.status()).files).toEqual([{ path: 'other.md', change: 'modified' }]);
	});
});

describe('undoUnpushedCommits', () => {
	it('turns unpushed commits back into drafts, to commit and push in smaller groups', async () => {
		const { remote, repo } = await clonedRepo({ 'a.md': 'a\n', 'gone.md': 'gone\n' });
		const seed = await remoteHead(remote);
		await commitFile(repo, 'a.md', 'a2\n');
		await commitFile(repo, 'b.md', 'b\n');
		await repo.remove('gone.md');
		await repo.commit({ paths: ['gone.md'], message: 'drop', author: AUTHOR });
		await repo.writeFile('draft.md', 'draft\n');

		expect(await repo.undoUnpushedCommits()).toEqual({ oid: seed, undone: 3 });

		expect(await repo.aheadBehind()).toMatchObject({ ahead: 0, behind: 0 });
		expect(await repo.readText('a.md')).toBe('a2\n');
		expect((await repo.status()).files).toEqual([
			{ path: 'a.md', change: 'modified' },
			{ path: 'b.md', change: 'added' },
			{ path: 'draft.md', change: 'added' },
			{ path: 'gone.md', change: 'deleted' }
		]);

		await repo.commit({ paths: ['a.md'], message: 'only a', author: AUTHOR });
		await repo.push();
		expect(await showRemote(remote, 'main:a.md')).toBe('a2\n');
		expect((await runGit(['ls-tree', '-r', '--name-only', 'main'], remote.bare)).trim().split('\n')).toEqual(['a.md', 'gone.md']);
		expect((await repo.status()).files.map((file) => file.path)).toEqual(['b.md', 'draft.md', 'gone.md']);
	});

	it('has nothing to do when everything is pushed', async () => {
		const { remote, repo } = await clonedRepo();
		expect(await repo.undoUnpushedCommits()).toEqual({ oid: await remoteHead(remote), undone: 0 });
	});

	it('refuses while the remote has commits we lack, which would look like deletions', async () => {
		const { repo } = await divergedRepo({}, {});
		await repo.pull({ author: AUTHOR });
		const { oid } = await repo.abortMerge();
		expect(await repo.aheadBehind()).toMatchObject({ ahead: 1, behind: 1 });

		expect((await rejection(repo.undoUnpushedCommits())).code).toBe(ErrorCode.NON_FAST_FORWARD);

		expect(await repo.aheadBehind()).toMatchObject({ ahead: 1, behind: 1 });
		expect(await repo.readText('clash.md')).toBe('ours\n');
		expect(oid).toMatch(/^[0-9a-f]{40}$/);
	});

	it('undoes a merge commit too, and the remote work it brought stays', async () => {
		const { remote, repo } = await clonedRepo({ 'a.md': 'a\n' });
		await pushFromElsewhere(remote, { 'remote.md': 'r\n' }, 'remote');
		await commitFile(repo, 'a.md', 'a2\n');
		expect((await repo.pull({ author: AUTHOR })).status).toBe('merged');

		expect((await repo.undoUnpushedCommits()).undone).toBe(2);

		expect(await repo.readText('remote.md')).toBe('r\n');
		expect((await repo.status()).files).toEqual([{ path: 'a.md', change: 'modified' }]);
		expect(await repo.aheadBehind()).toMatchObject({ ahead: 0, behind: 0 });
	});

	it('refuses during a merge', async () => {
		const { repo } = await divergedRepo({}, {});
		await repo.pull({ author: AUTHOR });
		expect((await rejection(repo.undoUnpushedCommits())).code).toBe(ErrorCode.MERGE_IN_PROGRESS);
	});
});

describe('a pull that fails partway', () => {
	/**
	 * @param {import('./repo.js').Repo} repo
	 * @param {Record<string, string>} content what the tree must hold
	 */
	async function expectUndone(repo, content) {
		expect(await repo.getMergeState()).toBeNull();
		expect((await repo.status()).clean).toBe(true);
		for (const [path, text] of Object.entries(content)) expect(await repo.readText(path)).toBe(text);
	}

	it('refuses before moving anything when the remote now tracks an ignored local file', async () => {
		const { remote, repo } = await clonedRepo({ '.gitignore': 'drafts/\n', 'a.md': 'old\n' });
		await repo.writeFile('drafts/x.md', 'my private draft\n');
		await pushFromElsewhere(remote, { '.gitignore': '', 'a.md': 'new\n', 'drafts/x.md': 'theirs\n' }, 'remote adds it');

		const error = await rejection(repo.pull({ author: AUTHOR }));

		expect(error.code).toBe(ErrorCode.CHECKOUT_CONFLICT);
		expect(error.detail.files).toEqual(['drafts/x.md']);
		expect(await repo.readText('drafts/x.md')).toBe('my private draft\n');
		await expectUndone(repo, { 'a.md': 'old\n' });
		expect(await repo.aheadBehind()).toMatchObject({ ahead: 0, behind: 1 });
	});

	it('does the same on the way to a conflict, which would overwrite without asking', async () => {
		const { remote, repo } = await divergedRepo({ '.gitignore': 'drafts/\n' }, {});
		await repo.writeFile('drafts/x.md', 'my private draft\n');
		await pushFromElsewhere(remote, { '.gitignore': '', 'drafts/x.md': 'theirs\n' }, 'remote adds it');

		expect((await rejection(repo.pull({ author: AUTHOR }))).code).toBe(ErrorCode.CHECKOUT_CONFLICT);
		expect(await repo.readText('drafts/x.md')).toBe('my private draft\n');
		await expectUndone(repo, { 'clash.md': 'ours\n' });
	});

	it('puts the branch back when a fast-forward checkout runs out of space, then retries', async () => {
		const { remote, repo, fs } = await clonedRepo({ 'a.md': 'old\n', 'z.md': 'keep\n' });
		await pushFromElsewhere(remote, { 'a.md': 'new\n', 'z-new.md': 'new\n' }, 'remote edit');
		const heal = failWrites(fs, (path) => path.endsWith('z-new.md'));

		await rejection(repo.pull({ author: AUTHOR }));
		heal();

		await expectUndone(repo, { 'a.md': 'old\n', 'z.md': 'keep\n' });
		expect((await repo.listTree()).map((entry) => entry.path)).toEqual(['a.md', 'z.md']);
		expect(await repo.aheadBehind()).toMatchObject({ ahead: 0, behind: 1 });

		expect((await repo.pull({ author: AUTHOR })).status).toBe('fast_forward');
		expect(await repo.readText('z-new.md')).toBe('new\n');
		expect((await repo.status()).clean).toBe(true);
	});

	it('puts the branch back when a clean merge checkout fails', async () => {
		const { remote, repo, fs } = await clonedRepo({ 'a.md': 'old\n' });
		await pushFromElsewhere(remote, { 'b-remote.md': 'r\n' }, 'remote');
		const ours = await commitFile(repo, 'local.md', 'l\n');
		const heal = failWrites(fs, (path) => path.endsWith('b-remote.md'));

		await rejection(repo.pull({ author: AUTHOR }));
		heal();

		expect(await git.resolveRef({ fs, gitdir: '/repo/.git', ref: 'HEAD' })).toBe(ours);
		await expectUndone(repo, { 'a.md': 'old\n', 'local.md': 'l\n' });
		expect((await repo.pull({ author: AUTHOR })).status).toBe('merged');
	});

	it('undoes a conflict whose record could not be written, so no marker becomes a commit', async () => {
		const { repo, remote, fs } = await divergedRepo({ 'calm.md': 'calm\n' }, { 'calm.md': 'remote\n', 'added.md': 'added\n' });
		const heal = failWrites(fs, (path, data) => path.endsWith('gitnote-merge.json') && String(data).includes('"conflicted"'));

		await rejection(repo.pull({ author: AUTHOR }));
		heal();

		await expectUndone(repo, { 'clash.md': 'ours\n', 'calm.md': 'calm\n' });
		expect((await repo.listTree()).map((entry) => entry.path)).toEqual(['calm.md', 'clash.md']);
		const again = await repo.pull({ author: AUTHOR });
		expect(again.status).toBe('conflict');
		await repo.writeFile('clash.md', 'resolved\n');
		await repo.completeMerge({ author: AUTHOR });
		expect(await pushedTree(remote, repo)).toEqual(['added.md', 'calm.md', 'clash.md']);
	});

	it('finishes undoing on the next operation when the tab died mid-pull', async () => {
		const { remote, repo, fs } = await clonedRepo({ 'a.md': 'old\n', 'b.md': 'b\n' });
		await pushFromElsewhere(remote, { 'a.md': 'new\n', 'c.md': 'new\n' }, 'remote edit');
		// From the first new file on nothing can be written, as if the tab had
		// gone, so the rollback cannot run either.
		let dead = false;
		const heal = failWrites(fs, (path) => {
			dead ||= path.endsWith('c.md');
			return dead;
		});

		await rejection(repo.pull({ author: AUTHOR }));
		heal();
		const stored = await fs.promises.readFile('/repo/.git/gitnote-merge.json', { encoding: 'utf8' });
		expect(JSON.parse(stored).phase).toBe('applying');

		const reloaded = openRepo(remote, { fs });

		await expectUndone(reloaded, { 'a.md': 'old\n', 'b.md': 'b\n' });
		expect(await reloaded.aheadBehind()).toMatchObject({ ahead: 0, behind: 1 });
		expect((await reloaded.pull({ author: AUTHOR })).status).toBe('fast_forward');
		expect(await reloaded.readText('c.md')).toBe('new\n');
	});
});

describe('size limits', () => {
	it('warns about a 60 MB file and still commits it', async () => {
		const { repo } = await clonedRepo();
		await repo.writeFile('big.bin', new Uint8Array(60 * MB).fill(97));

		const checked = await repo.checkCommit(['big.bin']);
		const result = await repo.commit({ paths: ['big.bin'], message: 'big', author: AUTHOR });

		expect(checked).toHaveLength(1);
		expect(checked[0].level).toBe('warn');
		expect(result.warnings).toEqual(checked);
		expect(result.warnings[0].message).toContain('50.0 MB');
	}, 60_000);

	it('warns when a commit takes the unpushed total past what one push can send', async () => {
		const { repo } = await clonedRepo();
		await repo.writeFile('one.bin', new Uint8Array(60 * MB).fill(97));
		await repo.commit({ paths: ['one.bin'], message: 'one', author: AUTHOR });
		await repo.writeFile('two.bin', new Uint8Array(40 * MB).fill(98));

		const checked = await repo.checkCommit(['two.bin']);

		expect(checked).toHaveLength(1);
		expect(checked[0]).toMatchObject({ level: 'warn', size: 100 * MB, limit: 95 * MB });
		expect(checked[0].message).toContain('unpushed commits');
		expect((await repo.commit({ paths: ['two.bin'], message: 'two', author: AUTHOR })).warnings).toEqual(checked);
	}, 120_000);

	it('says a file over the relay cap cannot be pushed, once, and undo gets past it', async () => {
		const { remote, repo } = await clonedRepo();
		await repo.writeFile('big.bin', new Uint8Array(96 * MB).fill(97));

		const { warnings } = await repo.commit({ paths: ['big.bin'], message: 'big', author: AUTHOR });

		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toContain('cannot be pushed through the relay');
		const refused = await rejection(repo.push());
		expect(refused.code).toBe(ErrorCode.PUSH_TOO_LARGE);
		expect(refused.message).toContain('Undo the unpushed commits');

		await repo.undoUnpushedCommits();
		await commitFile(repo, 'small.md', 'small\n');
		expect((await repo.push()).pushed).toBe(true);
		expect(await showRemote(remote, 'main:small.md')).toBe('small\n');
		expect((await repo.status()).files).toEqual([{ path: 'big.bin', change: 'added' }]);
	}, 120_000);

	it('blocks a 120 MB file on GitHub rules before staging anything', async () => {
		const { repo } = await clonedRepo();
		await repo.writeFile('huge.bin', new Uint8Array(120 * MB).fill(97));

		const error = await rejection(repo.commit({ paths: ['huge.bin'], message: 'huge', author: AUTHOR }));

		expect(error.code).toBe(ErrorCode.FILE_TOO_LARGE);
		expect(error.message).toContain('104.9 MB');
		expect(await repo.aheadBehind()).toMatchObject({ ahead: 0 });
		expect((await repo.status()).files).toEqual([{ path: 'huge.bin', change: 'added' }]);
	}, 60_000);

	it('blocks an estimated 120 MB push before any request', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const counted = countingHttp();
		const repo = openRepo(remote, { http: counted.http });
		await repo.clone({ url: remote.url });
		await repo.writeFile('one.bin', new Uint8Array(60 * MB).fill(97));
		await repo.commit({ paths: ['one.bin'], message: 'one', author: AUTHOR });
		await repo.writeFile('two.bin', new Uint8Array(60 * MB).fill(98));
		await repo.commit({ paths: ['two.bin'], message: 'two', author: AUTHOR });
		const before = counted.requests();

		expect(await repo.estimatePushBytes()).toBe(120 * MB);
		const error = await rejection(repo.push());

		expect(error.code).toBe(ErrorCode.PUSH_TOO_LARGE);
		expect(error.message).toContain('95.0 MB');
		expect(counted.requests()).toBe(before);
	}, 120_000);

	it('counts each new blob once and ignores what the remote has', async () => {
		const { repo } = await clonedRepo({ 'old.md': 'x'.repeat(1000) });
		expect(await repo.estimatePushBytes()).toBe(0);
		await commitFile(repo, 'a.md', 'aaaa');
		await commitFile(repo, 'copy.md', 'aaaa');
		await commitFile(repo, 'a.md', 'bbbbbb');
		expect(await repo.estimatePushBytes()).toBe(4 + 6);
	});

	it('counts only the local blobs after a merge, not the shallow boundary', async () => {
		const { remote, repo } = await clonedRepo({ 'seed.bin': new Uint8Array(MB).fill(97) });
		await pushFromElsewhere(remote, { 'remote.md': 'remote\n' }, 'remote');
		await commitFile(repo, 'local.md', 'local\n');

		expect((await repo.pull({ author: AUTHOR })).status).toBe('merged');

		expect(await repo.aheadBehind()).toMatchObject({ ahead: 2, behind: 0 });
		expect(await repo.estimatePushBytes()).toBe('local\n'.length);
		expect((await repo.push()).bytes).toBe('local\n'.length);
	});

	it('does the same after a conflict is resolved', async () => {
		const { remote, repo } = await divergedRepo({ 'seed.bin': new Uint8Array(MB).fill(97) }, { 'remote.md': 'remote\n' });
		await repo.pull({ author: AUTHOR });
		await repo.writeFile('clash.md', 'resolved\n');
		await repo.completeMerge({ author: AUTHOR });

		expect(await repo.aheadBehind()).toMatchObject({ ahead: 2, behind: 0 });
		expect(await repo.estimatePushBytes()).toBe('ours\n'.length + 'resolved\n'.length);
		expect(await pushedTree(remote, repo)).toEqual(['clash.md', 'remote.md', 'seed.bin']);
	});

	it('keeps counting correctly over several merges', async () => {
		const { remote, repo } = await clonedRepo({ 'seed.bin': new Uint8Array(MB).fill(97) });
		for (const round of [1, 2]) {
			await pushFromElsewhere(remote, { [`remote-${round}.md`]: 'r\n' }, `remote ${round}`);
			await commitFile(repo, `local-${round}.md`, 'll\n');
			await repo.pull({ author: AUTHOR });
		}
		// Two local commits and two merge commits, none of them pushed.
		expect(await repo.aheadBehind()).toMatchObject({ ahead: 4, behind: 0 });
		expect(await repo.estimatePushBytes()).toBe(3);
	});
});
