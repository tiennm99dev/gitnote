import { symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { memfs } from 'memfs';
import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryDraftStore } from '../../../test/draft-doubles.js';
import { FIXTURE_CREDENTIAL } from '../../../test/git-http-server.js';
import { changeElsewhere, createRemote, pushFromElsewhere, rejectPushes, RELAY_PORT, remoteHead, runGit, showRemote } from '../../../test/remote-repo.js';
import { ErrorCode, networkError } from '../git/errors.js';
import { createGitHttp } from '../git/http.js';
import { syncRecordKey } from '../git/local-repos.js';
import { createRepo } from '../git/repo.js';
import { createNotes } from '../stores/notes.js';
import { commitMessageFor, createSync } from './sync.js';

const AUTHOR = { name: 'Local Author', email: 'local@example.com' };
const MB = 1_000_000;

/**
 * @returns {Storage}
 */
function memoryStorage() {
	const items = new Map();
	return /** @type {Storage} */ (
		/** @type {unknown} */ ({
			getItem: (/** @type {string} */ key) => items.get(key) ?? null,
			setItem: (/** @type {string} */ key, /** @type {string} */ value) => void items.set(key, value)
		})
	);
}

/**
 * Every sync a test opened, whose push retries must not outlive it.
 * @type {Array<{ stop: () => void }>}
 */
const opened = [];

afterEach(() => {
	for (const sync of opened.splice(0)) sync.stop();
});

// The result's shape is inferred, and the tests read it by name.
// eslint-disable-next-line jsdoc/require-returns
/**
 * A real clone on its own memory file system, behind the store the screen uses.
 * @param {import('../../../test/remote-repo.js').Remote} remote
 * @param {{ storage?: Storage, author?: typeof AUTHOR | null, retry?: { isVisible?: () => boolean, sendQueuedPush?: () => Promise<unknown>, pushRetryDelaysMs?: number[] } }} [options]
 */
async function openDevice(remote, { storage = memoryStorage(), author = AUTHOR, retry = {} } = {}) {
	const fs = /** @type {import('../git/repo.js').FsClient} */ (/** @type {unknown} */ (memfs().fs));
	const repo = createRepo({ id: remote.id, fs, http: createGitHttp({ relayOrigin: `http://127.0.0.1:${RELAY_PORT}` }), provider: 'github', getCredential: () => FIXTURE_CREDENTIAL });
	await repo.clone({ url: remote.url });
	const network = { online: true };
	const notes = createNotes({ repoId: remote.id, provider: 'github', repo, drafts: memoryDraftStore() });
	const options = { repoId: remote.id, repo, notes, storage, isOnline: () => network.online, getAuthor: () => author, ...retry };
	const start = () => {
		const sync = createSync(options);
		opened.push(sync);
		return sync;
	};
	return { repo, fs, notes, network, storage, sync: start(), reopen: start };
}

// The result's shape is inferred, and the tests read it by name.
// eslint-disable-next-line jsdoc/require-returns
/**
 * @param {Record<string, string>} [files]
 */
async function setUp(files = { 'a.md': 'one\n', 'b.md': 'two\n' }) {
	const remote = await createRemote(files);
	return { remote, ...(await openDevice(remote)) };
}

// The result's shape is inferred, and the tests read it by name.
// eslint-disable-next-line jsdoc/require-returns
/**
 * A device whose pull opened a merge on `a.md`.
 */
async function setUpConflict() {
	const context = await setUp();
	const { repo, sync, remote } = context;
	await repo.writeFile('a.md', 'mine\n');
	await sync.commit({ paths: ['a.md'], message: 'mine' });
	await pushFromElsewhere(remote, { 'a.md': 'theirs\n', 'c.md': 'new\n' }, 'theirs');
	const pulled = await sync.pull();
	expect(pulled).toMatchObject({ ok: true, status: 'conflict' });
	return context;
}

describe('refresh', () => {
	it('reads the changes and the counts', async () => {
		const { repo, sync } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await sync.refresh();
		expect(get(sync)).toMatchObject({ loaded: true, files: [{ path: 'a.md', change: 'modified' }], branch: 'main', ahead: 0, behind: 0, hasRemote: true, merge: null });
	});
});

