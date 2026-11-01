/* global document */
import { expect, test } from '@playwright/test';
import { changeElsewhere, createRemote, pushFromElsewhere, remoteHead, runGit, showRemote } from '../test/remote-repo.js';
import { E2E_GIT_PORT, E2E_GIT_ROOT } from './git-engine-ports.js';
import { collectBreakage, GOOD_TOKEN, serveApi, serveGit } from './provider-fixtures.js';

const SEED = { 'notes/shared.md': 'first line\nsecond line\n', 'notes/other.md': 'other\n', 'zzz.md': 'last\n' };

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Browser} Browser */
/** @typedef {import('../test/remote-repo.js').Remote} Remote */

test.describe.configure({ timeout: 90_000 });

/**
 * @param {Remote} remote
 * @returns {string} the name the provider lists it under
 */
const fullNameOf = (remote) => new URL(remote.url).pathname.slice(1).replace(/\.git$/, '');

/**
 * A device of its own: a fresh browser profile that signs in with a pasted token
 * and clones the repo through the relay, the way a user gets here.
 * @param {Browser} browser
 * @param {Remote} remote
 * @returns {Promise<{ page: Page, context: import('@playwright/test').BrowserContext, problems: string[], open: (path?: string) => Promise<void> }>}
 */
async function openDevice(browser, remote) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const problems = collectBreakage(page);
	const fullName = fullNameOf(remote);
	await serveApi(page, 'github', GOOD_TOKEN, {
		'/user/repos?per_page=100&sort=updated&page=1': [{ id: 41, full_name: fullName, default_branch: 'main', size: 12, private: true }],
		[`/repos/${fullName}/branches?per_page=100&page=1`]: [{ name: 'main' }]
	});
	await serveGit(page, 'github', GOOD_TOKEN);
	await page.goto('/connect');
	const github = page.getByTestId('account-github');
	await github.getByLabel('Or paste a token').fill(GOOD_TOKEN);
	await github.getByRole('button', { name: 'Check and save' }).click();
	await expect(page.getByTestId('account-github-status')).toContainText('octo');
	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByTestId('repo-option').click();
	await page.getByTestId('clone-button').click();
	await expect(page.getByTestId('open-copy')).toBeVisible();
	const id = `github.com/${fullName}`;
	return {
		page,
		context,
		problems,
		open: async (path = '') => {
			await page.goto(`/repo/${encodeURIComponent(id)}/${path.split('/').map(encodeURIComponent).join('/')}`);
			await expect(page.getByTestId('sync-branch')).toHaveText('main');
		}
	};
}

/**
 * @param {Record<string, string>} [files]
 * @returns {Promise<Remote>}
 */
const remoteWith = (files = SEED) => createRemote(files, { root: E2E_GIT_ROOT, port: E2E_GIT_PORT });

/**
 * Replaces the open note's text by typing.
 * @param {Page} page
 * @param {string} text
 * @returns {Promise<void>}
 */
async function typeNote(page, text) {
	await page.getByTestId('note-editor').locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.type(text);
}

/**
 * Opens a note, replaces its text and saves it to the working tree.
 * @param {Page} page
 * @param {string} text
 * @returns {Promise<void>}
 */
async function editAndSave(page, text) {
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await typeNote(page, text);
	await page.getByTestId('save-note').click();
	// The draft goes only once the file is written and flushed.
	await expect(page.getByTestId('unsaved-notes')).toHaveCount(0);
	await expect(page.getByTestId('open-changes')).not.toHaveText('Changes (0)');
}

/**
 * Waits for a file on the remote to reach this text.
 * @param {Remote} remote
 * @param {string} path
 * @param {string} text
 * @returns {Promise<void>}
 */
async function expectOnRemote(remote, path, text) {
	await expect.poll(() => showRemote(remote, `main:${path}`), { timeout: 20_000 }).toBe(text);
}

/**
 * @param {Remote} remote
 * @returns {Promise<string[]>} the parents of `main`'s newest commit
 */
async function remoteParents(remote) {
	return (await runGit(['log', '-1', '--format=%p', 'main'], remote.bare)).trim().split(' ');
}

