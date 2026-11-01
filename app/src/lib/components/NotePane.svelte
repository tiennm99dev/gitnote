<script>
	import { onDestroy, untrack } from 'svelte';
	import { formatBytes } from '#lib/git/limits.js';
	import { createImageUrls } from '#lib/markdown/render.js';
	import { isMarkdownPath } from '#lib/notes/paths.js';
	import Editor from './Editor.svelte';
	import Preview from './Preview.svelte';

	/** @typedef {import('#lib/stores/notes.js').OpenNote} OpenNote */

	/**
	 * @typedef {object} Props
	 * @property {OpenNote} note
	 * @property {import('#lib/stores/notes.js').Notes} notes
	 * @property {(path: string) => Promise<Uint8Array>} readFile
	 * @property {(path: string) => string} linkFor
	 * @property {boolean} startEditing open in edit mode, as for a new note
	 * @property {(text: string) => void} onreport shows a warning or failure
	 * @property {() => void} onclearreport
	 * @property {() => void} oncreatemissing makes the missing note here
	 */

	/** @type {Props} */
	let { note, notes, readFile, linkFor, startEditing, onreport, onclearreport, oncreatemissing } = $props();

	/** @type {'read' | 'edit' | 'split'} */
	let mode = $state(untrack(() => (note.dirty || startEditing ? 'edit' : 'read')));
	let saving = $state(false);
	let confirmingDiscard = $state(false);
	/** @type {Editor | undefined} */
	let editor = $state();
	/** @type {HTMLInputElement | undefined} */
	let picker = $state();
	/** @type {string | null} */
	let imageUrl = $state(null);

	const hasText = $derived(note.kind === 'markdown' || note.kind === 'text');
	const isMarkdown = $derived(isMarkdownPath(note.path));
	const canEdit = $derived(hasText);

	const images = createImageUrls({ readFile: (path) => readFile(path) });
	onDestroy(() => images.dispose());

	$effect(() => {
		if (note.kind !== 'image') return;
		let live = true;
		images.urlFor(note.path).then((url) => {
			if (live) imageUrl = url;
		});
		return () => {
			live = false;
		};
	});

	/**
	 * @param {unknown} error
	 * @returns {string}
	 */
	const messageOf = (error) => (error instanceof Error ? error.message : 'Something went wrong.');

	const save = async () => {
		if (saving || !note.dirty) return;
		saving = true;
		onclearreport();
		try {
			await notes.save();
		} catch (error) {
			onreport(messageOf(error));
		} finally {
			saving = false;
		}
	};

	/** @param {() => Promise<void>} action */
	const run = async (action) => {
		onclearreport();
		try {
			await action();
		} catch (error) {
			onreport(messageOf(error));
		}
	};

	/** @param {File} file */
	const addImage = async (file) => {
		const { path } = note;
		onclearreport();
		try {
			const added = await notes.addImage(path, file);
			if (note.path === path) editor?.insert(added.markdown);
			if (added.warning) onreport(added.warning);
		} catch (error) {
			onreport(messageOf(error));
		}
	};

	/** @param {Event & { currentTarget: HTMLInputElement }} event */
	const picked = (event) => {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = '';
		if (file) void addImage(file);
	};
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex flex-wrap items-center gap-2 border-b border-gray-200 p-2">
		<h2 class="min-w-0 flex-1 truncate font-medium max-sm:basis-full" title={note.path} data-testid="note-path">{note.path}</h2>
		{#if canEdit}
			<div class="flex" role="group" aria-label="View">
				<button type="button" class="min-h-11 rounded-l border border-gray-400 px-3 aria-pressed:bg-gray-900 aria-pressed:text-white" aria-pressed={mode === 'read'} onclick={() => (mode = 'read')}>Read</button>
				<button type="button" class="-ml-px min-h-11 border border-gray-400 px-3 last:rounded-r aria-pressed:bg-gray-900 aria-pressed:text-white" aria-pressed={mode === 'edit'} onclick={() => (mode = 'edit')}>Edit</button>
				{#if isMarkdown}
					<button type="button" class="-ml-px hidden min-h-11 rounded-r border border-gray-400 px-3 aria-pressed:bg-gray-900 aria-pressed:text-white lg:block" aria-pressed={mode === 'split'} onclick={() => (mode = 'split')}>Split</button>
				{/if}
			</div>
			{#if mode !== 'read' && isMarkdown}
				<button type="button" class="min-h-11 rounded border border-gray-400 px-3" onclick={() => picker?.click()}>Add image</button>
				<input class="hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.png,.jpg,.jpeg,.gif,.webp,.svg" bind:this={picker} onchange={picked} data-testid="image-picker" />
			{/if}
			<button type="button" class="min-h-11 rounded bg-gray-900 px-3 text-white disabled:opacity-50" disabled={!note.dirty || saving} onclick={save} data-testid="save-note">Save</button>
			{#if note.dirty && confirmingDiscard}
				<button
					type="button"
					class="min-h-11 rounded bg-red-700 px-3 text-white"
					onclick={() => {
						confirmingDiscard = false;
						void run(notes.discard);
					}}
					data-testid="discard-confirm">Discard unsaved text</button
				>
				<button type="button" class="min-h-11 rounded border border-gray-400 px-3" onclick={() => (confirmingDiscard = false)}>Keep it</button>
			{:else if note.dirty}
				<button type="button" class="min-h-11 rounded border border-gray-400 px-3" onclick={() => (confirmingDiscard = true)} data-testid="discard-note">Discard</button>
			{/if}
		{/if}
	</div>

	{#if note.draftFailed}
		<p role="alert" class="bg-amber-50 p-2 text-amber-800" data-testid="draft-failed">This browser refused to keep your unsaved text, so a reload would lose it. Save it now.</p>
	{/if}
	{#if note.restored && !note.diskChanged}
		<p role="status" class="bg-gray-100 p-2 text-sm" data-testid="draft-restored">Your unsaved text is back. Save it, or discard it to return to the file.</p>
	{/if}
	{#if note.diskChanged}
		<div role="alert" class="flex flex-wrap items-center gap-2 bg-amber-50 p-2 text-amber-800" data-testid="disk-changed">
			<p class="min-w-0 flex-1">The file changed after you started editing, and neither version has replaced the other.</p>
			<button type="button" class="min-h-11 rounded border border-amber-800 px-3" onclick={() => run(notes.keepMine)} data-testid="keep-mine">Keep my text</button>
			<button type="button" class="min-h-11 rounded border border-amber-800 px-3" onclick={() => run(notes.discard)} data-testid="use-file">Use the file</button>
		</div>
	{/if}

	<div class="min-h-0 flex-1">
		{#if hasText}
			{#key note.version}
				<div class="grid h-full min-h-0" class:lg:grid-cols-2={mode === 'split'}>
					{#if mode !== 'read'}
						<div class="min-h-0 min-w-0">
							<Editor bind:this={editor} text={note.text} {isMarkdown} dirty={note.dirty} draftStored={note.draftStored} onchange={notes.edit} onsave={save} onimage={addImage} />
						</div>
					{/if}
					{#if mode !== 'edit'}
						<div class="min-h-0 min-w-0 overflow-auto p-4" class:hidden={mode === 'split'} class:lg:block={mode === 'split'} class:lg:border-l={mode === 'split'} class:border-gray-200={mode === 'split'}>
							{#if isMarkdown}
								<Preview source={note.text} notePath={note.path} {readFile} {linkFor} />
							{:else}
								<pre class="font-mono text-sm break-words whitespace-pre-wrap" data-testid="raw-text">{note.text}</pre>
							{/if}
						</div>
					{/if}
				</div>
			{/key}
		{:else if note.kind === 'image'}
			<div class="h-full overflow-auto p-4">
				{#if imageUrl}
					<img class="max-w-full" src={imageUrl} alt={note.path} data-testid="image-preview" />
				{/if}
				<p class="mt-2 text-sm text-gray-600">{formatBytes(note.size)}</p>
			</div>
		{:else if note.kind === 'binary'}
			<p class="p-4" data-testid="binary-file">This is a binary file of {formatBytes(note.size)}, so it cannot be shown here.</p>
		{:else if note.kind === 'large'}
			<p class="p-4" data-testid="large-file">This file is {formatBytes(note.size)}, too large to show here.</p>
		{:else}
			<div class="flex flex-col items-start gap-3 p-4" data-testid="missing-file">
				<p>There is no file at this path.</p>
				{#if isMarkdown}
					<button type="button" class="min-h-11 rounded border border-gray-900 px-3" onclick={oncreatemissing}>Create this note</button>
				{/if}
			</div>
		{/if}
	</div>
</div>