describe('commit', () => {
	it('commits only the selected paths, and counts them as unpushed', async () => {
		const { repo, sync } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await repo.writeFile('b.md', 'edited\n');
		expect(await sync.commit({ paths: ['a.md'], message: 'just a' })).toMatchObject({ ok: true, warnings: [] });
		expect(get(sync)).toMatchObject({ ahead: 1, files: [{ path: 'b.md' }], report: null });
	});

	it('asks for an author rather than failing when none is known', async () => {
		const remote = await createRemote({ 'a.md': 'one\n' });
		const { repo, sync } = await openDevice(remote, { author: null });
		await repo.writeFile('a.md', 'edited\n');
		expect((await sync.commit({ paths: ['a.md'], message: 'x' })).ok).toBe(false);
		expect(get(sync).needsAuthor).toBe(true);
		await sync.refresh();
		expect(get(sync).ahead).toBe(0);
	});

	it('does not call a commit another tab already made a failure', async () => {
		const { sync } = await setUp();
		expect(await sync.commit({ paths: ['a.md'], message: 'x' })).toMatchObject({ ok: false, code: ErrorCode.NOTHING_TO_COMMIT });
		expect(get(sync).report).toBeNull();
	});

	it('reports a commit the engine refuses', async () => {
		const { repo, sync } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		expect((await sync.commit({ paths: ['a.md'], message: '   ' })).ok).toBe(false);
		expect(get(sync).report?.code).toBe(ErrorCode.INVALID_ARGUMENT);
	});
});

describe('commitMessageFor', () => {
	it('names up to three paths', () => {
		expect(commitMessageFor(['a.md'])).toBe('Update a.md');
		expect(commitMessageFor(['a', 'b', 'c'])).toBe('Update a, b, c');
		expect(commitMessageFor(['a', 'b', 'c', 'd', 'e'])).toBe('Update a, b, c and 2 more');
	});
});

describe('pull', () => {
	it('brings in remote commits, updates the open note, and records the time', async () => {
		const { sync, notes, remote } = await setUp();
		await notes.open('a.md');
		await pushFromElsewhere(remote, { 'a.md': 'from elsewhere\n' }, 'remote');
		expect(await sync.pull()).toEqual({ ok: true, status: 'fast_forward' });
		expect(get(notes).note?.text).toBe('from elsewhere\n');
		expect(get(sync).lastSyncAt).not.toBeNull();
	});

	it('does not count a pull that opened a merge as a sync, until the merge is pushed', async () => {
		const { repo, sync } = await setUpConflict();
		expect(get(sync).lastSyncAt).toBeNull();
		await repo.writeFile('a.md', 'both\n');
		await sync.completeMerge({ allowMarkers: false });
		expect(get(sync).lastSyncAt).toBeNull();
		await sync.push();
		expect(get(sync).lastSyncAt).not.toBeNull();
	});

	it('holds back on local changes, without touching them, and shows how far behind', async () => {
		const { repo, sync, remote } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await pushFromElsewhere(remote, { 'c.md': 'new\n' }, 'remote');
		expect(await sync.pull()).toEqual({ ok: false, code: ErrorCode.DIRTY_TREE });
		expect(get(sync)).toMatchObject({ pullHeldBack: true, behind: 1, report: null });
		expect(await repo.readText('a.md')).toBe('edited\n');
	});

	it('stops holding back once the changes are discarded, and pulls', async () => {
		const { repo, sync, remote } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await pushFromElsewhere(remote, { 'c.md': 'new\n' }, 'remote');
		await sync.pull();
		await sync.discard(['a.md']);
		expect(get(sync).pullHeldBack).toBe(false);
		expect((await sync.pull()).ok).toBe(true);
		expect(await repo.readText('c.md')).toBe('new\n');
	});

	it('keeps a draft through a pull that changes its file, and lets the user choose', async () => {
		const { sync, notes, remote } = await setUp();
		await notes.open('a.md');
		notes.edit('unsaved\n');
		await notes.flushDrafts();
		await pushFromElsewhere(remote, { 'a.md': 'from elsewhere\n' }, 'remote');
		expect((await sync.pull()).ok).toBe(true);
		expect(get(notes).note).toMatchObject({ text: 'unsaved\n', dirty: true, diskChanged: true });
		expect(get(notes).draftPaths).toEqual(['a.md']);
	});

	it('says so when offline, and sends nothing', async () => {
		const { sync, network, repo } = await setUp();
		const pull = vi.spyOn(repo, 'pull');
		network.online = false;
		expect(await sync.pull()).toEqual({ ok: false, code: 'offline' });
		expect(get(sync).report?.code).toBe('offline');
		expect(pull).not.toHaveBeenCalled();
	});

	it('says the remote branch has gone, naming it, and changes nothing here', async () => {
		const { repo, sync, remote } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await sync.commit({ paths: ['a.md'], message: 'mine' });
		await runGit(['update-ref', '-d', 'refs/heads/main'], remote.bare);
		expect(await sync.pull()).toEqual({ ok: false, code: ErrorCode.BRANCH_NOT_FOUND });
		expect(get(sync).report).toMatchObject({ code: ErrorCode.BRANCH_NOT_FOUND, message: expect.stringContaining('main is no longer on the remote') });
		expect(get(sync).ahead).toBe(1);
	});

	it('asks for an author it needs for a merge, and has still fetched', async () => {
		const remote = await createRemote({ 'a.md': 'one\n' });
		const { repo, sync } = await openDevice(remote, { author: null });
		await repo.writeFile('a.md', 'mine\n');
		await repo.commit({ paths: ['a.md'], message: 'mine', author: AUTHOR });
		await pushFromElsewhere(remote, { 'c.md': 'new\n' }, 'theirs');
		expect(await sync.pull()).toEqual({ ok: false, code: ErrorCode.INVALID_ARGUMENT });
		expect(get(sync)).toMatchObject({ needsAuthor: true, behind: 1, ahead: 1, merge: null, report: null });
	});

	it('pulls with no author when nothing needs merging', async () => {
		const remote = await createRemote({ 'a.md': 'one\n' });
		const { repo, sync } = await openDevice(remote, { author: null });
		await pushFromElsewhere(remote, { 'c.md': 'new\n' }, 'theirs');
		await sync.open();
		expect(get(sync)).toMatchObject({ needsAuthor: false, behind: 0, report: null });
		expect(await repo.readText('c.md')).toBe('new\n');
	});
});

