/* global DataTransfer, ClipboardEvent, IDBObjectStore, indexedDB, window, document */
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRouteId } from '../src/lib/git/repo-route.js';
import { changeElsewhere, createRemote, pushFromElsewhere, remoteHead, runGit } from '../test/remote-repo.js';
import { E2E_GIT_PORT, E2E_GIT_ROOT } from './git-engine-ports.js';
import { collectBreakage, GOOD_TOKEN, serveApi, serveGit } from './provider-fixtures.js';
import { STATIC_SHELL_PORT } from './static-server.js';

/** A real 1x1 PNG, so the browser's decoder proves a `blob:` URL really loaded. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** A real 2x1 PNG, told apart from {@link PIXEL} by its decoded width. */
const WIDE_PIXELS = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=', 'base64');

const WELCOME = `---
title: hidden front matter
---
# Welcome

- [x] done task
- [ ] open task

| Left | Right |
| :--- | ---: |
| 1 | 2 |

![pixel](./assets/pixel.png)

![broken](./page.html)

[other note](./other%20note.md)

[raw file](./data.bin)

<script>window.noteScriptRan = true</script>
`;

/**
 * Apart from this note, no test expects a policy complaint: some Chromium versions
 * log one when sanitizing parses a handler, even though the handler never runs.
 */
const HOSTILE = '# Hostile\n\n<img src="nope.png" onerror="window.noteScriptRan = true">\n\n<a href="#x" onclick="window.noteScriptRan = true">click</a>\n';

const SEED = {
	'README.md': '# Top\n',
	'notes/welcome.md': WELCOME,
	'notes/other note.md': '# Other\n\nA needle in the note.\n',
	'notes/page.html': '<script>window.noteScriptRan = true</script>',
	'notes/raw.txt': 'plain text\n',
	'notes/z-crlf.md': 'one\r\ntwo\r\n',
	'notes/z-hostile.md': HOSTILE,
	'notes/z-toc.md': `# Contents\n\n[jump](#far-away)\n\n<dialog open><a href="https://example.com/login">Session expired</a></dialog>\n\n${'filler\n\n'.repeat(200)}## Far away\n`,
	'zzz.md': '# Last\n'
};

/**
 * Clones a real repo through the relay with a pasted token, the way a user gets
 * here, then leaves the page on the repo list.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ fullName: string, remote: import('../test/remote-repo.js').Remote, id: string }>}
 */
async function cloneRepo(page) {
	const remote = await createRemote(SEED, { root: E2E_GIT_ROOT, port: E2E_GIT_PORT });
	await pushFromElsewhere(remote, { 'notes/assets/pixel.png': PIXEL, 'notes/data.bin': Buffer.from([0, 1, 2, 0, 3]) }, 'add binary files');
	await changeElsewhere(remote, {}, async (work) => {
		await symlink('other note.md', path.join(work, 'notes/z-link.md'));
		await runGit(['add', 'notes/z-link.md'], work);
	});
	const fullName = new URL(remote.url).pathname.slice(1).replace(/\.git$/, '');
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
	return { fullName, remote, id: `github.com/${fullName}` };
}

/**
 * @param {string} id
 * @param {string} [path]
 * @returns {string} the app's URL for a file
 */
