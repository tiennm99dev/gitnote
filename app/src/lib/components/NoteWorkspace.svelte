<script>
	import { onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { deviceDrafts, openDeviceRepo } from '#lib/git/device-repos.js';
	import { dirName, encodePath } from '#lib/notes/paths.js';
	import { createNotes, isWithin, movedPath } from '#lib/stores/notes.js';
	import FileTree from './FileTree.svelte';
	import NotePane from './NotePane.svelte';

	/**
	 * @typedef {object} Props
	 * @property {import('#lib/git/local-repos.js').LocalRepo} repo fixed for this component's life
	 * @property {string} path the open file, or an empty string
	 */

	/** @type {Props} */
	let { repo, path } = $props();

	const { engine, notes } = untrack(() => {
		const opened = openDeviceRepo(repo);
		return { engine: opened, notes: createNotes({ repoId: repo.id, provider: repo.provider, repo: opened, drafts: deviceDrafts }) };
	});

	let drawerOpen = $state(untrack(() => path === ''));
	/** @type {string | null} */
	let report = $state(null);
	/** A path just created, which opens ready to type in. */
	let createdPath = $state('');

	/**
	 * What the dialog is asking for.
	 * @typedef {{ kind: 'new-note' | 'new-folder', value: string } | { kind: 'rename', from: string, isFolder: boolean, value: string } | { kind: 'delete', target: string, isFolder: boolean, files: number, unsaved: number }} Ask
	 */
	/** @type {Ask | null} */
	let ask = $state(null);
	/** @type {HTMLDialogElement | undefined} */
	let dialog = $state();
	/** @type {string | null} */
	let askFailure = $state(null);
	let busy = $state(false);

	let query = $state('');
	/** @type {{ hits: import('#lib/stores/notes.js').SearchHit[], truncated: boolean } | null} */
	let results = $state(null);
	let searching = $state(false);
	/** @type {AbortController | null} */
	let searchRun = null;

	/**
	 * @param {string} target a working-tree path, or empty for the repo's top
	 * @returns {string} the app's URL for it
	 */
	const hrefFor = (target) => resolve('/repo/[id]/[...path]', { id: encodeURIComponent(repo.id), path: encodePath(target) });

	/**
	 * @param {unknown} error
	 * @returns {string}
	 */
	const messageOf = (error) => (error instanceof Error ? error.message : 'Something went wrong.');

	$effect(() => {
		const target = path;
		untrack(() => {
			report = null;
			notes.open(target).catch((/** @type {unknown} */ error) => {
				report = messageOf(error);
			});
		});
	});

	onMount(() => {
		const onVisible = () => {
			if (document.visibilityState === 'visible') {
				notes.refresh().catch((/** @type {unknown} */ error) => {
					report = messageOf(error);
				});
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});

	/** @param {Ask} next */
	const openAsk = async (next) => {
		ask = next;
		askFailure = null;
		await tick();
		dialog?.showModal();
	};

	const closeAsk = () => {
		dialog?.close();
		ask = null;
	};

	/**
	 * @returns {string} the prefix for a new path: the open note's folder
	 */
	const newPathPrefix = () => {
		const folder = dirName($notes.note?.path ?? '');
		return folder ? `${folder}/` : '';
	};

	/**
	 * @param {string} target
	 * @param {boolean} isFolder
	 */
	const startDelete = (target, isFolder) => {
		const { entries, draftPaths } = $notes;
		void openAsk({
			kind: 'delete',
			target,
			isFolder,
			files: entries.filter((entry) => isWithin(entry.path, target)).length,
			unsaved: draftPaths.filter((item) => isWithin(item, target)).length
		});
	};

	/**
	 * @param {string} value
	 * @returns {string} the path, as a markdown file unless it names an extension
	 */
	const asNotePath = (value) => {
		const trimmed = value.trim();
		return /\.[^./]+$/.test(trimmed) ? trimmed : `${trimmed}.md`;
	};

	/** @param {SubmitEvent} event */
	const submitAsk = async (event) => {
		event.preventDefault();
		if (!ask || busy) return;
		busy = true;
		askFailure = null;
		const current = ask;
		try {
			if (current.kind === 'delete') {
				await notes.remove(current.target);
				closeAsk();
				if (path !== '' && isWithin(path, current.target)) {
					// eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefFor builds the route with resolve()
					await goto(hrefFor(''), { replaceState: true });
				}
			} else if (current.kind === 'rename') {
				const to = await notes.move(current.from, current.value.trim());
				closeAsk();
				if (path !== '' && isWithin(path, current.from)) {
					// eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefFor builds the route with resolve()
					await goto(hrefFor(movedPath(path, current.from, to)), { replaceState: true });
				}
			} else if (current.kind === 'new-folder') {
				await notes.createFolder(current.value.trim().replace(/\/+$/, ''));
				closeAsk();
			} else {
				const created = await notes.create(asNotePath(current.value));
				createdPath = created;
				closeAsk();
				drawerOpen = false;
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefFor builds the route with resolve()
				await goto(hrefFor(created));
			}
		} catch (error) {
			askFailure = messageOf(error);
		} finally {
			busy = false;
		}
	};

	/** @param {SubmitEvent} event */
	const submitSearch = async (event) => {
		event.preventDefault();
		searchRun?.abort();
		const run = new AbortController();
		searchRun = run;
		searching = true;
		try {
			const found = await notes.search(query, run.signal);
			if (searchRun === run) results = query.trim() === '' ? null : found;
		} catch (error) {
			if (searchRun === run) report = messageOf(error);
		} finally {
			if (searchRun === run) searching = false;
		}
	};

	const createMissing = async () => {
		try {
			createdPath = await notes.create(path);
			await notes.open(path);
		} catch (error) {
			report = messageOf(error);
		}
	};

	/** @param {KeyboardEvent} event */
	const onKeydown = (event) => {
		if (event.key === 'Escape' && drawerOpen && !ask) drawerOpen = false;
	};
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-dvh flex-col">
	<header class="flex items-center gap-2 border-b border-gray-200 p-2">
		<button type="button" class="min-h-11 rounded border border-gray-400 px-3 lg:hidden" aria-expanded={drawerOpen} aria-controls="file-drawer" onclick={() => (drawerOpen = !drawerOpen)} data-testid="drawer-toggle">Files</button>
		<h1 class="min-w-0 flex-1 truncate font-bold" data-testid="repo-title">{repo.fullName}</h1>
		<a class="underline" href={resolve('/repos')}>Repositories</a>
	</header>

	{#if report}
		<p role="alert" class="bg-amber-50 p-2 text-amber-800" data-testid="workspace-report">{report}</p>
	{/if}

	<div class="flex min-h-0 flex-1">
		{#if drawerOpen}
			<button type="button" class="fixed inset-0 z-10 bg-black/40 lg:hidden" aria-label="Close the file list" onclick={() => (drawerOpen = false)} data-testid="drawer-backdrop"></button>
		{/if}
		<aside
			id="file-drawer"
			class="z-20 w-80 max-w-[85vw] shrink-0 flex-col gap-4 overflow-y-auto border-r border-gray-200 bg-white p-3 max-lg:fixed max-lg:inset-y-0 max-lg:left-0 lg:flex {drawerOpen ? 'flex' : 'hidden'}"
			data-testid="file-drawer"
		>
			<div class="flex gap-2">
				<button type="button" class="min-h-11 flex-1 rounded border border-gray-900 px-2" onclick={() => openAsk({ kind: 'new-note', value: `${newPathPrefix()}untitled.md` })} data-testid="new-note">New note</button>
				<button type="button" class="min-h-11 flex-1 rounded border border-gray-900 px-2" onclick={() => openAsk({ kind: 'new-folder', value: newPathPrefix() })} data-testid="new-folder">New folder</button>
			</div>

			<form class="flex flex-col gap-1" onsubmit={submitSearch} role="search">
				<label class="flex flex-col gap-1">
					<span class="text-sm text-gray-600">Search notes</span>
					<input class="rounded border border-gray-400 p-2" type="search" bind:value={query} data-testid="note-search" />
				</label>
				<button type="submit" class="min-h-11 rounded border border-gray-400 px-3 disabled:opacity-50" disabled={searching} data-testid="note-search-button">{searching ? 'Searching…' : 'Search'}</button>
			</form>

			{#if results}
				<section class="flex flex-col gap-1" data-testid="search-results">
					<h2 class="text-sm font-medium">{results.hits.length === 0 ? 'Nothing found' : `Found ${results.hits.length}${results.truncated ? '+' : ''}`}</h2>
					<ul class="flex flex-col gap-1">
						{#each results.hits as hit (`${hit.path}:${hit.line}`)}
							<li>
								<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefFor builds the route with resolve() -->
								<a class="block rounded p-1 hover:bg-gray-100" href={hrefFor(hit.path)} data-testid="search-hit" onclick={() => (drawerOpen = false)}>
									<span class="block truncate text-sm font-medium">{hit.path}:{hit.line}</span>
									<span class="block truncate text-sm text-gray-600">{hit.snippet}</span>
								</a>
							</li>
						{/each}
					</ul>
					<button type="button" class="self-start text-sm underline" onclick={() => (results = null)}>Clear results</button>
				</section>
			{/if}

			{#if $notes.treeError}
				<p role="alert" class="text-red-700" data-testid="tree-error">{$notes.treeError}</p>
			{/if}
			<FileTree
				entries={$notes.entries}
				draftPaths={$notes.draftPaths}
				current={path}
				{hrefFor}
				onopen={() => (drawerOpen = false)}
				onrename={(from, isFolder) => openAsk({ kind: 'rename', from, isFolder, value: from })}
				ondelete={startDelete}
			/>
		</aside>

		<main class="min-h-0 min-w-0 flex-1">
			{#if $notes.note}
				{#key `${$notes.note.path}:${$notes.note.kind === 'missing'}`}
					<NotePane
						note={$notes.note}
						{notes}
						readFile={engine.readFile}
						linkFor={hrefFor}
						startEditing={$notes.note.path === createdPath}
						onreport={(text) => (report = text)}
						onclearreport={() => (report = null)}
						oncreatemissing={createMissing}
					/>
				{/key}
			{:else if path === ''}
				<p class="p-4 text-gray-600" data-testid="no-note">Pick a note from the file list.</p>
			{/if}
		</main>
	</div>
</div>

<dialog bind:this={dialog} class="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg p-4 backdrop:bg-black/40" oncancel={() => (ask = null)} data-testid="notes-dialog">
	{#if ask}
		<form class="flex flex-col gap-3" onsubmit={submitAsk}>
			{#if ask.kind === 'delete'}
				<h2 class="text-lg font-semibold">Delete {ask.target}?</h2>
				<p>
					{#if ask.isFolder}This removes {ask.files} {ask.files === 1 ? 'file' : 'files'} from the working tree.{:else}This removes the file from the working tree.{/if}
					Nothing is committed. A file git already tracks comes back if you discard the change later.
				</p>
				{#if ask.unsaved > 0}
					<p class="text-amber-800" data-testid="delete-unsaved">{ask.unsaved} unsaved {ask.unsaved === 1 ? 'note goes' : 'notes go'} with it, and {ask.unsaved === 1 ? 'that text' : 'their text'} cannot be recovered.</p>
				{/if}
			{:else}
				<h2 class="text-lg font-semibold">
					{ask.kind === 'rename' ? `Rename or move ${ask.from}` : ask.kind === 'new-note' ? 'New note' : 'New folder'}
				</h2>
				<label class="flex flex-col gap-1">
					<span>Path in the repository</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input class="rounded border border-gray-400 p-2" type="text" required autofocus bind:value={ask.value} data-testid="dialog-path" />
				</label>
			{/if}
			{#if askFailure}
				<p role="alert" class="text-red-700" data-testid="dialog-error">{askFailure}</p>
			{/if}
			<div class="flex justify-end gap-2">
				<button type="button" class="min-h-11 rounded border border-gray-900 px-3" onclick={closeAsk}>Cancel</button>
				<button type="submit" class="min-h-11 rounded px-3 text-white disabled:opacity-50 {ask.kind === 'delete' ? 'bg-red-700' : 'bg-gray-900'}" disabled={busy} data-testid="dialog-confirm">
					{ask.kind === 'delete' ? 'Delete' : ask.kind === 'rename' ? 'Move' : 'Create'}
				</button>
			</div>
		</form>
	{/if}
</dialog>
