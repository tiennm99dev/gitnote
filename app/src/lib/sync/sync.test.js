import { memfs } from 'memfs';
import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { memoryDraftStore } from '../../../test/draft-doubles.js';
import { FIXTURE_CREDENTIAL } from '../../../test/git-http-server.js';
import { createRemote, pushFromElsewhere, rejectPushes, RELAY_PORT, remoteHead, runGit, showRemote } from '../../../test/remote-repo.js';
import { ErrorCode, networkError } from '../git/errors.js';
import { createGitHttp } from '../git/http.js';
import { syncRecordKey } from '../git/local-repos.js';
import { createRepo } from '../git/repo.js';
import { createNotes } from '../stores/notes.js';
import { commitMessageFor, createSync } from './sync.js';

const AUTHOR = { name: 'Local Author', email: 'local@example.com' };

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

// The result's shape is inferred, and the tests read it by name.
// eslint-disable-next-line jsdoc/require-returns
/**
 * A real clone on its own memory file system, behind the store the screen uses.
 * @param {import('../../../test/remote-repo.js').Remote} remote
 * @param {{ storage?: Storage, author?: typeof AUTHOR | null }} [options]
 */
async function openDevice(remote, { storage = memoryStorage(), author = AUTHOR } = {}) {
	const fs = /** @type {import('../git/repo.js').FsClient} */ (/** @type {unknown} */ (memfs().fs));
	const repo = createRepo({ id: remote.id, fs, http: createGitHttp({ relayOrigin: `http://127.0.0.1:${RELAY_PORT}` }), provider: 'github', getCredential: () => FIXTURE_CREDENTIAL });
	await repo.clone({ url: remote.url });
	const network = { online: true };
	const notes = createNotes({ repoId: remote.id, provider: 'github', repo, drafts: memoryDraftStore() });
	const options = { repoId: remote.id, repo, notes, storage, isOnline: () => network.online, getAuthor: () => author };
	return { repo, fs, notes, network, storage, sync: createSync(options), reopen: () => createSync(options) };
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

	it('asks for an author it needs for a merge', async () => {
		const remote = await createRemote({ 'a.md': 'one\n' });
		const { sync } = await openDevice(remote, { author: null });
		expect((await sync.pull()).ok).toBe(false);
		expect(get(sync).needsAuthor).toBe(true);
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

describe('discard', () => {
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