describe('open', () => {
	it('pulls when online', async () => {
		const { repo, sync, remote } = await setUp();
		await pushFromElsewhere(remote, { 'c.md': 'new\n' }, 'remote');
		await sync.open();
		expect(await repo.readText('c.md')).toBe('new\n');
	});

	it('reports nothing when offline, or when the network fails', async () => {
		const { sync, network, repo } = await setUp();
		network.online = false;
		await sync.open();
		expect(get(sync).report).toBeNull();

		network.online = true;
		vi.spyOn(repo, 'pull').mockRejectedValueOnce(networkError(new TypeError('down')));
		await sync.open();
		expect(get(sync).report).toBeNull();
	});

	it('prompts instead of pulling over local changes', async () => {
		const { repo, sync } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await sync.open();
		expect(get(sync).pullHeldBack).toBe(true);
	});

	it('resumes an open merge from its record after a reload, without pulling', async () => {
		const { repo, reopen } = await setUpConflict();
		const pull = vi.spyOn(repo, 'pull');
		const reloaded = reopen();
		await reloaded.open();
		expect(pull).not.toHaveBeenCalled();
		expect(get(reloaded)).toMatchObject({ merge: { conflictedPaths: ['a.md'] }, conflicts: [{ path: 'a.md', hasMarkers: true }] });
	});

	it('sends a push queued before the reload', async () => {
		const { repo, sync, remote, network, reopen } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await sync.commit({ paths: ['a.md'], message: 'x' });
		network.online = false;
		await sync.push();
		expect(get(sync).pushPending).toBe(true);

		network.online = true;
		const reloaded = reopen();
		expect(get(reloaded).pushPending).toBe(true);
		await reloaded.open();
		expect(get(reloaded)).toMatchObject({ pushPending: false, ahead: 0 });
		expect(await showRemote(remote, 'main:a.md')).toBe('edited\n');
	});
});

