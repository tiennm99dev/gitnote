import { memfs } from 'memfs';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { memoryDraftStore } from '../../../test/draft-doubles.js';
import { FIXTURE_CREDENTIAL } from '../../../test/git-http-server.js';
import { createRemote, RELAY_PORT, showRemote } from '../../../test/remote-repo.js';
import { ErrorCode } from '../git/errors.js';
import { createGitHttp } from '../git/http.js';
import { createRepo } from '../git/repo.js';
import { createNotes, isWithin, movedPath } from './notes.js';

const REPO_ID = 'github.com/o/notes';
const SEED = {
	'README.md': '# Readme\n',
	'notes/today.md': 'Buy milk\nSee the Dentist\n',
	'notes/crlf.md': 'one\r\ntwo\r\n',
	'notes/plain.txt': 'plain\n',
	'notes/tiếng việt.md': 'Tiếng Việt ở đây\n'
};

/**
 * A real clone on an in-memory file system, as the store sees it in the browser.
 * @param {Record<string, string>} [seed]
 * @returns {Promise<{ remote: import('../../../test/remote-repo.js').Remote, repo: import('../git/repo.js').Repo, drafts: ReturnType<typeof memoryDraftStore>, notes: import('./notes.js').Notes, open: () => import('./notes.js').Notes }>}
 */
async function setUp(seed = SEED) {
	const remote = await createRemote(seed);
	const repo = createRepo({
		id: remote.id,
		fs: /** @type {import('../git/repo.js').FsClient} */ (/** @type {unknown} */ (memfs().fs)),
		http: createGitHttp({ relayOrigin: `http://127.0.0.1:${RELAY_PORT}` }),
		provider: 'github',
		getCredential: () => FIXTURE_CREDENTIAL
	});
	await repo.clone({ url: remote.url });
	const drafts = memoryDraftStore();
	const open = () => createNotes({ repoId: REPO_ID, provider: 'github', repo, drafts });
	return { remote, repo, drafts, notes: open(), open };
}

/**
 * @param {import('./notes.js').Notes} notes
 * @returns {import('./notes.js').OpenNote}
 */
function openNote(notes) {
	const { note } = get(notes);
	if (!note) throw new Error('no note is open');
	return note;
}

/** @type {Awaited<ReturnType<typeof setUp>>} */
let context;

describe('opening', () => {
	beforeEach(async () => {
		context = await setUp();
	});

	it('lists the tree and opens a note as markdown, clean', async () => {
		const { notes } = context;
		await notes.open('notes/today.md');
		const { entries, treeLoaded } = get(notes);
		expect(treeLoaded).toBe(true);
		expect(entries.map((entry) => entry.path)).toContain('notes/today.md');
		expect(openNote(notes)).toMatchObject({ kind: 'markdown', text: SEED['notes/today.md'], dirty: false, restored: false });
	});

	it('closes the note on an empty path', async () => {
		const { notes } = context;
		await notes.open('README.md');
		await notes.open('');
		expect(get(notes).note).toBeNull();
	});

	it('tells text, image, binary and missing apart', async () => {
		const { notes, repo } = context;
		await repo.writeFile('pic.png', new Uint8Array([137, 80, 78, 71]));
		await repo.writeFile('blob.bin', new Uint8Array([1, 0, 2, 0]));

		await notes.open('notes/plain.txt');
		expect(openNote(notes)).toMatchObject({ kind: 'text', text: 'plain\n' });
		await notes.open('pic.png');
		expect(openNote(notes)).toMatchObject({ kind: 'image', size: 4 });
		await notes.open('blob.bin');
		expect(openNote(notes)).toMatchObject({ kind: 'binary', size: 4, text: '' });
		await notes.open('nothing.md');
		expect(openNote(notes)).toMatchObject({ kind: 'missing' });
	});

	it('shows only the size of a text file too large to edit', async () => {
		const { notes, repo } = context;
		await repo.writeFile('huge.md', 'x'.repeat(5_000_001));
		await notes.open('huge.md');
		expect(openNote(notes)).toMatchObject({ kind: 'large', size: 5_000_001, text: '' });
	});

	it('refuses a path that reaches into git', async () => {
		await expect(context.notes.open('.git/config')).rejects.toMatchObject({ code: ErrorCode.INVALID_PATH });
	});

	it('closes the open note when a path it cannot open is asked for', async () => {
		const { notes } = context;
		await notes.open('README.md');
		await expect(notes.open('.git/config')).rejects.toMatchObject({ code: ErrorCode.INVALID_PATH });
		expect(get(notes).note).toBeNull();
	});

	it('uses the last of two quick opens', async () => {
		const { notes } = context;
		await Promise.all([notes.open('README.md'), notes.open('notes/plain.txt')]);
		expect(openNote(notes).path).toBe('notes/plain.txt');
	});
});