const noteUrl = (id, path = '') => `/repo/${repoRouteId(id)}/${path.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Replaces the whole note in the editor by typing.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 * @returns {Promise<void>}
 */
async function typeNote(page, text) {
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByTestId('note-editor').locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.type(text);
}

/**
 * Delivers a text paste to the editor the way the browser does.
 * @param {import('@playwright/test').Locator} content
 * @param {string} text
 * @returns {Promise<void>}
 */
async function pasteText(content, text) {
	await content.evaluate((node, pasted) => {
		const data = new DataTransfer();
		data.setData('text/plain', pasted);
		node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	}, text);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ path: string, text: string }[]>} every draft on this device
 */
function storedDrafts(page) {
	return page.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const open = indexedDB.open('gitnote-drafts');
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const all = open.result.transaction('drafts').objectStore('drafts').getAll();
					all.onerror = () => reject(all.error);
					all.onsuccess = () => {
						open.result.close();
						resolve(all.result);
					};
				};
			})
	);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @returns {Promise<string | undefined>} the text of the draft kept for a path
 */
async function draftText(page, path) {
	return (await storedDrafts(page)).find((draft) => draft.path === path)?.text;
}

test.describe.configure({ timeout: 90_000 });

test('opens a note from the tree, rendered, safe, under the production CSP', async ({ page }) => {
	const problems = collectBreakage(page);
	await cloneRepo(page);

	await page.getByTestId('open-copy').click();
	await expect(page).toHaveURL(/\/repo\/github\.com~/);
	const drawer = page.getByTestId('file-drawer');
	const files = drawer.getByTestId('tree-file');

	// Folders first, then markdown, then the rest; git's own folder never shows.
	await expect(drawer.getByTestId('tree-folder')).toHaveText(['▸ notes']);
	await expect(files).toHaveText(['README.md', 'zzz.md']);
	await drawer.getByRole('button', { name: 'notes', exact: true }).click();
	await expect(files.first()).toHaveText('other note.md');
	await expect(drawer).not.toContainText('.git');

	await drawer.getByRole('link', { name: 'welcome.md' }).click();
	const preview = page.getByTestId('note-preview');
	await expect(preview.getByRole('heading', { name: 'Welcome' })).toBeVisible();
	await expect(preview).not.toContainText('hidden front matter');
	await expect(preview.locator('input[type="checkbox"]')).toHaveCount(2);
	await expect(preview.locator('input[type="checkbox"]').first()).toBeChecked();
	await expect(preview.locator('table td')).toHaveText(['1', '2']);

	// A real image decoded from a real blob URL; a page never becomes one.
	const image = preview.getByRole('img', { name: 'pixel' });
	await expect(image).toHaveAttribute('src', /^blob:/);
	await expect.poll(() => image.evaluate((node) => /** @type {HTMLImageElement} */ (node).naturalWidth)).toBe(1);
	await expect(preview.getByRole('img', { name: 'broken' })).not.toHaveAttribute('src', /./);

	expect(await page.evaluate(() => Reflect.get(globalThis, 'noteScriptRan'))).toBeUndefined();
	expect(await preview.innerHTML()).not.toMatch(/onerror|<script/);

	// A relative link opens in the app, with no page load.
	await page.evaluate(() => Reflect.set(globalThis, 'samePage', true));
	await preview.getByRole('link', { name: 'other note' }).click();
	await expect(page.getByTestId('note-path')).toHaveText('notes/other note.md');
	expect(await page.evaluate(() => Reflect.get(globalThis, 'samePage'))).toBe(true);
	await page.goBack();
	await expect(page.getByTestId('note-path')).toHaveText('notes/welcome.md');

	// Non-markdown files.
	await preview.getByRole('link', { name: 'raw file' }).click();
	await expect(page.getByTestId('binary-file')).toContainText('5 B');
	await drawer.getByRole('link', { name: 'raw.txt' }).click();
	await expect(page.getByTestId('raw-text')).toHaveText('plain text');
	await drawer.getByRole('button', { name: 'assets', exact: true }).click();
	await drawer.getByRole('link', { name: 'pixel.png' }).click();
	await expect.poll(() => page.getByTestId('image-preview').evaluate((node) => /** @type {HTMLImageElement} */ (node).naturalWidth)).toBe(1);

	// The tree's filter.
	await page.getByTestId('tree-filter').fill('OTHER');
	await expect(page.getByTestId('tree-file')).toHaveText(['other note.md']);
	await page.getByTestId('tree-filter').fill('');

	expect(problems).toEqual([]);
});

test('a note with event handlers runs nothing, and keeps none in its output', async ({ page }) => {
	const problems = collectBreakage(page);
	const { id } = await cloneRepo(page);
	await page.goto(noteUrl(id, 'notes/z-hostile.md'));
	const preview = page.getByTestId('note-preview');
	await expect(preview.getByRole('heading', { name: 'Hostile' })).toBeVisible();
	await preview.getByText('click').click();

	expect(await page.evaluate(() => Reflect.get(globalThis, 'noteScriptRan'))).toBeUndefined();
	expect(await preview.innerHTML()).not.toMatch(/onerror|onclick/);
	expect(problems.filter((problem) => !/inline event handler/.test(problem))).toEqual([]);
});

test('text the browser refuses to store stays through moving between notes, and leaving asks first', async ({ page }) => {
	const { id } = await cloneRepo(page);
	await page.addInitScript(() => {
		const put = IDBObjectStore.prototype.put;
		/**
		 * @this {IDBObjectStore}
		 * @param {unknown} value
		 * @param {IDBValidKey} [key]
		 * @returns {IDBRequest<IDBValidKey>}
		 */
		IDBObjectStore.prototype.put = function refuseDrafts(value, key) {
			if (this.name === 'drafts') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
			return put.call(this, value, key);
		};
	});
	await page.goto(noteUrl(id, 'README.md'));
	const drawer = page.getByTestId('file-drawer');
	await typeNote(page, 'refused words');
	await expect(page.getByTestId('draft-failed')).toBeVisible();

	// Another note keeps saying so, and the text is there on the way back.
	await drawer.getByRole('link', { name: 'zzz.md' }).click();
	await expect(page.getByTestId('note-path')).toHaveText('zzz.md');
	await expect(page.getByTestId('unkept-drafts')).toContainText('README.md');
	await expect(drawer.getByTestId('tree-unsaved')).toHaveCount(1);
	await page.getByTestId('unkept-drafts').getByRole('link', { name: 'README.md' }).click();
	const content = page.getByTestId('note-editor').locator('.cm-content');
	await expect(content).toContainText('refused words');
	await expect(page.getByTestId('draft-failed')).toBeVisible();

	// Leaving the repository asks, and staying keeps the text.
	/** @type {string[]} */
	const asked = [];
	const refuseOnce = (/** @type {import('@playwright/test').Dialog} */ dialog) => {
		asked.push(dialog.type());
		void dialog.dismiss();
	};
	page.once('dialog', refuseOnce);
	await page.getByRole('link', { name: 'Repositories' }).click();
	await expect.poll(() => asked).toEqual(['confirm']);
	await expect(content).toContainText('refused words');

	// So does leaving the page.
	const unload = page.waitForEvent('dialog');
	void page.close({ runBeforeUnload: true });
	const prompt = await unload;
	expect(prompt.type()).toBe('beforeunload');
	await prompt.dismiss();
	await expect(content).toContainText('refused words');

	// Saving ends all of it.
	await page.getByTestId('save-note').click();
	await expect(page.getByTestId('dirty-indicator')).toHaveText('Saved to the working tree');
	await expect(page.getByTestId('draft-failed')).toHaveCount(0);
	await page.getByRole('link', { name: 'Repositories' }).click();
	await expect(page.getByTestId('local-copy')).toBeVisible();
});

test('the image viewer shows the new picture when the file at its path is replaced', async ({ page, context }) => {
	const { id } = await cloneRepo(page);
	await page.goto(noteUrl(id, 'notes/assets/pixel.png'));
	const image = page.getByTestId('image-preview');
	await expect.poll(() => image.evaluate((node) => /** @type {HTMLImageElement} */ (node).naturalWidth)).toBe(1);

	const other = await context.newPage();
	await other.goto(noteUrl(id, 'notes/other note.md'));
	await other.getByRole('button', { name: 'Edit', exact: true }).click();
	await other.getByTestId('image-picker').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: WIDE_PIXELS });
	await expect(other.getByTestId('note-editor').locator('.cm-content')).toContainText('wide.png');
	const drawer = other.getByTestId('file-drawer');
	const moveTo = async (/** @type {string} */ name, /** @type {string} */ to) => {
		await drawer.getByRole('button', { name: `Actions for ${name}` }).click();
		await drawer.getByRole('button', { name: 'Rename or move' }).click();
		await other.getByTestId('dialog-path').fill(to);
		await other.getByTestId('dialog-confirm').click();
		await expect(other.getByTestId('notes-dialog')).not.toBeVisible();
	};
	await drawer.getByRole('button', { name: 'assets', exact: true }).click();
	await moveTo('pixel.png', 'notes/assets/old.png');
	await moveTo('wide.png', 'notes/assets/pixel.png');
	await other.close();

	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect.poll(() => image.evaluate((node) => /** @type {HTMLImageElement} */ (node).naturalWidth)).toBe(2);
});

test('a symbolic link says what it is, and is not followed', async ({ page }) => {
	const { id } = await cloneRepo(page);
	await page.goto(noteUrl(id, 'notes/z-link.md'));
	await expect(page.getByTestId('symlink-file')).toBeVisible();
	await expect(page.getByTestId('file-drawer').getByRole('link', { name: 'z-link.md' })).toBeVisible();
	await expect(page.getByTestId('missing-file')).toHaveCount(0);
	await expect(page.getByTestId('note-preview')).toHaveCount(0);
});

test('an edited buffer survives a reload, saves to the working tree only, and can be discarded', async ({ page }) => {
	const problems = collectBreakage(page);
	const { remote, id } = await cloneRepo(page);
	const headBefore = await remoteHead(remote);

	await page.goto(noteUrl(id, 'README.md'));
	await expect(page.getByTestId('note-preview').getByRole('heading', { name: 'Top' })).toBeVisible();
	await typeNote(page, '# Typed\n\nnever saved');

	const indicator = page.getByTestId('dirty-indicator');
	await expect(indicator).toHaveText('Unsaved, kept on this device');
	await expect(page.getByTestId('tree-unsaved')).toHaveCount(1);

	// The reload loses nothing, and comes back ready to keep typing.
	await page.reload();
	const content = page.getByTestId('note-editor').locator('.cm-content');
	await expect(content).toContainText('never saved');
	await expect(page.getByTestId('draft-restored')).toBeVisible();
	await expect(indicator).toHaveText('Unsaved, kept on this device');

	// Also from another note and back.
	await page.getByTestId('file-drawer').getByRole('link', { name: 'zzz.md' }).click();
	await expect(page.getByTestId('note-preview').getByRole('heading', { name: 'Last' })).toBeVisible();
	await page.getByTestId('file-drawer').getByRole('link', { name: 'README.md' }).click();
	await expect(content).toContainText('never saved');

	// Saving with the keyboard writes the file, and leaves no draft to restore.
	await content.click();
	await page.keyboard.press('ControlOrMeta+S');
	await expect(indicator).toHaveText('Saved to the working tree');
	await expect(page.getByTestId('tree-unsaved')).toHaveCount(0);
	await page.reload();
	await expect(page.getByTestId('note-preview').getByRole('heading', { name: 'Typed' })).toBeVisible();
	await expect(page.getByTestId('draft-restored')).toHaveCount(0);

	// Nothing reached the remote.
	expect(await remoteHead(remote)).toBe(headBefore);

	// Discard goes back to the file.
	await typeNote(page, 'throw this away');
	await expect(indicator).toHaveText('Unsaved, kept on this device');
	await page.getByTestId('discard-note').click();
	await page.getByTestId('discard-confirm').click();
	await expect(content).toContainText('never saved');
	await page.reload();
	await expect(page.getByTestId('note-preview')).toContainText('never saved');
	await expect(page.getByTestId('draft-restored')).toHaveCount(0);

	expect(problems).toEqual([]);
});

test('split view previews while typing on a wide screen', async ({ page }) => {
	const problems = collectBreakage(page);
	const { id } = await cloneRepo(page);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(noteUrl(id, 'notes/welcome.md'));
	await page.getByRole('button', { name: 'Split' }).click();
	const preview = page.getByTestId('note-preview');
	await expect(preview.getByRole('img', { name: 'pixel' })).toHaveAttribute('src', /^blob:/);
	await expect(page.getByTestId('note-editor')).toBeVisible();
	await page.getByTestId('note-editor').locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('\n\n## Live heading\n');
	await expect(preview.getByRole('heading', { name: 'Live heading' })).toBeVisible();
	await expect(preview.getByRole('img', { name: 'pixel' })).toHaveAttribute('src', /^blob:/);
	expect(problems).toEqual([]);
});

test('creates, renames, moves and deletes, with no commit made', async ({ page }) => {
	const problems = collectBreakage(page);
	const { id, remote } = await cloneRepo(page);
	const headBefore = await remoteHead(remote);
	await page.goto(noteUrl(id));
	const drawer = page.getByTestId('file-drawer');
	await expect(page.getByTestId('no-note')).toBeVisible();

	/**
	 * @param {string} value
	 * @returns {Promise<void>}
	 */
	const answer = async (value) => {
		await page.getByTestId('dialog-path').fill(value);
		await page.getByTestId('dialog-confirm').click();
	};

	// A new note opens ready to type in.
	await page.getByTestId('new-note').click();
	await answer('ideas/first idea');
	await expect(page.getByTestId('note-path')).toHaveText('ideas/first idea.md');
	await expect(page.getByTestId('note-editor')).toBeVisible();
	await page.getByTestId('note-editor').locator('.cm-content').click();
	await page.keyboard.type('# First idea');
	await page.getByTestId('save-note').click();
	await expect(page.getByTestId('dirty-indicator')).toHaveText('Saved to the working tree');

	// It never overwrites an existing file, and git's folder is out of reach.
	await page.getByTestId('new-note').click();
	await answer('only/a/folder/');
	await expect(page.getByTestId('dialog-error')).toContainText('Give the note a name');
	await answer('README.md');
	await expect(page.getByTestId('dialog-error')).toContainText('already exists');
	await answer('.git/evil');
	await expect(page.getByTestId('dialog-error')).toContainText('not a valid file path');
	await page.getByRole('button', { name: 'Cancel' }).click();

	// A new folder shows through its placeholder.
	await page.getByTestId('new-folder').click();
	await answer('archive');
	await expect(drawer.getByRole('button', { name: 'archive', exact: true })).toBeVisible();

	// Move the open note; the page follows it.
	await drawer.getByRole('button', { name: 'Actions for first idea.md' }).click();
	await drawer.getByRole('button', { name: 'Rename or move' }).click();
	await answer('archive/moved.md');
	await expect(page.getByTestId('note-path')).toHaveText('archive/moved.md');
	await expect(page.getByTestId('note-preview').getByRole('heading', { name: 'First idea' })).toBeVisible();

	// Rename a folder; the open note inside it follows.
	await drawer.getByRole('button', { name: 'Actions for archive' }).click();
	await drawer.getByRole('button', { name: 'Rename or move' }).click();
	await answer('old');
	await expect(page.getByTestId('note-path')).toHaveText('old/moved.md');

	// Delete warns about unsaved text in the folder, then closes the note.
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByTestId('note-editor').locator('.cm-content').click();
	await page.keyboard.type('unsaved words ');
	await expect(page.getByTestId('dirty-indicator')).toHaveText('Unsaved, kept on this device');
	await drawer.getByRole('button', { name: 'Actions for old' }).click();
	await drawer.getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByTestId('delete-unsaved')).toContainText('1 unsaved note');
	await page.getByTestId('dialog-confirm').click();
	await expect(page.getByTestId('no-note')).toBeVisible();
	await expect(drawer.getByRole('button', { name: 'old', exact: true })).toHaveCount(0);

	// All of that survives a reload, as working-tree state.
	await page.reload();
	await expect(drawer.getByTestId('tree-file').first()).toBeVisible();
	await expect(drawer.getByRole('button', { name: 'old', exact: true })).toHaveCount(0);
	await expect(page.getByTestId('tree-unsaved')).toHaveCount(0);

	// A link to a note not there yet offers to create it.
	await page.goto(noteUrl(id, 'later/soon.md'));
	await page.getByRole('button', { name: 'Create this note' }).click();
	await expect(page.getByTestId('note-editor')).toBeVisible();
	await expect(drawer.getByRole('link', { name: 'soon.md' })).toBeVisible();

	// Only that first opening starts in the editor; coming back starts in read mode.
	await drawer.getByRole('link', { name: 'zzz.md' }).click();
	await expect(page.getByTestId('note-path')).toHaveText('zzz.md');
	await drawer.getByRole('link', { name: 'soon.md' }).click();
	await expect(page.getByTestId('note-path')).toHaveText('later/soon.md');
	await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('note-editor')).toHaveCount(0);

	// Moving a note onto its own path changes nothing.
	await drawer.getByRole('button', { name: 'Actions for soon.md' }).click();
	await drawer.getByRole('button', { name: 'Rename or move' }).click();
	await page.getByTestId('dialog-confirm').click();
	await expect(page.getByTestId('notes-dialog')).not.toBeVisible();
	await expect(page.getByTestId('note-path')).toHaveText('later/soon.md');
	await expect(drawer.getByRole('link', { name: 'soon.md' })).toBeVisible();

	// A dot in a name does not stop it being a note.
	await page.getByTestId('new-note').click();
	await answer('meeting 11.01');
	await expect(page.getByTestId('note-path')).toHaveText('meeting 11.01.md');
	await expect(page.getByRole('button', { name: 'Split' })).toBeAttached();

	expect(await remoteHead(remote)).toBe(headBefore);
	expect(problems).toEqual([]);
});

test('adds images by picking and pasting, and searches note text', async ({ page }) => {
	const problems = collectBreakage(page);
	const { id } = await cloneRepo(page);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(noteUrl(id, 'notes/other note.md'));
	await page.getByRole('button', { name: 'Split' }).click();
	const preview = page.getByTestId('note-preview');

	await page.getByTestId('image-picker').setInputFiles({ name: 'my cat.png', mimeType: 'image/png', buffer: PIXEL });
	const content = page.getByTestId('note-editor').locator('.cm-content');
	await expect(content).toContainText('![my-cat](./assets/my-cat.png)');
	const picked = preview.getByRole('img', { name: 'my-cat' });
	await expect.poll(() => picked.evaluate((node) => /** @type {HTMLImageElement} */ (node).naturalWidth)).toBe(1);
	await page.getByTestId('file-drawer').getByRole('button', { name: 'assets', exact: true }).click();
	await expect(page.getByTestId('file-drawer').getByRole('link', { name: 'my-cat.png' })).toBeVisible();

	// A paste, the way the browser delivers one.
	await content.click();
	await content.evaluate((node, base64) => {
		const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
		const data = new DataTransfer();
		data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
		node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	}, PIXEL.toString('base64'));
	await expect(content).toContainText(/!\[pasted-\d{14}\]\(\.\/assets\/pasted-\d{14}\.png\)/);
	await expect(preview.getByRole('img', { name: /^pasted-/ })).toHaveAttribute('src', /^blob:/);

	// A type outside the allowlist is refused, with a reason.
	await page.getByTestId('image-picker').setInputFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<script></script>') });
	await expect(page.getByTestId('workspace-report')).toContainText('Only PNG');

	// Search reads the working tree's markdown.
	await page.getByTestId('note-search').fill('NEEDLE');
	await page.getByTestId('note-search-button').click();
	const hit = page.getByTestId('search-hit');
	await expect(hit).toHaveCount(1);
	await expect(hit).toContainText('notes/other note.md:3');
	await page.getByTestId('note-search').fill('no such words anywhere');
	await page.getByTestId('note-search-button').click();
	await expect(page.getByTestId('search-results')).toContainText('Nothing found');

	expect(problems).toEqual([]);
});

test('a note links to its own headings, and cannot cover the app', async ({ page }) => {
	const problems = collectBreakage(page);
	const { id } = await cloneRepo(page);
	await page.goto(noteUrl(id, 'notes/z-toc.md'));
	const preview = page.getByTestId('note-preview');
	const far = preview.getByRole('heading', { name: 'Far away' });
	await expect(far).toBeAttached();
	await expect(far).not.toBeInViewport();

	// Raw HTML that would float over the header stays in the note's flow.
	await expect(preview.locator('dialog')).toHaveCount(0);
	const inFlow = await preview.getByRole('link', { name: 'Session expired' }).boundingBox();
	const article = await preview.boundingBox();
	expect(inFlow && article && inFlow.x >= article.x && inFlow.y >= article.y && inFlow.x + inFlow.width <= article.x + article.width).toBe(true);
	await page.getByRole('button', { name: 'Edit', exact: true }).click({ trial: true });

	await preview.getByRole('link', { name: 'jump' }).click();
	await expect(far).toBeInViewport();
	await expect(page).toHaveURL(/#user-content-far-away$/);

	// A link from elsewhere arrives before the note has rendered.
	await page.reload();
	await expect(far).toBeInViewport();

	expect(problems).toEqual([]);
});

test('pasted text takes the line endings of the note', async ({ page }) => {
	const problems = collectBreakage(page);
	const { id } = await cloneRepo(page);
	const content = page.getByTestId('note-editor').locator('.cm-content');

	await page.goto(noteUrl(id, 'notes/z-crlf.md'));
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await content.click();
	await page.keyboard.press('ControlOrMeta+Home');
	await pasteText(content, 'x\ny\n');
	await expect(content.locator('.cm-line')).toHaveCount(5);
	await expect(page.getByTestId('dirty-indicator')).toHaveText('Unsaved, kept on this device');
	expect(await draftText(page, 'notes/z-crlf.md')).toBe('x\r\ny\r\none\r\ntwo\r\n');

	await page.goto(noteUrl(id, 'README.md'));
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await content.click();
	await page.keyboard.press('ControlOrMeta+Home');
	await pasteText(content, 'x\r\ny\r\n');
	await expect(content.locator('.cm-line')).toHaveCount(4);
	await expect(page.getByTestId('dirty-indicator')).toHaveText('Unsaved, kept on this device');
	expect(await draftText(page, 'README.md')).toBe('x\ny\n# Top\n');

	expect(problems).toEqual([]);
});

test('a save in one tab leaves the other tab able to keep its text', async ({ page, context }) => {
	const { id } = await cloneRepo(page);
	await page.goto(noteUrl(id, 'README.md'));
	// Tabs take turns on the stored files, so the pull on opening finishes first.
	await expect(page.getByTestId('last-sync')).toContainText('Last sync');
	const other = await context.newPage();
	await other.goto(noteUrl(id, 'README.md'));
	await expect(other.getByTestId('note-preview').getByRole('heading', { name: 'Top' })).toBeVisible();
	await expect(other.getByTestId('last-sync')).toContainText('Last sync');

	await typeNote(other, 'words from the other tab');
	await expect(other.getByTestId('dirty-indicator')).toHaveText('Unsaved, kept on this device');
	await typeNote(page, 'words from this tab');
	await expect(page.getByTestId('dirty-indicator')).toHaveText('Unsaved, kept on this device');
	expect(await draftText(page, 'README.md')).toBe('words from this tab');
	await page.getByTestId('save-note').click();
	await expect(page.getByTestId('dirty-indicator')).toHaveText('Saved to the working tree');
	await expect.poll(() => draftText(page, 'README.md')).toBeUndefined();

	// The other tab gets its text kept again as soon as it is looked at.
	await other.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect.poll(() => draftText(page, 'README.md')).toBe('words from the other tab');
	await other.reload();
	await expect(other.getByTestId('note-editor').locator('.cm-content')).toContainText('words from the other tab');
	await other.close();
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test('the file list is a drawer, and notes fill the screen', async ({ page }) => {
		const problems = collectBreakage(page);
		const { id } = await cloneRepo(page);

		// With no note open, the list is what there is to see.
		await page.goto(noteUrl(id));
		const drawer = page.getByTestId('file-drawer');
		const toggle = page.getByTestId('drawer-toggle');
		await expect(drawer).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');

		// Picking a file closes it.
		await drawer.getByRole('link', { name: 'README.md' }).tap();
		await expect(drawer).toBeHidden();
		await expect(page.getByTestId('note-preview').getByRole('heading', { name: 'Top' })).toBeVisible();
		const article = await page.getByTestId('note-preview').boundingBox();
		expect(article?.width).toBeGreaterThan(300);

		// Open it again: it floats over the note, and the backdrop closes it.
		await toggle.tap();
		await expect(drawer).toBeVisible();
		const box = await drawer.boundingBox();
		expect(box?.x).toBe(0);
		expect(box?.width).toBeLessThan(390);
		await page.getByTestId('drawer-backdrop').tap({ position: { x: 380, y: 400 } });
		await expect(drawer).toBeHidden();

		// No sideways scroll, and split view is not on offer.
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await expect(page.getByRole('button', { name: 'Split' })).toBeHidden();

		// The editor works by touch, and its buffer survives a reload here too.
		await page.getByRole('button', { name: 'Edit', exact: true }).tap();
		const content = page.getByTestId('note-editor').locator('.cm-content');
		await content.tap();
		await page.keyboard.type('typed on a phone ');
		await expect(page.getByTestId('dirty-indicator')).toHaveText('Unsaved, kept on this device');
		await page.reload();
		await expect(content).toContainText('typed on a phone');
		expect(problems).toEqual([]);
	});
});

test('runs the editor and blob images under the policy, and a deep link boots on the static server', async ({ page }) => {
	const { id } = await cloneRepo(page);
	await page.addInitScript(() => {
		/** @type {string[]} */
		const violations = [];
		Object.assign(globalThis, { cspViolations: violations });
		document.addEventListener('securitypolicyviolation', (event) => {
			violations.push(`${event.effectiveDirective}: ${event.blockedURI || 'inline'}`);
		});
	});
	const violations = () => page.evaluate(() => /** @type {string[]} */ (Reflect.get(globalThis, 'cspViolations')));

	await page.goto(noteUrl(id, 'notes/welcome.md'));
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await expect(page.getByTestId('note-editor').locator('.cm-content')).toBeVisible();
	await page.getByRole('button', { name: 'Read', exact: true }).click();
	await expect(page.getByTestId('note-preview').getByRole('img', { name: 'pixel' })).toHaveAttribute('src', /^blob:/);
	expect(await violations()).toEqual([]);

	// Another origin has its own empty storage, so the repo is not there. The
	// deep link's encoded id must still reach the client router as one segment.
	await page.goto(`http://127.0.0.1:${STATIC_SHELL_PORT}${noteUrl(id, 'notes/welcome.md')}`, { waitUntil: 'networkidle' });
	await expect(page.getByTestId('repo-not-here')).toBeVisible();
	expect(await violations()).toEqual([]);
});

test('deleting a copy warns about unsaved text and removes it from the device', async ({ page }) => {
	const { fullName, id } = await cloneRepo(page);
	await page.goto(noteUrl(id, 'README.md'));
	await typeNote(page, 'unsaved private words');
	await expect(page.getByTestId('dirty-indicator')).toHaveText('Unsaved, kept on this device');

	await page.getByRole('link', { name: 'Repositories' }).click();
	const copy = page.getByTestId('local-copy');
	await expect(copy).toContainText(fullName);
	await copy.getByRole('button', { name: 'Delete from this device' }).click();
	await expect(page.getByTestId('remove-copy')).toContainText('1 unsaved note');
	await page.getByRole('button', { name: 'Delete this copy' }).click();
	await expect(page.getByTestId('local-copy')).toHaveCount(0);

	expect(await storedDrafts(page)).toEqual([]);

	await page.goto(noteUrl(id, 'README.md'));
	await expect(page.getByTestId('repo-not-here')).toBeVisible();
});