describe('push', () => {
	it('sends the commits and clears the count', async () => {
		const { repo, sync, remote } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await sync.commit({ paths: ['a.md'], message: 'x' });
		expect(await sync.push()).toEqual({ ok: true, queued: false });
		expect(get(sync)).toMatchObject({ ahead: 0, pushPending: false });
		expect(get(sync).lastSyncAt).not.toBeNull();
		expect(await showRemote(remote, 'main:a.md')).toBe('edited\n');
	});

	it('queues when offline and goes when told the network is back', async () => {
		const { repo, sync, remote, network } = await setUp();
		const head = await remoteHead(remote);
		await repo.writeFile('a.md', 'edited\n');
		await sync.commit({ paths: ['a.md'], message: 'x' });
		network.online = false;
		expect(await sync.push()).toMatchObject({ ok: false, queued: true });
		expect(get(sync).pushPending).toBe(true);
		expect(await remoteHead(remote)).toBe(head);

		await sync.pushIfPending();
		expect(await remoteHead(remote)).toBe(head);

		network.online = true;
		await sync.pushIfPending();
		expect(get(sync).pushPending).toBe(false);
		expect(await showRemote(remote, 'main:a.md')).toBe('edited\n');
	});

	it('queues after a connection failure, which the online flag would not have warned of', async () => {
		const { repo, sync } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await sync.commit({ paths: ['a.md'], message: 'x' });
		vi.spyOn(repo, 'push').mockRejectedValueOnce(networkError(new TypeError('down')));
		expect(await sync.push()).toMatchObject({ ok: false, queued: true, code: ErrorCode.NETWORK });
		expect(get(sync).pushPending).toBe(true);
	});

	describe('after a connection failure with the device online', () => {
		const down = () => networkError(new TypeError('down'));

		/**
		 * @param {{ isVisible?: () => boolean, sendQueuedPush?: () => Promise<unknown> }} retry
		 * @returns {Promise<Awaited<ReturnType<typeof openDevice>> & { remote: import('../../../test/remote-repo.js').Remote }>}
		 */
		const deviceWithCommit = async (retry) => {
			const remote = await createRemote({ 'a.md': 'one\n' });
			const device = await openDevice(remote, { retry: { pushRetryDelaysMs: [5], ...retry } });
			await device.repo.writeFile('a.md', 'edited\n');
			await device.sync.commit({ paths: ['a.md'], message: 'x' });
			return { ...device, remote };
		};

		it('tries again by itself, repeatedly, until the push goes', async () => {
			const { repo, sync, remote } = await deviceWithCommit({});
			const push = vi.spyOn(repo, 'push').mockRejectedValueOnce(down()).mockRejectedValueOnce(down());
			await sync.push();
			expect(get(sync).pushPending).toBe(true);
			await vi.waitFor(() => expect(get(sync)).toMatchObject({ pushPending: false, ahead: 0, report: null }), { timeout: 10_000 });
			expect(push).toHaveBeenCalledTimes(3);
			expect(await showRemote(remote, 'main:a.md')).toBe('edited\n');
		});

		it('leaves a hidden page alone, and its return sends the push', async () => {
			const page = { visible: false };
			const { repo, sync } = await deviceWithCommit({ isVisible: () => page.visible });
			const push = vi.spyOn(repo, 'push').mockRejectedValueOnce(down());
			await sync.push();
			await new Promise((done) => setTimeout(done, 30));
			expect(push).toHaveBeenCalledTimes(1);
			page.visible = true;
			await sync.pushIfPending();
			expect(get(sync).pushPending).toBe(false);
		});

		it('sends the retry through whatever owns the queued push', async () => {
			const sendQueuedPush = vi.fn(async () => undefined);
			const { repo, sync } = await deviceWithCommit({ sendQueuedPush });
			const push = vi.spyOn(repo, 'push').mockRejectedValueOnce(down());
			await sync.push();
			await vi.waitFor(() => expect(sendQueuedPush).toHaveBeenCalled(), { timeout: 10_000 });
			expect(push).toHaveBeenCalledTimes(1);
		});

		it('keeps trying when the owner only got as far as a failed pull', async () => {
			/** @type {() => Promise<unknown>} */
			let owner = async () => undefined;
			const { repo, sync } = await deviceWithCommit({ sendQueuedPush: () => owner() });
			owner = () => sync.pull();
			vi.spyOn(repo, 'push').mockRejectedValueOnce(down());
			const pull = vi.spyOn(repo, 'pull').mockRejectedValue(down());
			await sync.push();
			await vi.waitFor(() => expect(pull.mock.calls.length).toBeGreaterThan(2), { timeout: 10_000 });
		});

		it('stops once the screen is gone', async () => {
			const { repo, sync } = await deviceWithCommit({});
			const push = vi.spyOn(repo, 'push').mockRejectedValueOnce(down());
			await sync.push();
			sync.stop();
			await new Promise((done) => setTimeout(done, 30));
			expect(push).toHaveBeenCalledTimes(1);
		});

		it('leaves a merge to its own way of sending the push', async () => {
			const { repo, sync, remote } = await deviceWithCommit({});
			const push = vi.spyOn(repo, 'push').mockRejectedValue(down());
			await pushFromElsewhere(remote, { 'a.md': 'theirs\n' }, 'theirs');
			await sync.push();
			await sync.pull();
			expect(get(sync).merge).not.toBeNull();
			// A retry that fired before the merge opened may still be finishing.
			await new Promise((done) => setTimeout(done, 30));
			const calls = push.mock.calls.length;
			await new Promise((done) => setTimeout(done, 30));
			expect(push.mock.calls.length).toBe(calls);
			expect(get(sync).pushPending).toBe(true);
		});
	});

	it('never force-pushes: a diverged remote is refused and stays as it was', async () => {
		const { repo, sync, remote } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await sync.commit({ paths: ['a.md'], message: 'x' });
		await pushFromElsewhere(remote, { 'c.md': 'new\n' }, 'remote');
		const head = await remoteHead(remote);
		expect(await sync.push()).toMatchObject({ ok: false, queued: false, code: ErrorCode.NON_FAST_FORWARD });
		expect(get(sync).report?.code).toBe(ErrorCode.NON_FAST_FORWARD);
		expect(await remoteHead(remote)).toBe(head);
	});

	it('does not leave a refused push queued, where it would fail again and again', async () => {
		const { repo, sync, remote } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await sync.commit({ paths: ['a.md'], message: 'x' });
		await rejectPushes(remote, 'no pushes here');
		expect((await sync.push()).ok).toBe(false);
		expect(get(sync)).toMatchObject({ pushPending: false, report: { code: ErrorCode.PUSH_REJECTED }, ahead: 1 });
	});

	it('runs pushes in order, so a second one finds nothing to send', async () => {
		const { repo, sync } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await sync.commit({ paths: ['a.md'], message: 'x' });
		const results = await Promise.all([sync.push(), sync.push()]);
		expect(results.map((result) => result.ok)).toEqual([true, true]);
	});

	it('still works when storage refuses the record', async () => {
		const { sync, storage } = await setUp();
		vi.spyOn(storage, 'setItem').mockImplementation(() => {
			throw new Error('quota');
		});
		await expect(sync.pull()).resolves.toMatchObject({ ok: true });
	});

	it('reads a damaged record as nothing queued', async () => {
		const remote = await createRemote({ 'a.md': 'one\n' });
		const storage = memoryStorage();
		storage.setItem(syncRecordKey(remote.id), 'not json');
		const { sync } = await openDevice(remote, { storage });
		expect(get(sync)).toMatchObject({ pushPending: false, lastSyncAt: null });
	});
});