describe('unsaved buffers', () => {
	beforeEach(async () => {
		context = await setUp();
	});

	it('keeps a draft through a reload, without touching the working tree', async () => {
		const { notes, open, repo } = context;
		await notes.open('README.md');
		notes.edit('# Edited\n');
		expect(openNote(notes)).toMatchObject({ dirty: true, draftStored: false });
		await notes.flushDrafts();
		expect(openNote(notes).draftStored).toBe(true);
		expect(get(notes).draftPaths).toEqual(['README.md']);
		expect(await repo.readText('README.md')).toBe('# Readme\n');
		expect((await repo.status()).files).toEqual([]);

		const reloaded = open();
		await reloaded.open('README.md');
		expect(openNote(reloaded)).toMatchObject({ text: '# Edited\n', savedText: '# Readme\n', dirty: true, restored: true, diskChanged: false });
		expect(get(reloaded).draftPaths).toEqual(['README.md']);
	});

	it('keeps drafts of several notes at once', async () => {
		const { notes, open } = context;
		await notes.open('README.md');
		notes.edit('a');
		await notes.open('notes/today.md');
		notes.edit('b');
		await notes.flushDrafts();

		const reloaded = open();
		await reloaded.open('README.md');
		expect(openNote(reloaded).text).toBe('a');
		await reloaded.open('notes/today.md');
		expect(openNote(reloaded).text).toBe('b');
	});

	it('stores only the latest of many quick edits', async () => {
		const { notes, drafts, open } = context;
		await notes.open('README.md');
		let puts = 0;
		const put = drafts.put;
		drafts.put = async (draft) => {
			puts += 1;
			return put(draft);
		};
		for (let index = 0; index < 50; index += 1) notes.edit(`text ${index}`);
		await notes.flushDrafts();
		expect(puts).toBeLessThan(5);

		const reloaded = open();
		await reloaded.open('README.md');
		expect(openNote(reloaded).text).toBe('text 49');
	});

	it('removes the draft when the edit is undone by hand', async () => {
		const { notes, drafts } = context;
		await notes.open('README.md');
		notes.edit('x');
		notes.edit('# Readme\n');
		await notes.flushDrafts();
		expect(openNote(notes).dirty).toBe(false);
		expect(drafts.records.size).toBe(0);
		expect(get(notes).draftPaths).toEqual([]);
	});

	it('says so when the browser refuses a draft, and recovers', async () => {
		const { notes, drafts } = context;
		await notes.open('README.md');
		drafts.failing.put = true;
		notes.edit('x');
		await notes.flushDrafts();
		expect(openNote(notes)).toMatchObject({ draftFailed: true, draftStored: false, dirty: true });
		drafts.failing.put = false;
		notes.edit('xy');
		await notes.flushDrafts();
		expect(openNote(notes)).toMatchObject({ draftFailed: false, draftStored: true });
	});

	it('discard goes back to the file for good', async () => {
		const { notes, open, drafts } = context;
		await notes.open('README.md');
		const { version } = openNote(notes);
		notes.edit('x');
		await notes.discard();
		expect(openNote(notes)).toMatchObject({ text: '# Readme\n', dirty: false });
		expect(openNote(notes).version).toBeGreaterThan(version);
		await notes.flushDrafts();
		expect(drafts.records.size).toBe(0);

		const reloaded = open();
		await reloaded.open('README.md');
		expect(openNote(reloaded).dirty).toBe(false);
	});
});

