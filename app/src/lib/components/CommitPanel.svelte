<script>
	import { resolve } from '$app/paths';
	import { ErrorCode, GitEngineError } from '#lib/git/errors.js';
	import { formatBytes } from '#lib/git/limits.js';
	import { diffFile } from '#lib/sync/diff.js';
	import { commitMessageFor } from '#lib/sync/sync.js';

	/**
	 * @typedef {object} Props
	 * @property {import('#lib/sync/sync.js').Sync} sync
	 * @property {Pick<import('#lib/git/repo.js').Repo, 'checkCommit' | 'readCommitted' | 'readFile'>} engine
	 * @property {string[]} draftPaths notes with unsaved text
	 * @property {boolean} hasAuthor
	 * @property {import('svelte/reactivity').SvelteSet<string>} unchecked files left out, kept by the caller so they outlast this panel; everything else is selected, so a new change is never left out unseen
	 * @property {string | null} typedMessage the message the user wrote, kept the same way
	 */

	/** @type {Props} */
	let { sync, engine, draftPaths, hasAuthor, unchecked, typedMessage = $bindable() } = $props();

	/** @type {import('#lib/git/limits.js').SizeFinding[]} */
	let findings = $state([]);
	/** @type {string | null} */
	let findingsFailure = $state(null);
	let busy = $state(false);
	let confirmingDiscard = $state(false);
	/** @type {string[]} */
	let leftAsDrafts = $state([]);
	/** @type {string | null} */
	let diffPath = $state(null);
	/** @type {import('#lib/sync/diff.js').FileDiff | null} */
	let diff = $state(null);
	/** @type {string | null} */
	let diffFailure = $state(null);

	const selected = $derived($sync.files.filter((file) => !unchecked.has(file.path)).map((file) => file.path));
	const message = $derived(typedMessage ?? (selected.length > 0 ? commitMessageFor(selected) : ''));
	const blockedBySize = $derived(findings.some((finding) => finding.level === 'block'));
	const canCommit = $derived(!busy && hasAuthor && selected.length > 0 && message.trim() !== '' && !blockedBySize);

	/** Tells the latest size check from one overtaken while it waited on a lock. */
	let checks = 0;

	$effect(() => {
		const paths = selected;
		checks += 1;
		const check = checks;
		if (paths.length === 0) {
			findings = [];
			findingsFailure = null;
			return;
		}
		engine.checkCommit(paths).then(
			(found) => {
				if (check !== checks) return;
				findings = found;
				findingsFailure = null;
			},
			(/** @type {unknown} */ error) => {
				if (check === checks) findingsFailure = error instanceof Error ? error.message : 'The size check failed.';
			}
		);
	});

	/** @param {string} path */
	const toggleDiff = async (path) => {
		if (diffPath === path) {
			diffPath = null;
			return;
		}
		diffPath = path;
		diff = null;
		diffFailure = null;
		try {
			const [before, after] = await Promise.all([
				engine.readCommitted(path),
				engine.readFile(path).catch((/** @type {unknown} */ error) => {
					if (error instanceof GitEngineError && error.code === ErrorCode.PATH_NOT_FOUND) return null;
					throw error;
				})
			]);
			if (diffPath === path) diff = diffFile(before, after);
		} catch (error) {
			if (diffPath === path) diffFailure = error instanceof Error ? error.message : 'The change could not be read.';
		}
	};

	/** @param {boolean} thenPush */
	const commit = async (thenPush) => {
		if (!canCommit) return;
		busy = true;
		try {
			const result = await sync.commit({ paths: selected, message });
			if (!result.ok) return;
			typedMessage = null;
			diffPath = null;
			if (thenPush) await sync.push();
		} finally {
			busy = false;
		}
	};

	const discard = async () => {
		busy = true;
		confirmingDiscard = false;
		try {
			await sync.discard(selected);
			diffPath = null;
		} finally {
			busy = false;
		}
	};

	const saveDrafts = async () => {
		busy = true;
		try {
			leftAsDrafts = (await sync.saveDrafts()).skipped;
		} finally {
			busy = false;
		}
	};
</script>