describe('a queued push and an open merge', () => {
	/**
	 * A push queued offline, then a merge opened by the pull on coming back.
	 * @returns {ReturnType<typeof setUp>}
	 */
	async function setUpQueued() {
		const context = await setUp();
		const { repo, sync, remote, network } = context;
		await repo.writeFile('a.md', 'mine\n');
		await sync.commit({ paths: ['a.md'], message: 'mine' });
		network.online = false;
		await sync.push();
		network.online = true;
		await pushFromElsewhere(remote, { 'a.md': 'theirs\n' }, 'theirs');
		await sync.open();
		expect(get(sync)).toMatchObject({ pushPending: true, merge: { conflictedPaths: ['a.md'] } });
		return context;
	}

	it('stays queued, with nothing reported, when the tab comes back during the merge', async () => {
		const { sync, repo } = await setUpQueued();
		const push = vi.spyOn(repo, 'push');
		await sync.pushIfPending();
		expect(push).not.toHaveBeenCalled();
		expect(get(sync)).toMatchObject({ pushPending: true, report: null });
	});

	it('stays queued through a reload during the merge', async () => {
		const { reopen } = await setUpQueued();
		const reloaded = reopen();
		await reloaded.open();
		await reloaded.pushIfPending();
		expect(get(reloaded)).toMatchObject({ pushPending: true, report: null });
	});

	it('survives a push the merge refuses, when another tab opened that merge', async () => {
		const { sync } = await setUpQueued();
		expect(await sync.push()).toMatchObject({ ok: false, code: ErrorCode.MERGE_IN_PROGRESS });
		expect(get(sync).pushPending).toBe(true);
	});

	it('does not queue a push of its own when the merge refuses it', async () => {
		const { sync } = await setUpConflict();
		await sync.push();
		expect(get(sync).pushPending).toBe(false);
	});

	it('goes as soon as the merge commit is made', async () => {
		const { repo, sync, remote } = await setUpQueued();
		await repo.writeFile('a.md', 'both\n');
		expect((await sync.completeMerge({ allowMarkers: false })).ok).toBe(true);
		expect(get(sync)).toMatchObject({ merge: null, pushPending: false, ahead: 0, report: null });
		expect(await showRemote(remote, 'main:a.md')).toBe('both\n');
	});

	it('is not left waiting when the merge is abandoned: the refusal offers a pull', async () => {
		const { sync, remote } = await setUpQueued();
		const head = await remoteHead(remote);
		expect((await sync.abortMerge()).ok).toBe(true);
		expect(get(sync)).toMatchObject({ merge: null, pushPending: false, report: { code: ErrorCode.NON_FAST_FORWARD } });
		expect(await remoteHead(remote)).toBe(head);
	});

	it('is not left waiting when a damaged merge is reset', async () => {
		const { fs, repo, reopen } = await setUpQueued();
		await fs.promises.writeFile(`${repo.dir}/.git/gitnote-merge.json`, 'not json', { encoding: 'utf8' });
		const reloaded = reopen();
		await reloaded.open();
		expect(get(reloaded)).toMatchObject({ mergeDamaged: true, pushPending: true });
		expect((await reloaded.resetDamagedMerge()).ok).toBe(true);
		expect(get(reloaded)).toMatchObject({ mergeDamaged: false, pushPending: false, report: { code: ErrorCode.NON_FAST_FORWARD } });
	});

	it('keeps waiting when the merge commit is made offline', async () => {
		const { repo, sync, network, remote } = await setUpQueued();
		const head = await remoteHead(remote);
		await repo.writeFile('a.md', 'both\n');
		network.online = false;
		expect((await sync.completeMerge({ allowMarkers: false })).ok).toBe(true);
		expect(get(sync)).toMatchObject({ merge: null, pushPending: true });
		expect(await remoteHead(remote)).toBe(head);
	});

	it('does not push a merge commit nobody asked to push', async () => {
		const { repo, sync, remote } = await setUpConflict();
		const head = await remoteHead(remote);
		await repo.writeFile('a.md', 'both\n');
		await sync.completeMerge({ allowMarkers: false });
		expect(await remoteHead(remote)).toBe(head);
	});
});