test('two clones edit one line: the second pull shows the conflict, and its resolution pushes as a merge', async ({ browser }) => {
	const remote = await remoteWith();
	const first = await openDevice(browser, remote);
	const second = await openDevice(browser, remote);

	// The second device opens first, so its pull-on-open finds nothing new.
	await second.open('notes/shared.md');
	await expect(second.page.getByTestId('last-sync')).toContainText('Last sync');

	// The first device then gets there first, with a clean fast-forward push.
	await first.open('notes/shared.md');
	await editAndSave(first.page, 'first line from A\nsecond line\n');
	await first.page.getByTestId('open-changes').click();
	await first.page.getByTestId('commit-push-button').click();
	await expectOnRemote(remote, 'notes/shared.md', 'first line from A\nsecond line\n');
	await expect(first.page.getByTestId('sync-ahead')).toHaveText('0 unpushed commits');

	await pushFromElsewhere(remote, { 'from-elsewhere.md': 'clean half\n' }, 'an unrelated file');
	await editAndSave(second.page, 'first line from B\nsecond line\n');
	await second.page.getByTestId('open-changes').click();
	await second.page.getByTestId('commit-button').click();
	await expect(second.page.getByTestId('sync-ahead')).toHaveText('1 unpushed commit');
	await second.page.getByTestId('pull-button').click();

	const conflict = second.page.getByTestId('conflict-view');
	await expect(conflict).toBeVisible();
	await expect(second.page.getByTestId('conflict-file')).toContainText('notes/shared.md');
	await expect(second.page.getByTestId('conflict-state')).toHaveText('Not resolved');
	await expect(second.page.getByTestId('complete-merge')).toBeDisabled();
	await expect(second.page.getByTestId('pull-button')).toBeDisabled();
	await expect(second.page.getByTestId('push-button')).toBeDisabled();

	// A reload resumes the merge from its stored record, without pulling over it.
	await second.page.reload();
	await expect(conflict).toBeVisible();
	await expect(second.page.getByTestId('conflict-file')).toContainText('notes/shared.md');

	// The file holds markers; the note pane is where they get edited.
	const editor = second.page.getByTestId('note-editor').locator('.cm-content');
	if (!(await editor.isVisible())) await second.page.getByRole('button', { name: 'Edit', exact: true }).click();
	await expect(editor).toContainText('<<<<<<<');

	// Marking it resolved with the markers still in place is refused.
	await second.page.getByTestId('mark-resolved').click();
	await expect(second.page.getByTestId('still-marked')).toBeVisible();
	await expect(second.page.getByTestId('complete-merge')).toBeDisabled();

	await typeNote(second.page, 'first line from both\nsecond line\n');
	await second.page.getByTestId('mark-resolved').click();
	await expect(second.page.getByTestId('conflict-state')).toHaveText('Resolved');
	await second.page.getByTestId('complete-merge').click();
	await expect(conflict).toHaveCount(0);
	await expect(second.page.getByTestId('sync-ahead')).not.toHaveText('0 unpushed commits');

	const before = await remoteHead(remote);
	await second.page.getByTestId('push-button').click();
	await expect(second.page.getByTestId('sync-ahead')).toHaveText('0 unpushed commits');
	expect(await remoteHead(remote)).not.toBe(before);

	// A real merge commit: two parents, the resolution, and the remote's clean half.
	expect(await remoteParents(remote)).toHaveLength(2);
	expect(await showRemote(remote, 'main:notes/shared.md')).toBe('first line from both\nsecond line\n');
	expect(await showRemote(remote, 'main:from-elsewhere.md')).toBe('clean half\n');
	await runGit(['fsck', '--no-progress'], remote.bare);

	// The first device pulls the result with no conflict of its own.
	await first.page.getByTestId('pull-button').click();
	await expect(first.page.getByRole('link', { name: 'from-elsewhere.md' })).toBeVisible();
	await expect(first.page.getByTestId('sync-behind')).toHaveText('0 behind');
	await expect(first.page.getByTestId('conflict-view')).toHaveCount(0);

	expect(first.problems).toEqual([]);
	expect(second.problems).toEqual([]);
	await first.context.close();
	await second.context.close();
});