<div class="flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="commit-panel">
	<h2 class="text-lg font-semibold">Changes on this device</h2>

	{#if draftPaths.length > 0}
		<div role="status" class="flex flex-col gap-2 rounded bg-amber-50 p-2 text-amber-800" data-testid="commit-unsaved">
			<p>Unsaved text is not in the list below until it is saved: {draftPaths.join(', ')}.</p>
			<button type="button" class="min-h-11 self-start rounded border border-amber-800 px-3 disabled:opacity-50" disabled={busy} onclick={saveDrafts} data-testid="save-all-drafts">Save all</button>
			{#if leftAsDrafts.length > 0}
				<p data-testid="left-as-drafts">Not saved, because the file changed after you started editing: {leftAsDrafts.join(', ')}. Open each one to choose which version to keep.</p>
			{/if}
		</div>
	{/if}

	{#if $sync.files.length === 0}
		<p class="text-gray-600" data-testid="no-changes">Nothing to commit.</p>
	{:else}
		<ul class="flex flex-col gap-1" data-testid="changed-files">
			{#each $sync.files as file (file.path)}
				<li class="flex flex-col rounded border border-gray-200" data-testid="changed-file">
					<div class="flex items-center gap-2 p-1">
						<label class="flex min-h-11 min-w-0 flex-1 items-center gap-2">
							<input
								type="checkbox"
								checked={!unchecked.has(file.path)}
								onchange={(event) => {
									if (event.currentTarget.checked) unchecked.delete(file.path);
									else unchecked.add(file.path);
								}}
							/>
							<span class="min-w-0 truncate" title={file.path}>{file.path}</span>
						</label>
						<span class="text-sm text-gray-600">{file.change}</span>
						<button type="button" class="min-h-11 rounded border border-gray-400 px-2 text-sm" aria-expanded={diffPath === file.path} onclick={() => toggleDiff(file.path)} data-testid="toggle-diff">Diff</button>
					</div>
					{#if diffPath === file.path}
						<div class="overflow-x-auto border-t border-gray-200 p-2 font-mono text-sm" data-testid="file-diff">
							{#if diffFailure}
								<p role="alert" class="text-red-700">{diffFailure}</p>
							{:else if !diff}
								<p class="text-gray-600">Reading…</p>
							{:else if diff.kind === 'line_endings'}
								<p class="text-gray-600" data-testid="diff-line-endings">Only the line endings changed.</p>
							{:else if diff.kind === 'same_text'}
								<p class="text-gray-600">The text is the same, so only the file's mode changed.</p>
							{:else if diff.kind === 'text'}
								{#if diff.lines.length === 0}
									<p class="text-gray-600">This file is empty.</p>
								{/if}
								{#each diff.lines as line, index (index)}
									{#if line.type === 'folded'}
										<div class="text-gray-500">… {line.count} unchanged {line.count === 1 ? 'line' : 'lines'}</div>
									{:else}
										<div class="whitespace-pre {line.type === 'added' ? 'bg-green-100 text-green-900' : line.type === 'removed' ? 'bg-red-100 text-red-900' : ''}" data-diff={line.type}>{line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '} {line.text}</div>
									{/if}
								{/each}
							{:else}
								<p data-testid="diff-no-lines">
									{diff.kind === 'binary' ? 'A binary file' : diff.kind === 'large' ? 'Too large to compare here' : 'Too different to compare here'}: {formatBytes(diff.before)} before, {formatBytes(diff.after)} now.
								</p>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>

		{#each findings as finding (finding.message)}
			<p role={finding.level === 'block' ? 'alert' : 'status'} class={finding.level === 'block' ? 'text-red-700' : 'text-amber-800'} data-testid={finding.level === 'block' ? 'size-block' : 'size-warning'}>{finding.message}</p>
		{/each}
		{#if findingsFailure}
			<p role="alert" class="text-red-700">{findingsFailure}</p>
		{/if}

		<label class="flex flex-col gap-1">
			<span>Commit message</span>
			<textarea class="rounded border border-gray-400 p-2" rows="3" value={message} oninput={(event) => (typedMessage = event.currentTarget.value)} data-testid="commit-message"></textarea>
		</label>

		{#if !hasAuthor}
			<p role="alert" class="text-amber-800" data-testid="commit-needs-author">Commits need an author. <a class="underline" href={resolve('/settings')}>Set your name and email in Settings</a>.</p>
		{/if}

		<div class="flex flex-wrap gap-2">
			<button type="button" class="min-h-11 rounded bg-gray-900 px-3 text-white disabled:opacity-50" disabled={!canCommit} onclick={() => commit(false)} data-testid="commit-button">Commit</button>
			<button type="button" class="min-h-11 rounded bg-gray-900 px-3 text-white disabled:opacity-50" disabled={!canCommit} onclick={() => commit(true)} data-testid="commit-push-button">Commit &amp; Push</button>
			{#if confirmingDiscard}
				<p class="basis-full text-red-700" data-testid="discard-files">Discarding takes these back to their last commit, and deletes any git does not track yet: {selected.join(', ')}.</p>
				<button type="button" class="min-h-11 rounded bg-red-700 px-3 text-white" onclick={discard} data-testid="discard-confirm-changes">Discard {selected.length} {selected.length === 1 ? 'file' : 'files'}; this cannot be undone</button>
				<button type="button" class="min-h-11 rounded border border-gray-400 px-3" onclick={() => (confirmingDiscard = false)}>Keep them</button>
			{:else}
				<button type="button" class="min-h-11 rounded border border-gray-400 px-3 disabled:opacity-50" disabled={busy || selected.length === 0} onclick={() => (confirmingDiscard = true)} data-testid="discard-changes">Discard selected</button>
			{/if}
		</div>
	{/if}
</div>
