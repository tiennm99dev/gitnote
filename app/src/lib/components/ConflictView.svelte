<script>
	import { SvelteSet } from 'svelte/reactivity';

	/**
	 * @typedef {object} Props
	 * @property {import('#lib/sync/sync.js').Sync} sync
	 * @property {import('#lib/stores/notes.js').Notes} notes
	 * @property {(path: string) => string} hrefFor
	 * @property {string} current the note open below this list
	 * @property {boolean} autosaveOn autosave pushes the merge commit by itself
	 * @property {() => void} onclose hides the list; the merge stays open
	 */

	/** @type {Props} */
	let { sync, notes, hrefFor, current, autosaveOn, onclose } = $props();

	/** Text files whose markers the user said are the file's real content. Lasts until a reload. */
	const keptMarkers = new SvelteSet();
	/** @type {string | null} */
	let stillMarked = $state(null);
	/** @type {string | null} */
	let failure = $state(null);
	let busy = $state(false);
	let confirmingAbort = $state(false);

	/**
	 * @param {import('#lib/git/merge.js').ConflictProgress} conflict
	 * @returns {boolean} a side must still be picked
	 */
	const needsChoice = (conflict) => conflict.binary || conflict.kind !== 'both_modified';

	/**
	 * @param {import('#lib/git/merge.js').ConflictProgress} conflict
	 * @returns {boolean}
	 */
	const isResolved = (conflict) => {
		if ($notes.draftPaths.includes(conflict.path)) return false;
		return needsChoice(conflict) ? !conflict.undecided : !conflict.hasMarkers || keptMarkers.has(conflict.path);
	};

	const afterMerge = $derived.by(() => {
		if ($sync.pushPending) return 'Your waiting push goes once the merge commit is made and the network allows it.';
		if (autosaveOn) return 'Autosave pushes the merge commit on its next run.';
		return 'Nothing is pushed until you push.';
	});

	const remaining = $derived($sync.conflicts.filter((conflict) => !isResolved(conflict)).length);

	/**
	 * @param {import('#lib/git/merge.js').ConflictProgress} conflict
	 * @returns {string} what happened to the file on each side
	 */
	const describe = ({ kind, binary }) => {
		if (kind === 'deleted_by_us') return 'You deleted this file; the remote changed it.';
		if (kind === 'deleted_by_theirs') return 'The remote deleted this file; you changed it.';
		return binary ? 'A binary file changed on both sides, so one version has to win.' : 'Both sides changed the same lines.';
	};

	/**
	 * @param {import('#lib/git/merge.js').ConflictProgress} conflict
	 * @returns {{ ours: string, theirs: string }}
	 */
	const sideLabels = ({ kind }) => {
		if (kind === 'deleted_by_us') return { ours: 'Keep it deleted', theirs: 'Keep the remote file' };
		if (kind === 'deleted_by_theirs') return { ours: 'Keep my file', theirs: 'Delete it' };
		return { ours: 'Keep mine', theirs: 'Keep theirs' };
	};

	/** @param {() => Promise<unknown>} action */
	const run = async (action) => {
		if (busy) return;
		busy = true;
		failure = null;
		try {
			await action();
		} catch (error) {
			failure = error instanceof Error ? error.message : 'Something went wrong.';
		} finally {
			busy = false;
		}
	};

	/**
	 * Saves what the editor holds for this file, then checks the file itself.
	 * @param {string} path
	 * @returns {Promise<void>}
	 */
	const markResolved = (path) =>
		run(async () => {
			stillMarked = null;
			if ($notes.note?.path === path && $notes.note.dirty && !(await notes.save())) {
				failure = `${path} changed after you started editing. Choose a version below, then mark it again.`;
				return;
			}
			if ($notes.note?.path !== path && $notes.draftPaths.includes(path)) {
				failure = `${path} has unsaved text. Open it and save it, or discard it, first.`;
				return;
			}
			await sync.refresh();
			if ($sync.conflicts.find((conflict) => conflict.path === path)?.hasMarkers) stillMarked = path;
		});

	const complete = () =>
		run(async () => {
			const allowMarkers = $sync.conflicts.some((conflict) => conflict.hasMarkers) && $sync.conflicts.every((conflict) => !conflict.hasMarkers || keptMarkers.has(conflict.path));
			await sync.completeMerge({ allowMarkers });
		});

	const abort = () =>
		run(async () => {
			confirmingAbort = false;
			await sync.abortMerge();
		});
