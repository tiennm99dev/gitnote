import { memfs } from 'memfs';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_CREDENTIAL } from '../../../test/git-http-server.js';
import { createRemote, pushFromElsewhere, rejectPushes, RELAY_PORT, remoteHead, runGit, showRemote } from '../../../test/remote-repo.js';
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

		expect(events).toEqual(['flush-start', 'flush-end', 'resolved']);
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
		expect((await repo.aheadBehind()).behind).toBe(0);

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
});