describe('size warnings', () => {
	it('keep what a commit warned about, for a commit no panel checked first', async () => {
		const { repo, sync } = await setUp();
		await repo.writeFile('big.bin', new Uint8Array(60 * MB).fill(97));
		await sync.autosaveOps.commit(['big.bin'], 'autosave: big.bin');
		expect(get(sync).commitWarnings).toMatchObject([{ level: 'warn', path: 'big.bin' }]);

		await repo.writeFile('a.md', 'edited\n');
		await sync.commit({ paths: ['a.md'], message: 'small' });
		expect(get(sync).commitWarnings).toEqual([]);
	}, 60_000);

	it('keep what a merge commit warned about', async () => {
		const { repo, sync } = await setUpConflict();
		await repo.writeFile('a.md', new Uint8Array(60 * MB).fill(97));
		expect((await sync.completeMerge({ allowMarkers: false })).ok).toBe(true);
		expect(get(sync).commitWarnings).toMatchObject([{ level: 'warn', path: 'a.md' }]);
	}, 60_000);
});

describe('discard', () => {
	it('reports a refusal to delete files nobody selected, and leaves them', async () => {
		const remote = await createRemote({ a: 'one\n' });
		const { repo, sync } = await openDevice(remote);
		await repo.rename('a', 'b');
		await repo.writeFile('a/keep.md', 'precious\n');
		expect((await sync.discard(['a'])).ok).toBe(false);
		expect(get(sync).report).toMatchObject({ code: ErrorCode.PATH_EXISTS, message: expect.stringContaining('a/keep.md') });
		expect(await repo.readText('a/keep.md')).toBe('precious\n');
	});

	it('takes the file back and tells the open note', async () => {
		const { repo, sync, notes } = await setUp();
		await notes.open('a.md');
		await repo.writeFile('a.md', 'edited\n');
		await notes.refresh();
		expect(get(notes).note?.text).toBe('edited\n');
		await sync.refresh();

		await sync.discard(['a.md']);

		expect(get(notes).note?.text).toBe('one\n');
		expect(get(sync).files).toEqual([]);
	});
});