test('abandoning a merge goes back to the local commit, and a binary or deleted file takes a side', async ({ browser }) => {
	const remote = await remoteWith({ 'clash.md': 'base\n', 'gone.md': 'keep me\n' });
	const { page, context, problems, open } = await openDevice(browser, remote);
	await open('clash.md');
	await editAndSave(page, 'mine\n');
	await page.goto(page.url().replace(/clash\.md$/, 'gone.md'));
	await editAndSave(page, 'mine too\n');
	await page.getByTestId('open-changes').click();
	await page.getByTestId('commit-button').click();
	await expect(page.getByTestId('sync-ahead')).toHaveText('1 unpushed commit');

	await pushFromElsewhere(remote, { 'clash.md': 'theirs\n' }, 'theirs');
	await changeElsewhere(remote, {}, async (work) => {
		await runGit(['rm', '--quiet', 'gone.md'], work);
	});

	await page.getByTestId('pull-button').click();
	await expect(page.getByTestId('conflict-view')).toBeVisible();
	const gone = page.getByTestId('conflict-file').filter({ hasText: 'gone.md' });
	await expect(gone).toContainText('The remote deleted this file');
	await expect(gone.getByTestId('conflict-state')).toHaveText('Not resolved');
	await gone.getByTestId('keep-ours').click();
	await expect(gone.getByTestId('conflict-state')).toHaveText('Resolved');

	await page.getByTestId('abort-merge').click();
	await page.getByTestId('abort-confirm').click();
	await expect(page.getByTestId('conflict-view')).toHaveCount(0);
	await expect(page.getByTestId('sync-ahead')).toHaveText('1 unpushed commit');
	await expect(page.getByTestId('open-changes')).toHaveText('Changes (0)');

	expect(problems).toEqual([]);
	await context.close();
});

test('a damaged merge record offers a reset, and the app works again', async ({ browser }) => {
	const remote = await remoteWith({ 'clash.md': 'base\n' });
	const { page, context, open } = await openDevice(browser, remote);
	await open('clash.md');
	await editAndSave(page, 'mine\n');
	await page.getByTestId('open-changes').click();
	await page.getByTestId('commit-button').click();
	await expect(page.getByTestId('sync-ahead')).toHaveText('1 unpushed commit');
	await pushFromElsewhere(remote, { 'clash.md': 'theirs\n' }, 'theirs');
	await page.getByTestId('pull-button').click();
	await expect(page.getByTestId('conflict-view')).toBeVisible();

	// The record's bytes live in LightningFS's block store, keyed by inode.
	await page.evaluate(async () => {
		const databases = await globalThis.indexedDB.databases();
		const name = databases.map((database) => database.name).find((item) => item?.startsWith('gitnote:') && !item.endsWith('_lock'));
		if (!name) throw new Error('no repo database');
		const db = await new Promise((resolve, reject) => {
			const opening = globalThis.indexedDB.open(name);
			opening.onerror = () => reject(opening.error);
			opening.onsuccess = () => resolve(opening.result);
		});
		const store = db.transaction(db.objectStoreNames[0], 'readwrite').objectStore(db.objectStoreNames[0]);
		const keys = await new Promise((resolve, reject) => {
			const all = store.getAllKeys();
			all.onerror = () => reject(all.error);
			all.onsuccess = () => resolve(all.result);
		});
		const tree = await new Promise((resolve, reject) => {
			const root = store.get('!root');
			root.onerror = () => reject(root.error);
			root.onsuccess = () => resolve(root.result);
		});
		/** @type {number | undefined} */
		let inode;
		/**
		 * @param {Map<string, unknown>} folder
		 * @returns {void}
		 */
		const visit = (folder) => {
			for (const [entry, value] of folder) {
				if (entry === 'gitnote-merge.json') inode = /** @type {Map<number, { ino: number }>} */ (value).get(0)?.ino;
				else if (value instanceof Map) visit(/** @type {Map<string, unknown>} */ (value));
			}
		};
		visit(tree);
		if (inode === undefined || !keys.includes(inode)) throw new Error('no merge record');
		const writing = db.transaction(db.objectStoreNames[0], 'readwrite');
		writing.objectStore(db.objectStoreNames[0]).put(new TextEncoder().encode('not json'), inode);
		await new Promise((resolve, reject) => {
			writing.oncomplete = resolve;
			writing.onerror = () => reject(writing.error);
		});
		db.close();
	});
	await page.reload();

	await expect(page.getByTestId('merge-damaged')).toBeVisible();
	await page.getByTestId('reset-merge').click();
	await expect(page.getByTestId('merge-damaged')).toHaveCount(0);
	await expect(page.getByTestId('open-changes')).toContainText('Changes (');
	await page.getByTestId('open-changes').click();
	await expect(page.getByTestId('changed-file').filter({ hasText: 'clash.md' })).toBeVisible();
	await context.close();
});