</script>

<section class="flex max-h-[50%] flex-col gap-2 overflow-y-auto border-b border-gray-200 bg-amber-50 p-3" data-testid="conflict-view">
	<div class="flex flex-wrap items-center gap-2">
		<h2 class="min-w-0 flex-1 text-lg font-semibold">The remote changed the same files. Nothing is lost.</h2>
		<button type="button" class="min-h-11 rounded border border-gray-400 bg-white px-3" onclick={onclose}>Hide</button>
	</div>
	<p class="text-sm">Pick what each file should hold, then create the merge commit. <span data-testid="after-merge">{afterMerge}</span></p>

	<ul class="flex flex-col gap-2" data-testid="conflict-files">
		{#each $sync.conflicts as conflict (conflict.path)}
			<li class="flex flex-col gap-1 rounded border border-amber-300 bg-white p-2" data-testid="conflict-file">
				<div class="flex flex-wrap items-center gap-2">
					<span class="min-w-0 flex-1 truncate font-medium" title={conflict.path}>{conflict.path}</span>
					<span class="text-sm {isResolved(conflict) ? 'text-green-800' : 'text-amber-800'}" data-testid="conflict-state">{isResolved(conflict) ? 'Resolved' : 'Not resolved'}</span>
				</div>
				<p class="text-sm text-gray-700">{describe(conflict)}</p>
				<div class="flex flex-wrap gap-2">
					{#if needsChoice(conflict)}
						<button type="button" class="min-h-11 rounded border border-gray-900 px-3 disabled:opacity-50" disabled={busy} onclick={() => run(() => sync.resolve(conflict.path, 'ours'))} data-testid="keep-ours">{sideLabels(conflict).ours}</button>
						<button type="button" class="min-h-11 rounded border border-gray-900 px-3 disabled:opacity-50" disabled={busy} onclick={() => run(() => sync.resolve(conflict.path, 'theirs'))} data-testid="keep-theirs">{sideLabels(conflict).theirs}</button>
					{:else}
						{#if current !== conflict.path}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefFor builds the route with resolve() -->
							<a class="flex min-h-11 items-center rounded border border-gray-900 px-3" href={hrefFor(conflict.path)} data-testid="edit-conflict">Edit the file</a>
						{/if}
						<button type="button" class="min-h-11 rounded border border-gray-900 px-3 disabled:opacity-50" disabled={busy} onclick={() => markResolved(conflict.path)} data-testid="mark-resolved">Mark resolved</button>
					{/if}
				</div>
				{#if stillMarked === conflict.path}
					<div role="alert" class="flex flex-wrap items-center gap-2 text-amber-800" data-testid="still-marked">
						<p class="min-w-0 flex-1 text-sm">This file still has conflict markers.</p>
						<button
							type="button"
							class="min-h-11 rounded border border-amber-800 px-3"
							onclick={() => {
								keptMarkers.add(conflict.path);
								stillMarked = null;
							}}
							data-testid="keep-markers">They are meant to be there</button
						>
					</div>
				{/if}
			</li>
		{/each}
	</ul>

	{#if failure}
		<p role="alert" class="text-red-700" data-testid="conflict-failure">{failure}</p>
	{/if}

	<div class="flex flex-wrap gap-2">
		<button type="button" class="min-h-11 rounded bg-gray-900 px-3 text-white disabled:opacity-50" disabled={busy || remaining > 0} onclick={complete} data-testid="complete-merge">Create merge commit</button>
		{#if confirmingAbort}
			<button type="button" class="min-h-11 rounded bg-red-700 px-3 text-white" onclick={abort} data-testid="abort-confirm">Abandon the merge and my resolutions</button>
			<button type="button" class="min-h-11 rounded border border-gray-400 bg-white px-3" onclick={() => (confirmingAbort = false)}>Keep going</button>
		{:else}
			<button type="button" class="min-h-11 rounded border border-gray-400 bg-white px-3" onclick={() => (confirmingAbort = true)} data-testid="abort-merge">Abandon merge</button>
		{/if}
	</div>
</section>