describe('saving', () => {
	beforeEach(async () => {
		context = await setUp();
	});

	it('writes the working tree, commits nothing, and drops the draft', async () => {
		const { notes, repo, drafts } = context;
		await notes.open('README.md');
		notes.edit('# Saved\n');
		expect(await notes.save()).toBe(true);
		await notes.flushDrafts();

		expect(openNote(notes)).toMatchObject({ dirty: false, savedText: '# Saved\n', size: 8 });
		expect(await repo.readText('README.md')).toBe('# Saved\n');
		expect(drafts.records.size).toBe(0);
		const status = await repo.status();
		expect(status.files).toEqual([{ path: 'README.md', change: 'modified' }]);
		expect((await repo.aheadBehind()).ahead).toBe(0);
	});

	it('keeps CRLF and other bytes the user did not touch', async () => {
		const { notes, repo } = context;
		await notes.open('notes/crlf.md');
		expect(openNote(notes).text).toBe('one\r\ntwo\r\n');
		notes.edit('one\r\ntwo\r\nthree\r\n');
		await notes.save();
		expect(new TextDecoder().decode(await repo.readFile('notes/crlf.md'))).toBe('one\r\ntwo\r\nthree\r\n');
	});

	it('keeps a byte order mark through open and save', async () => {
		const { notes, repo } = context;
		await repo.writeFile('bom.md', new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
		await notes.open('bom.md');
		notes.edit(`${openNote(notes).text}b`);
		await notes.save();
		expect([...(await repo.readFile('bom.md'))]).toEqual([0xef, 0xbb, 0xbf, 0x61, 0x62]);
	});

	it('refuses to overwrite a file that changed underneath, until the user picks', async () => {
		const { notes, repo } = context;
		await notes.open('README.md');
		notes.edit('mine\n');
		await repo.writeFile('README.md', 'theirs\n');

		expect(await notes.save()).toBe(false);
		expect(openNote(notes)).toMatchObject({ diskChanged: true, dirty: true, text: 'mine\n' });
		expect(await repo.readText('README.md')).toBe('theirs\n');

		await notes.keepMine();
		expect(openNote(notes)).toMatchObject({ diskChanged: false, savedText: 'theirs\n', dirty: true });
		expect(await notes.save()).toBe(true);
		expect(await repo.readText('README.md')).toBe('mine\n');
	});

	it('flags a restored draft whose file moved on, and can drop it for the file', async () => {
		const { notes, repo, open } = context;
		await notes.open('README.md');
		notes.edit('mine\n');
		await notes.flushDrafts();
		await repo.writeFile('README.md', 'theirs\n');

		const reloaded = open();
		await reloaded.open('README.md');
		expect(openNote(reloaded)).toMatchObject({ text: 'mine\n', diskChanged: true, restored: true });
		await reloaded.discard();
		expect(openNote(reloaded)).toMatchObject({ text: 'theirs\n', dirty: false, diskChanged: false });
	});

	it('keeps a draft whose file was deleted, listed and able to bring it back', async () => {
		const { notes, repo, open } = context;
		await notes.open('README.md');
		notes.edit('mine\n');
		await notes.flushDrafts();
		await repo.remove('README.md');

		const reloaded = open();
		await reloaded.open('README.md');
		expect(get(reloaded).draftPaths).toEqual(['README.md']);
		expect(openNote(reloaded)).toMatchObject({ kind: 'markdown', text: 'mine\n', diskChanged: true });
		await reloaded.keepMine();
		expect(await reloaded.save()).toBe(true);
		expect(await repo.readText('README.md')).toBe('mine\n');
	});

	it('drops a draft another tab already saved', async () => {
		const { notes, repo, open, drafts } = context;
		await notes.open('README.md');
		notes.edit('same\n');
		await notes.flushDrafts();
		await repo.writeFile('README.md', 'same\n');

		const reloaded = open();
		await reloaded.open('README.md');
		await reloaded.flushDrafts();
		expect(openNote(reloaded)).toMatchObject({ text: 'same\n', dirty: false, restored: false });
		expect(drafts.records.size).toBe(0);
	});

	it('follows the file on refresh when clean, and only warns when dirty', async () => {
		const { notes, repo } = context;
		await notes.open('README.md');
		await repo.writeFile('README.md', 'other tab\n');
		await notes.refresh();
		expect(openNote(notes)).toMatchObject({ text: 'other tab\n', dirty: false });

		notes.edit('mine\n');
		await repo.writeFile('README.md', 'other tab again\n');
		await notes.refresh();
		expect(openNote(notes)).toMatchObject({ text: 'mine\n', diskChanged: true });
	});
});

describe('files and folders', () => {
	beforeEach(async () => {
		context = await setUp();
	});

	it('creates a note and its folders, and commits nothing', async () => {
		const { notes, repo } = context;
		expect(await notes.create('new/deep/note.md', '# New\n')).toBe('new/deep/note.md');
		expect(await repo.readText('new/deep/note.md')).toBe('# New\n');
		expect((await repo.status()).files).toEqual([{ path: 'new/deep/note.md', change: 'added' }]);
		expect(get(notes).entries.map((entry) => entry.path)).toContain('new/deep/note.md');
	});

	it('never creates over what exists', async () => {
		const { notes, repo } = context;
		await expect(notes.create('README.md')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		await expect(notes.create('notes')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		await expect(notes.create('README.md/x.md')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		expect(await repo.readText('README.md')).toBe('# Readme\n');
	});

	it('refuses bad paths', async () => {
		const { notes } = context;
		for (const path of ['../x.md', '.git/x', 'a//b.md', 'a\\b.md', '']) {
			await expect(notes.create(path)).rejects.toMatchObject({ code: ErrorCode.INVALID_PATH });
		}
	});

	it('keeps a new empty folder in git with a placeholder', async () => {
		const { notes, repo } = context;
		await notes.createFolder('ideas');
		expect(get(notes).entries.map((entry) => entry.path)).toContain('ideas/.gitkeep');
		expect((await repo.status()).files).toEqual([{ path: 'ideas/.gitkeep', change: 'added' }]);
		await expect(notes.createFolder('notes')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
	});

	it('renames and moves a note, taking its draft along', async () => {
		const { notes, repo, open } = context;
		await notes.open('README.md');
		notes.edit('draft\n');
		await notes.move('README.md', 'archive/old.md');

		expect(await repo.readText('archive/old.md')).toBe('# Readme\n');
		await expect(repo.readText('README.md')).rejects.toMatchObject({ code: ErrorCode.PATH_NOT_FOUND });
		expect(get(notes).draftPaths).toEqual(['archive/old.md']);

		const reloaded = open();
		await reloaded.open('archive/old.md');
		expect(openNote(reloaded)).toMatchObject({ text: 'draft\n', savedText: '# Readme\n', diskChanged: false });
	});

	it('moves a folder with the drafts inside it', async () => {
		const { notes, repo } = context;
		await notes.open('notes/today.md');
		notes.edit('draft\n');
		await notes.move('notes', 'journal');
		expect(await repo.readText('journal/plain.txt')).toBe('plain\n');
		expect(get(notes).draftPaths).toEqual(['journal/today.md']);
	});

	it('never moves over what exists', async () => {
		const { notes, repo } = context;
		await expect(notes.move('README.md', 'notes/today.md')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		expect(await repo.readText('notes/today.md')).toBe(SEED['notes/today.md']);
	});

	it('leaves everything alone when a note moves to its own path', async () => {
		const { notes, repo } = context;
		await notes.open('README.md');
		notes.edit('draft\n');
		await notes.flushDrafts();
		expect(await notes.move('README.md', 'README.md')).toBe('README.md');
		expect(get(notes).draftPaths).toEqual(['README.md']);
		await repo.remove('README.md');
		expect(await notes.move('README.md', 'README.md')).toBe('README.md');
		expect(get(notes).draftPaths).toEqual(['README.md']);
	});

	/**
	 * Leaves unsaved text on a path.
	 * @param {import('./notes.js').Notes} notes
	 * @param {string} path
	 * @param {string} text
	 * @returns {Promise<void>}
	 */
	const draftOn = async (notes, path, text) => {
		await notes.open(path);
		notes.edit(text);
		await notes.flushDrafts();
	};

	it('never moves a draft over another draft', async () => {
		const { notes, drafts, repo } = context;
		await draftOn(notes, 'README.md', 'first');
		await draftOn(notes, 'notes/today.md', 'second');
		await expect(notes.move('README.md', 'notes/today.md')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });

		await repo.remove('README.md');
		await expect(notes.move('README.md', 'notes/today.md')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		expect((await drafts.get(REPO_ID, 'notes/today.md'))?.text).toBe('second');
		expect((await drafts.get(REPO_ID, 'README.md'))?.text).toBe('first');
	});

	it('never moves a file onto a path whose file is gone but whose draft remains', async () => {
		const { notes, drafts, repo } = context;
		await draftOn(notes, 'README.md', 'mine');
		await draftOn(notes, 'notes/today.md', 'kept');
		await repo.remove('notes/today.md');
		await expect(notes.move('README.md', 'notes/today.md')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		await expect(notes.move('notes/plain.txt', 'notes/today.md')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		expect((await drafts.get(REPO_ID, 'notes/today.md'))?.text).toBe('kept');
		expect(await repo.readText('notes/plain.txt')).toBe('plain\n');
	});

	it('never moves a folder over a draft inside the target', async () => {
		const { notes, drafts, repo } = context;
		await draftOn(notes, 'notes/today.md', 'kept');
		await repo.remove('notes');
		await repo.writeFile('other/today.md', 'file\n');
		await expect(notes.move('other', 'notes')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		expect((await drafts.get(REPO_ID, 'notes/today.md'))?.text).toBe('kept');
	});

	it('never moves a draft whose file is gone onto a file, or inside itself', async () => {
		const { notes, drafts, repo } = context;
		await draftOn(notes, 'README.md', 'mine');
		await repo.remove('README.md');
		await expect(notes.move('README.md', 'notes/today.md')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		await expect(notes.move('README.md', 'notes')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		await expect(notes.move('README.md', 'notes/today.md/x.md')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		await expect(notes.move('README.md', 'README.md/x.md')).rejects.toMatchObject({ code: ErrorCode.INVALID_PATH });
		expect((await drafts.get(REPO_ID, 'README.md'))?.text).toBe('mine');
	});

	it('moves a draft whose file is gone', async () => {
		const { notes, repo } = context;
		await notes.open('README.md');
		notes.edit('draft\n');
		await notes.flushDrafts();
		await repo.remove('README.md');
		await notes.move('README.md', 'kept.md');
		expect(get(notes).draftPaths).toEqual(['kept.md']);
	});

	it('deletes a file with its draft, closing it if open', async () => {
		const { notes, repo, drafts } = context;
		await notes.open('README.md');
		notes.edit('draft\n');
		await notes.remove('README.md');
		expect(get(notes).note).toBeNull();
		expect(drafts.records.size).toBe(0);
		await expect(repo.readText('README.md')).rejects.toMatchObject({ code: ErrorCode.PATH_NOT_FOUND });
		expect((await repo.status()).files).toEqual([{ path: 'README.md', change: 'deleted' }]);
	});

	it('deletes a folder with everything in it', async () => {
		const { notes, repo } = context;
		await notes.open('notes/today.md');
		notes.edit('draft\n');
		await notes.remove('notes');
		expect(get(notes).draftPaths).toEqual([]);
		expect(get(notes).entries.map((entry) => entry.path)).toEqual(['README.md']);
		await expect(repo.readText('notes/plain.txt')).rejects.toMatchObject({ code: ErrorCode.PATH_NOT_FOUND });
	});

	it('deletes a draft whose file is gone, and reports a path that is simply not there', async () => {
		const { notes, repo, drafts } = context;
		await notes.open('README.md');
		notes.edit('draft\n');
		await notes.flushDrafts();
		await repo.remove('README.md');
		await notes.remove('README.md');
		expect(drafts.records.size).toBe(0);
		await expect(notes.remove('never.md')).rejects.toMatchObject({ code: ErrorCode.PATH_NOT_FOUND });
	});

	it('helps the UI follow a move', () => {
		expect(isWithin('a/b.md', 'a')).toBe(true);
		expect(isWithin('a', 'a')).toBe(true);
		expect(isWithin('ab/c.md', 'a')).toBe(false);
		expect(movedPath('a/b/c.md', 'a/b', 'x')).toBe('x/c.md');
	});
});

describe('when the file list cannot be read', () => {
	beforeEach(async () => {
		context = await setUp();
	});

	/**
	 * The store over the real engine, with a listing that fails until told not to.
	 * @returns {{ notes: import('./notes.js').Notes, failing: { list: boolean } }}
	 */
	const withFailingList = () => {
		const { repo, drafts } = context;
		const failing = { list: true };
		const notes = createNotes({
			repoId: REPO_ID,
			provider: 'github',
			drafts,
			repo: {
				...repo,
				listTree: async () => {
					if (failing.list) throw new Error('the disk said no');
					return repo.listTree();
				}
			}
		});
		return { notes, failing };
	};

	it('opens a note that exists from the file itself, not as missing', async () => {
		const { notes } = withFailingList();
		await notes.open('README.md');
		expect(openNote(notes)).toMatchObject({ kind: 'markdown', text: '# Readme\n', size: 9 });
		expect(get(notes).treeError).toBe('the disk said no');
		await notes.open('nothing.md');
		expect(openNote(notes).kind).toBe('missing');
	});

	it('still tells images and oversized files apart', async () => {
		const { repo } = context;
		await repo.writeFile('pic.png', new Uint8Array([137, 80, 78, 71]));
		await repo.writeFile('huge.md', 'x'.repeat(5_000_001));
		const { notes } = withFailingList();
		await notes.open('pic.png');
		expect(openNote(notes)).toMatchObject({ kind: 'image', size: 4 });
		await notes.open('huge.md');
		expect(openNote(notes)).toMatchObject({ kind: 'large', size: 5_000_001 });
	});

	it('refuses to create, and leaves the file holding what it held', async () => {
		const { repo } = context;
		await repo.writeFile('README.md', 'uncommitted real text\n');
		const { notes, failing } = withFailingList();
		await expect(notes.create('README.md')).rejects.toThrow('the disk said no');
		await expect(notes.createFolder('notes')).rejects.toThrow('the disk said no');
		await expect(notes.create('fresh.md')).rejects.toThrow('the disk said no');
		expect(await repo.readText('README.md')).toBe('uncommitted real text\n');

		failing.list = false;
		expect(await notes.create('fresh.md')).toBe('fresh.md');
		expect(get(notes).treeError).toBeNull();
	});

	it('refuses to add an image rather than guess which names are free', async () => {
		const { repo } = context;
		await repo.writeFile('assets/cat.png', new Uint8Array([1]));
		const { notes } = withFailingList();
		await expect(notes.addImage('a.md', new File([new Uint8Array(4)], 'cat.png', { type: 'image/png' }))).rejects.toThrow('the disk said no');
		expect([...(await repo.readFile('assets/cat.png'))]).toEqual([1]);
	});

	it('refuses moves, deletes and searches that would act on a stale list', async () => {
		const { repo } = context;
		const { notes } = withFailingList();
		await expect(notes.move('README.md', 'x.md')).rejects.toThrow('the disk said no');
		await expect(notes.remove('README.md')).rejects.toThrow('the disk said no');
		await expect(notes.search('milk')).rejects.toThrow('the disk said no');
		expect(await repo.readText('README.md')).toBe('# Readme\n');
	});

	it('saves over the file it was opened from', async () => {
		const { repo } = context;
		const { notes } = withFailingList();
		await notes.open('README.md');
		notes.edit('edited\n');
		expect(await notes.save()).toBe(true);
		expect(await repo.readText('README.md')).toBe('edited\n');
	});

	it('never overwrites a file the list did not know about', async () => {
		const { repo, drafts } = context;
		const notes = createNotes({ repoId: REPO_ID, provider: 'github', drafts, repo: { ...repo, listTree: async () => [] } });
		await expect(notes.create('README.md')).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		expect(await repo.readText('README.md')).toBe('# Readme\n');
		await repo.writeFile('assets/cat.png', new Uint8Array([1]));
		await expect(notes.addImage('a.md', new File([new Uint8Array(4)], 'cat.png', { type: 'image/png' }))).rejects.toMatchObject({ code: ErrorCode.PATH_EXISTS });
		expect([...(await repo.readFile('assets/cat.png'))]).toEqual([1]);
	});
});

describe('two tabs on one note', () => {
	beforeEach(async () => {
		context = await setUp();
	});

	it('a save leaves a draft that now holds the other tab\'s text', async () => {
		const { open, repo } = context;
		const [a, b] = [open(), open()];
		await a.open('README.md');
		await b.open('README.md');
		a.edit('A words');
		await a.flushDrafts();
		b.edit('B words');
		await b.flushDrafts();

		await a.save();
		await a.flushDrafts();
		expect(await repo.readText('README.md')).toBe('A words');

		const reloaded = open();
		await reloaded.open('README.md');
		expect(openNote(reloaded)).toMatchObject({ text: 'B words', dirty: true, restored: true });
		expect(get(a).draftPaths).toEqual([]);
		await a.refresh();
		expect(get(a).draftPaths).toEqual(['README.md']);
	});

	it('a tab that comes back stores its buffer again when its draft has gone', async () => {
		const { open, drafts } = context;
		const [a, b] = [open(), open()];
		await a.open('README.md');
		await b.open('README.md');
		b.edit('B words');
		await b.flushDrafts();
		a.edit('A words');
		await a.flushDrafts();
		await a.save();
		await a.flushDrafts();
		expect(drafts.records.size).toBe(0);

		await b.refresh();
		await b.flushDrafts();
		expect(openNote(b)).toMatchObject({ text: 'B words', dirty: true, draftStored: true, diskChanged: true });

		const reloaded = open();
		await reloaded.open('README.md');
		expect(openNote(reloaded)).toMatchObject({ text: 'B words', restored: true });
	});

	it('a tab that comes back takes the draft back from the tab that replaced it', async () => {
		const { open, drafts } = context;
		const [a, b] = [open(), open()];
		await a.open('README.md');
		await b.open('README.md');
		a.edit('A words');
		await a.flushDrafts();
		b.edit('B words');
		await b.flushDrafts();

		await a.refresh();
		await a.flushDrafts();
		expect((await drafts.get(REPO_ID, 'README.md'))?.text).toBe('A words');
	});

	it('a discard removes only the draft this tab wrote', async () => {
		const { open, drafts } = context;
		const [a, b] = [open(), open()];
		await a.open('README.md');
		await b.open('README.md');
		a.edit('A words');
		await a.flushDrafts();
		b.edit('B words');
		await b.flushDrafts();
		await a.discard();
		await a.flushDrafts();
		expect((await drafts.get(REPO_ID, 'README.md'))?.text).toBe('B words');
	});

	it('a save removes the draft it wrote itself, even after a slow write', async () => {
		const { notes, drafts } = context;
		await notes.open('README.md');
		notes.edit('one');
		notes.edit('two');
		await notes.save();
		await notes.flushDrafts();
		expect(drafts.records.size).toBe(0);
	});
});

describe('a buffer that grows past the display limit', () => {
	beforeEach(async () => {
		context = await setUp();
	});

	const BIG = 'x'.repeat(5_000_100);

	it('saves again without a false conflict', async () => {
		const { notes, repo } = context;
		await notes.open('README.md');
		notes.edit(BIG);
		expect(await notes.save()).toBe(true);
		notes.edit(`${BIG}y`);
		expect(await notes.save()).toBe(true);
		expect(openNote(notes).diskChanged).toBe(false);
		expect((await repo.readText('README.md')).length).toBe(5_000_101);
	});

	it('still notices a real change to the file', async () => {
		const { notes, repo } = context;
		await notes.open('README.md');
		notes.edit(BIG);
		await notes.save();
		await repo.writeFile('README.md', `${BIG}theirs`);
		notes.edit(`${BIG}y`);
		expect(await notes.save()).toBe(false);
		expect(openNote(notes).diskChanged).toBe(true);
	});

	it('stays editable on refresh once clean', async () => {
		const { notes } = context;
		await notes.open('README.md');
		notes.edit(BIG);
		await notes.save();
		await notes.flushDrafts();
		await notes.refresh();
		expect(openNote(notes)).toMatchObject({ kind: 'markdown', text: BIG, dirty: false });
	});

	it('restores its draft after a reload with no false conflict', async () => {
		const { notes, open } = context;
		await notes.open('README.md');
		notes.edit(BIG);
		await notes.save();
		notes.edit(`${BIG}y`);
		await notes.flushDrafts();

		const reloaded = open();
		await reloaded.open('README.md');
		expect(openNote(reloaded)).toMatchObject({ kind: 'markdown', text: `${BIG}y`, restored: true, diskChanged: false });
	});
});

describe('images', () => {
	beforeEach(async () => {
		context = await setUp();
	});

	/**
	 * @param {string} name
	 * @param {string} type
	 * @param {number} [size]
	 * @returns {File}
	 */
	const image = (name, type, size = 4) => {
		const file = new File([new Uint8Array(4).fill(7)], name, { type });
		// Only the check reads this, so the suite never allocates 100 MB.
		return size === 4 ? file : /** @type {File} */ (/** @type {unknown} */ ({ name, type, size, arrayBuffer: () => file.arrayBuffer() }));
	};

	it('writes next to the note under assets and gives a relative link', async () => {
		const { notes, repo } = context;
		const added = await notes.addImage('notes/today.md', image('cat.png', 'image/png'));
		expect(added).toEqual({ path: 'notes/assets/cat.png', markdown: '![cat](./assets/cat.png)', warning: null });
		expect([...(await repo.readFile('notes/assets/cat.png'))]).toEqual([7, 7, 7, 7]);
		expect(get(notes).entries.map((entry) => entry.path)).toContain('notes/assets/cat.png');
	});

	it('never overwrites an image of the same name', async () => {
		const { notes } = context;
		await notes.addImage('notes/today.md', image('cat.png', 'image/png'));
		const second = await notes.addImage('notes/today.md', image('cat.png', 'image/png'));
		expect(second.path).toBe('notes/assets/cat-2.png');
	});

	it('warns about a large image but still adds it', async () => {
		const { notes } = context;
		const added = await notes.addImage('a.md', image('big.png', 'image/png', 60_000_000));
		expect(added.warning).toContain('50.0 MB');
		expect(get(notes).entries.map((entry) => entry.path)).toContain('assets/big.png');
	});

	it('blocks an image over the provider limit, naming it, before writing anything', async () => {
		const { notes } = context;
		await expect(notes.addImage('a.md', image('huge.png', 'image/png', 105 * 1024 * 1024))).rejects.toMatchObject({
			code: ErrorCode.FILE_TOO_LARGE,
			message: expect.stringContaining("GitHub's per-file limit")
		});
		expect(get(notes).entries.map((entry) => entry.path)).not.toContain('assets/huge.png');
	});

	it('refuses a file that is not an allowed image', async () => {
		await expect(context.notes.addImage('a.md', image('page.html', 'text/html'))).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
	});
});

describe('search', () => {
	beforeEach(async () => {
		context = await setUp();
	});

	it('finds text in markdown files with its line, ignoring case and spelling of accents', async () => {
		const { notes } = context;
		expect((await notes.search('dentist')).hits).toEqual([{ path: 'notes/today.md', line: 2, snippet: 'See the Dentist' }]);
		const decomposed = 'TIẾNG VIỆT'.normalize('NFD');
		expect((await notes.search(decomposed)).hits.map((hit) => hit.path)).toEqual(['notes/tiếng việt.md']);
	});

	it('looks only at markdown in the working tree, saved text included', async () => {
		const { notes, repo } = context;
		expect((await notes.search('plain')).hits).toEqual([]);
		await repo.writeFile('fresh.md', 'unicorn\n');
		expect((await notes.search('unicorn')).hits.map((hit) => hit.path)).toEqual(['fresh.md']);
	});

	it('skips a tracked name the engine cannot address, and finds the rest', async () => {
		const { repo, drafts } = context;
		const notes = createNotes({
			repoId: REPO_ID,
			provider: 'github',
			drafts,
			repo: { ...repo, listTree: async () => [...(await repo.listTree()), { path: 'we\\ird.md', size: 4, type: 'file' }] }
		});
		expect((await notes.search('dentist')).hits.map((hit) => hit.path)).toEqual(['notes/today.md']);
	});

	it('finds nothing for a blank query', async () => {
		expect(await context.notes.search('  ')).toEqual({ hits: [], truncated: false });
	});

	it('stops when aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		expect((await context.notes.search('milk', controller.signal)).hits).toEqual([]);
	});

	it('caps hits per file and in total, and shortens long lines around the match', async () => {
		const seed = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`n${index}.md`, 'hit\nhit\nhit\nhit\n']));
		seed['long.md'] = `${'x'.repeat(300)} needle ${'y'.repeat(300)}\n`;
		const { notes } = await setUp(seed);
		const many = await notes.search('hit');
		expect(many.hits).toHaveLength(200);
		expect(many.truncated).toBe(true);
		expect(many.hits.filter((hit) => hit.path === 'n0.md')).toHaveLength(3);
		const [hit] = (await notes.search('needle')).hits;
		expect(hit.snippet).toContain('needle');
		expect(hit.snippet.length).toBeLessThan(170);
	});
});

it('works against a repo a native git can read back', async () => {
	const { notes, repo, remote } = await setUp();
	await notes.open('README.md');
	notes.edit('# From the app\n');
	await notes.save();
	await repo.commit({ paths: ['README.md'], message: 'edit', author: { name: 'A', email: 'a@example.com' } });
	await repo.push();
	expect(await showRemote(remote, 'HEAD:README.md')).toBe('# From the app\n');
});