describe('undoing unpushed commits', () => {
	it('turns them back into changes', async () => {
		const { repo, sync } = await setUp();
		await repo.writeFile('a.md', 'edited\n');
		await sync.commit({ paths: ['a.md'], message: 'x' });
		await sync.undoUnpushed();
		expect(get(sync)).toMatchObject({ ahead: 0, files: [{ path: 'a.md', change: 'modified' }] });
	});
});

describe('a merge', () => {
	it('shows where each conflict stands', async () => {
		const { sync } = await setUpConflict();
		expect(get(sync)).toMatchObject({ merge: { conflictedPaths: ['a.md'] }, conflicts: [{ path: 'a.md', hasMarkers: true, undecided: false }] });
	});

	it('refuses the merge commit while markers remain, then makes one that pushes', async () => {
		const { repo, sync, remote } = await setUpConflict();
		expect((await sync.completeMerge({ allowMarkers: false })).ok).toBe(false);
		expect(get(sync).report?.code).toBe(ErrorCode.CONFLICTS_UNRESOLVED);

		await repo.writeFile('a.md', 'both\n');
		expect((await sync.completeMerge({ allowMarkers: false })).ok).toBe(true);
		expect(get(sync)).toMatchObject({ merge: null, conflicts: [], report: null });

		await sync.push();
		expect(await showRemote(remote, 'main:a.md')).toBe('both\n');
		// The clean half of the merge came along, and both histories are in it.
		expect(await showRemote(remote, 'main:c.md')).toBe('new\n');
		expect((await runGit(['log', '-1', '--format=%p', 'main'], remote.bare)).trim().split(' ')).toHaveLength(2);
	});

	it('keeps real marker text only when told to', async () => {
		const { sync, remote } = await setUpConflict();
		expect((await sync.completeMerge({ allowMarkers: true })).ok).toBe(true);
		await sync.push();
		expect(await showRemote(remote, 'main:a.md')).toContain('<<<<<<<');
	});

	it('goes back to the local commit on abort, and can start again', async () => {
		const { repo, sync } = await setUpConflict();
		await sync.abortMerge();
		expect(get(sync)).toMatchObject({ merge: null, files: [] });
		expect(await repo.readText('a.md')).toBe('mine\n');
		expect(await sync.pull()).toMatchObject({ status: 'conflict' });
	});

	it('does not commit, pull or push over the open merge', async () => {
		const { sync } = await setUpConflict();
		expect((await sync.commit({ paths: ['a.md'], message: 'x' })).code).toBe(ErrorCode.MERGE_IN_PROGRESS);
		expect((await sync.pull()).code).toBe(ErrorCode.MERGE_IN_PROGRESS);
		expect((await sync.push()).code).toBe(ErrorCode.MERGE_IN_PROGRESS);
	});

	it('still shows the merge and its way out when a conflict\'s details cannot be read', async () => {
		const { sync, repo } = await setUpConflict();
		vi.spyOn(repo, 'describeConflicts').mockRejectedValue(new Error('storage went away'));
		await sync.refresh();
		expect(get(sync)).toMatchObject({
			merge: { conflictedPaths: ['a.md'] },
			conflicts: [{ path: 'a.md', hasMarkers: true, undecided: true }],
			report: { message: 'storage went away' }
		});
		expect((await sync.autosaveOps.readWork()).merge).toBe(true);
		vi.mocked(repo.describeConflicts).mockRestore();
		expect((await sync.abortMerge()).ok).toBe(true);
		expect(get(sync)).toMatchObject({ merge: null, report: null });
	});

	it('still shows the merge when the counts cannot be read', async () => {
		const { sync, repo } = await setUpConflict();
		vi.spyOn(repo, 'aheadBehind').mockRejectedValueOnce(new Error('storage went away'));
		await sync.refresh();
		expect(get(sync)).toMatchObject({ merge: { conflictedPaths: ['a.md'] }, report: { message: 'storage went away' } });
	});

	it('resolves a conflict on a symbolic link whose target is gone, and it stays a link', async () => {
		const remote = await createRemote({ 'a.md': 'one\n' });
		await changeElsewhere(remote, {}, async (work) => {
			await symlink('a.md', path.join(work, 'link.md'));
			await runGit(['add', 'link.md'], work);
		});
		const { repo, sync } = await openDevice(remote);
		await repo.remove('link.md');
		await sync.commit({ paths: ['link.md'], message: 'drop the link' });
		await changeElsewhere(remote, {}, async (work) => {
			await unlink(path.join(work, 'link.md'));
			await symlink('nowhere.md', path.join(work, 'link.md'));
			await runGit(['add', 'link.md'], work);
		});

		expect(await sync.pull()).toMatchObject({ ok: true, status: 'conflict' });
		expect(get(sync)).toMatchObject({ report: null, merge: { conflictedPaths: ['link.md'] }, conflicts: [{ path: 'link.md', kind: 'deleted_by_us', hasMarkers: false, undecided: true }] });

		expect((await sync.resolve('link.md', 'theirs')).ok).toBe(true);
		expect((await sync.completeMerge({ allowMarkers: false })).ok).toBe(true);
		await sync.push();
		expect(await runGit(['ls-tree', 'main', 'link.md'], remote.bare)).toMatch(/^120000 /);
		expect(await showRemote(remote, 'main:link.md')).toBe('nowhere.md');
	});

	it('offers a way out of a damaged record, instead of failing on every step', async () => {
		const { sync, fs, repo, reopen } = await setUpConflict();
		await fs.promises.writeFile(`${repo.dir}/.git/gitnote-merge.json`, 'not json', { encoding: 'utf8' });
		const reloaded = reopen();
		await reloaded.open();
		expect(get(reloaded)).toMatchObject({ mergeDamaged: true, merge: null });

		expect((await reloaded.resetDamagedMerge()).ok).toBe(true);
		expect(get(reloaded)).toMatchObject({ mergeDamaged: false, report: null, files: expect.arrayContaining([expect.objectContaining({ path: 'a.md' })]) });
		await sync.refresh();
		expect(get(sync).merge).toBeNull();
	});
});