test('the commit panel stages per file, shows the diff, prefills the message and discards', async ({ browser }) => {
	const remote = await remoteWith();
	const { page, context, problems, open } = await openDevice(browser, remote);
	await open('notes/shared.md');
	await editAndSave(page, 'first line changed\nsecond line\n');
	await page.goto(page.url().replace(/shared\.md$/, 'other.md'));
	await editAndSave(page, 'other changed\n');

	await page.getByTestId('open-changes').click();
	const files = page.getByTestId('changed-file');
	await expect(files).toHaveCount(2);
	await expect(page.getByTestId('commit-message')).toHaveValue('Update notes/other.md, notes/shared.md');

	// The diff shows both sides of the change as text.
	const shared = files.filter({ hasText: 'notes/shared.md' });
	await shared.getByTestId('toggle-diff').click();
	await expect(shared.locator('[data-diff="removed"]')).toContainText('first line');
	await expect(shared.locator('[data-diff="added"]')).toContainText('first line changed');

	// Unchecking leaves the file out of the commit and out of the message.
	await files.filter({ hasText: 'notes/other.md' }).getByRole('checkbox').uncheck();
	await expect(page.getByTestId('commit-message')).toHaveValue('Update notes/shared.md');
	await page.getByTestId('commit-message').fill('my own message');
	await page.getByTestId('commit-button').click();
	await expect(files).toHaveCount(1);
	await expect(page.getByTestId('sync-ahead')).toHaveText('1 unpushed commit');

	// Pulling now is held back, with a way to the changes.
	await page.getByTestId('pull-button').click();
	await expect(page.getByTestId('pull-held-back')).toBeVisible();

	// Discard asks first, then takes the file back to its commit.
	await files.getByRole('checkbox').check();
	await page.getByTestId('discard-changes').click();
	await page.getByTestId('discard-confirm-changes').click();
	await expect(page.getByTestId('no-changes')).toBeVisible();
	await expect(page.getByTestId('pull-held-back')).toHaveCount(0);

	// The sign-out warning counts the real commit.
	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByRole('link', { name: 'Accounts' }).click();
	await page.getByTestId('account-github').getByRole('button', { name: 'Sign out' }).click();
	await expect(page.getByTestId('sign-out-work')).toContainText('1 unpushed commit, 0 uncommitted files');

	const log = await runGit(['log', '-1', '--format=%s', 'main'], remote.bare);
	expect(log.trim()).toBe('seed');
	expect(problems).toEqual([]);
	await context.close();
});

test('unsaved text is called out, and Save all brings it into the commit', async ({ browser }) => {
	const remote = await remoteWith();
	const { page, context, open } = await openDevice(browser, remote);
	await open('notes/shared.md');
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await typeNote(page, 'not saved yet\n');
	await expect(page.getByTestId('unsaved-notes')).toContainText('1 note has unsaved text');

	await page.getByTestId('open-changes').click();
	await expect(page.getByTestId('commit-unsaved')).toContainText('notes/shared.md');
	await expect(page.getByTestId('no-changes')).toBeVisible();

	await page.getByTestId('save-all-drafts').click();
	await expect(page.getByTestId('changed-file')).toContainText('notes/shared.md');
	await expect(page.getByTestId('commit-unsaved')).toHaveCount(0);
	await context.close();
});

test('a push made offline waits, says so, and goes when the network returns', async ({ browser }) => {
	const remote = await remoteWith();
	const { page, context, problems, open } = await openDevice(browser, remote);
	await open('notes/shared.md');
	await editAndSave(page, 'written offline\nsecond line\n');
	const head = await remoteHead(remote);

	await context.setOffline(true);
	await expect(page.getByTestId('offline-badge')).toBeVisible();
	await page.getByTestId('open-changes').click();
	await page.getByTestId('commit-push-button').click();
	await expect(page.getByTestId('push-pending')).toBeVisible();
	await expect(page.getByTestId('sync-ahead')).toHaveText('1 unpushed commit');
	expect(await remoteHead(remote)).toBe(head);

	await context.setOffline(false);
	await expectOnRemote(remote, 'notes/shared.md', 'written offline\nsecond line\n');
	await expect(page.getByTestId('push-pending')).toHaveCount(0);
	await expect(page.getByTestId('sync-ahead')).toHaveText('0 unpushed commits');
	await expect(page.getByTestId('offline-badge')).toHaveCount(0);
	expect(problems).toEqual([]);
	await context.close();
});

test('settings set the commit author and keep autosave off until it is chosen', async ({ browser }) => {
	const remote = await remoteWith();
	const { page, context, problems, open } = await openDevice(browser, remote);
	await page.goto('/settings');
	await expect(page.getByTestId('author-fallback')).toContainText('Octo <octo@users.noreply.github.com>');
	await expect(page.getByTestId('autosave-toggle')).not.toBeChecked();
	await expect(page.getByTestId('autosave-interval')).toHaveValue('5');
	await expect(page.getByTestId('autosave-interval')).toBeDisabled();
	await expect(page.getByText('Beta', { exact: true })).toBeVisible();
	await expect(page.getByTestId('autosave-interval').locator('option')).toHaveText(['1 minute', '5 minutes', '10 minutes', '30 minutes']);

	await page.getByTestId('author-name').fill('Bad <name>');
	await page.getByTestId('settings-save').click();
	await expect(page.getByTestId('settings-error')).toBeVisible();

	await page.getByTestId('author-name').fill('Chosen Name');
	await page.getByTestId('author-email').fill('chosen@example.com');
	await page.getByTestId('settings-save').click();
	await expect(page.getByTestId('settings-saved')).toBeVisible();
	await page.reload();
	await expect(page.getByTestId('author-name')).toHaveValue('Chosen Name');

	await open('notes/shared.md');
	await expect(page.getByTestId('autosave-badge')).toHaveCount(0);
	await editAndSave(page, 'authored\nsecond line\n');
	await page.getByTestId('open-changes').click();
	await page.getByTestId('commit-push-button').click();
	await expectOnRemote(remote, 'notes/shared.md', 'authored\nsecond line\n');
	const author = await runGit(['log', '-1', '--format=%an <%ae>', 'main'], remote.bare);
	expect(author.trim()).toBe('Chosen Name <chosen@example.com>');
	expect(problems).toEqual([]);
	await context.close();
});

test('an author git cannot record is refused, and with no author at all the panel asks for one', async ({ browser }) => {
	const remote = await remoteWith();
	const { page, context, open } = await openDevice(browser, remote);
	await page.evaluate(() => globalThis.localStorage.setItem('gitnote.settings', JSON.stringify({ authorName: 'Me', authorEmail: 'bad\nmail', autosave: false, intervalMinutes: 5 })));
	await open('notes/shared.md');
	await editAndSave(page, 'edited\nsecond line\n');
	await page.getByTestId('open-changes').click();
	await page.getByTestId('commit-button').click();
	await expect(page.getByTestId('sync-report')).toContainText('line breaks');
	await expect(page.getByTestId('sync-ahead')).toHaveText('0 unpushed commits');

	// Signed out, with nothing in the settings, there is nobody to name.
	await page.evaluate(() => globalThis.localStorage.removeItem('gitnote.settings'));
	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByRole('link', { name: 'Accounts' }).click();
	await page.getByTestId('account-github').getByRole('button', { name: 'Sign out' }).click();
	await page.getByTestId('sign-out-github').getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page.getByTestId('account-github').getByLabel('Or paste a token')).toBeVisible();
	await open('notes/shared.md');
	await page.getByTestId('open-changes').click();
	await expect(page.getByTestId('commit-needs-author')).toBeVisible();
	await expect(page.getByTestId('commit-button')).toBeDisabled();
	await context.close();
});