describe('the autosave operations', () => {
	it('name the file over a size limit, so autosave can leave it out', async () => {
		const { repo, sync } = await setUp();
		await repo.writeFile('big.bin', new Uint8Array(101 * 1024 * 1024).fill(97));
		await repo.writeFile('a.md', 'edited\n');
		expect(await sync.autosaveOps.checkCommit(['big.bin', 'a.md'])).toMatchObject([{ level: 'block', path: 'big.bin' }]);
	}, 60_000);

	it('name a file with conflict markers, so autosave can leave it out', async () => {
		const { repo, sync } = await setUp();
		await repo.writeFile('a.md', '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n');
		expect(await sync.autosaveOps.findMarkers(['a.md', 'b.md'])).toEqual(['a.md']);
	});

	it('say a push is queued, so autosave sends it even with nothing ahead', async () => {
		const { sync } = await setUp();
		sync.autosaveOps.queuePush();
		expect(await sync.autosaveOps.readWork()).toMatchObject({ ahead: 0, pushPending: true });
	});

	it('see an open merge, so autosave stands aside', async () => {
		const { sync } = await setUpConflict();
		expect((await sync.autosaveOps.readWork()).merge).toBe(true);
	});

	it('save the open note into the working tree and list it as changed', async () => {
		const { sync, notes } = await setUp();
		await notes.open('a.md');
		notes.edit('typed\n');
		await sync.autosaveOps.saveDrafts();
		const work = await sync.autosaveOps.readWork();
		expect(work.paths).toEqual(['a.md']);
		expect(get(notes).note).toMatchObject({ dirty: false, savedText: 'typed\n' });
	});

	it('report a failure to save instead of throwing', async () => {
		const { sync, notes, repo } = await setUp();
		vi.spyOn(notes, 'saveDrafts').mockRejectedValueOnce(new Error('disk gone'));
		const failing = createSync({ repoId: repo.id, repo, notes, storage: memoryStorage(), getAuthor: () => AUTHOR });
		expect(await failing.autosaveOps.saveDrafts()).toEqual({ saved: [], skipped: [] });
		expect(get(failing).report?.message).toBe('disk gone');
		expect(get(sync).report).toBeNull();
	});
});