test('autosave commits and pushes on its timer, commits locally when hidden and pushes on return', async ({ browser }) => {
	const remote = await remoteWith();
	const { page, context, problems, open } = await openDevice(browser, remote);
	await page.goto('/settings');
	await page.getByTestId('autosave-toggle').check();
	await page.getByTestId('autosave-interval').selectOption('1');
	await page.getByTestId('settings-save').click();
	await expect(page.getByTestId('settings-saved')).toBeVisible();

	await page.clock.install();
	await open('notes/shared.md');
	await expect(page.getByTestId('autosave-badge')).toContainText('Autosave on');
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await typeNote(page, 'typed, never saved\nsecond line\n');
	await expect(page.getByTestId('unsaved-notes')).toBeVisible();

	// Unsaved text counts: the timer saves it, commits it, pulls and pushes.
	await page.clock.runFor(60_000);
	await expect.poll(() => showRemote(remote, 'main:notes/shared.md'), { timeout: 20_000 }).toBe('typed, never saved\nsecond line\n');
	expect((await runGit(['log', '-1', '--format=%s', 'main'], remote.bare)).trim()).toBe('autosave: notes/shared.md');
	await expect(page.getByTestId('sync-ahead')).toHaveText('0 unpushed commits');

	// With nothing changed, a tick makes no commit.
	const quiet = await remoteHead(remote);
	await page.clock.runFor(60_000);
	await expect(page.getByTestId('sync-ahead')).toHaveText('0 unpushed commits');
	expect(await remoteHead(remote)).toBe(quiet);

	// Going hidden commits on the device and sends nothing.
	await typeNote(page, 'typed before hiding\nsecond line\n');
	await expect(page.getByTestId('unsaved-notes')).toBeVisible();
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
		document.dispatchEvent(new globalThis.Event('visibilitychange'));
	});
	await expect(page.getByTestId('sync-ahead')).toHaveText('1 unpushed commit');
	expect(await remoteHead(remote)).toBe(quiet);

	// Coming back pushes it.
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
		document.dispatchEvent(new globalThis.Event('visibilitychange'));
	});
	await expect.poll(() => showRemote(remote, 'main:notes/shared.md'), { timeout: 20_000 }).toBe('typed before hiding\nsecond line\n');
	expect(problems).toEqual([]);
	await context.close();
});

test('autosave stops at a conflict instead of committing over it', async ({ browser }) => {
	const remote = await remoteWith();
	const { page, context, open } = await openDevice(browser, remote);
	await page.goto('/settings');
	await page.getByTestId('autosave-toggle').check();
	await page.getByTestId('autosave-interval').selectOption('1');
	await page.getByTestId('settings-save').click();

	await page.clock.install();
	await open('notes/shared.md');
	await expect(page.getByTestId('autosave-badge')).toContainText('Autosave on');
	await pushFromElsewhere(remote, { 'notes/shared.md': 'first line from elsewhere\nsecond line\n' }, 'elsewhere');
	const head = await remoteHead(remote);

	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await typeNote(page, 'first line here\nsecond line\n');
	await expect(page.getByTestId('unsaved-notes')).toBeVisible();
	await page.clock.runFor(60_000);

	await expect(page.getByTestId('conflict-view')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('autosave-badge')).toContainText('stopped until the merge is done');
	await page.clock.runFor(180_000);
	expect(await remoteHead(remote)).toBe(head);
	await expect(page.getByTestId('sync-ahead')).toHaveText('1 unpushed commit');
	await context.close();
});
