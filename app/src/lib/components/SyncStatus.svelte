<script>
	import { resolve } from '$app/paths';
	import { ErrorCode } from '#lib/git/errors.js';

	/**
	 * @typedef {object} Props
	 * @property {import('#lib/sync/sync.js').Sync} sync
	 * @property {import('#lib/sync/autosave.js').AutosaveState} autosave
	 * @property {number} unsavedNotes notes with text not yet saved to a file
	 * @property {boolean} changesOpen the commit panel is showing
	 * @property {() => void} onchanges opens or closes the commit panel
	 * @property {() => void} onconflicts shows the open merge
	 */

	/** @type {Props} */
	let { sync, autosave, unsavedNotes, changesOpen, onchanges, onconflicts } = $props();

	let confirmingUndo = $state(false);

	/** The push is over a limit, so the commits have to be made again in smaller groups. */
	const canUndo = $derived.by(() => {
		const code = $sync.report?.code;
		return $sync.ahead > 0 && (code === ErrorCode.PUSH_TOO_LARGE || code === ErrorCode.HOST_FILE_TOO_LARGE || code === ErrorCode.HOST_REPO_TOO_LARGE);
	});
	const needsSignIn = $derived($sync.report?.code === ErrorCode.AUTH_REQUIRED);
	const needsPull = $derived($sync.report?.code === ErrorCode.NON_FAST_FORWARD);
	const blocked = $derived($sync.merge !== null || $sync.mergeDamaged);
	const unpushed = $derived(`${$sync.ahead} unpushed ${$sync.ahead === 1 ? 'commit' : 'commits'}`);

	const undo = async () => {
		confirmingUndo = false;
		await sync.undoUnpushed();
	};
</script>

<section class="flex flex-col border-b border-gray-200 text-sm" aria-label="Sync" data-testid="sync-status">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1 p-2">
		{#if !$sync.online}
			<span class="rounded bg-amber-100 px-2 py-1 font-medium text-amber-900" data-testid="offline-badge">Offline</span>
		{/if}
		<span data-testid="sync-branch" class="font-medium">{$sync.branch}</span>
		<span data-testid="sync-ahead" title="Commits only on this device">{unpushed}</span>
		<span data-testid="sync-behind" title="Commits only on the remote, as of the last check">{$sync.behind} behind</span>
		{#if $sync.pushPending}
			<span class="rounded bg-amber-100 px-2 py-1 text-amber-900" data-testid="push-pending">Push waiting for the network</span>
		{/if}
		<span class="text-gray-600" data-testid="last-sync">{$sync.lastSyncAt ? `Last sync ${new Date($sync.lastSyncAt).toLocaleString()}` : 'Not synced yet'}</span>
		{#if autosave.enabled}
			<span class="rounded bg-gray-100 px-2 py-1" data-testid="autosave-badge">{blocked ? 'Autosave stopped until the merge is done' : 'Autosave on (beta)'}</span>
		{/if}
		<span class="flex flex-1 flex-wrap justify-end gap-2">
			{#if $sync.merge}
				<button type="button" class="min-h-11 rounded bg-amber-700 px-3 text-white" onclick={onconflicts} data-testid="show-conflicts">Resolve conflicts</button>
			{:else}
				<button type="button" class="min-h-11 rounded border border-gray-400 px-3 aria-pressed:bg-gray-900 aria-pressed:text-white" aria-pressed={changesOpen} disabled={blocked} onclick={onchanges} data-testid="open-changes">Changes ({$sync.files.length})</button>
			{/if}
			<button type="button" class="min-h-11 rounded border border-gray-400 px-3 disabled:opacity-50" disabled={blocked || $sync.syncing !== null} onclick={() => sync.pull()} data-testid="pull-button">{$sync.syncing === 'pull' ? 'Pulling…' : 'Pull'}</button>
			<button type="button" class="min-h-11 rounded border border-gray-400 px-3 disabled:opacity-50" disabled={blocked || $sync.syncing !== null || ($sync.ahead === 0 && $sync.hasRemote)} onclick={() => sync.push()} data-testid="push-button">{$sync.syncing === 'push' ? 'Pushing…' : 'Push'}</button>
		</span>
	</div>

	{#if $sync.pullHeldBack}
		<div role="status" class="flex flex-wrap items-center gap-2 bg-amber-50 p-2 text-amber-800" data-testid="pull-held-back">
			<p class="min-w-0 flex-1">Nothing was pulled, because {$sync.files.length} {$sync.files.length === 1 ? 'file has' : 'files have'} uncommitted changes. Commit or discard them, then pull.</p>
			{#if !changesOpen}
				<button type="button" class="min-h-11 rounded border border-amber-800 px-3" onclick={onchanges} data-testid="review-changes">Review changes</button>
			{/if}
		</div>
	{/if}
	{#if unsavedNotes > 0 && !$sync.merge}
		<p role="status" class="bg-gray-100 p-2" data-testid="unsaved-notes">{unsavedNotes} {unsavedNotes === 1 ? 'note has' : 'notes have'} unsaved text, which commits and pulls leave out. If a pull changes such a file, you choose between the two when you open it.</p>
	{/if}
	{#if $sync.needsAuthor}
		<p role="alert" class="bg-amber-50 p-2 text-amber-800" data-testid="needs-author">Commits and merges need an author. <a class="underline" href={resolve('/settings')}>Set your name and email in Settings</a>.</p>
	{/if}
	{#if autosave.enabled && autosave.skipped.length > 0}
		<p role="status" class="bg-amber-50 p-2 text-amber-800" data-testid="autosave-skipped">Autosave left out {autosave.skipped.join(', ')}: the file changed after you started editing. Open it to choose which version to keep.</p>
	{/if}
	{#if $sync.report && !$sync.mergeDamaged}
		<div role="alert" class="flex flex-wrap items-center gap-2 bg-red-50 p-2 text-red-700" data-testid="sync-report">
			<p class="min-w-0 flex-1">{$sync.report.message}</p>
			{#if needsSignIn}
				<a class="underline" href={resolve('/connect')} data-testid="sync-sign-in">Sign in again</a>
			{/if}
			{#if needsPull}
				<button type="button" class="min-h-11 rounded border border-red-700 px-3" onclick={() => sync.pull()} data-testid="report-pull">Pull now</button>
			{/if}
			{#if canUndo && confirmingUndo}
				<button type="button" class="min-h-11 rounded bg-red-700 px-3 text-white" onclick={undo} data-testid="undo-confirm">Undo {unpushed}; files stay as changes</button>
				<button type="button" class="min-h-11 rounded border border-red-700 px-3" onclick={() => (confirmingUndo = false)}>Keep them</button>
			{:else if canUndo}
				<button type="button" class="min-h-11 rounded border border-red-700 px-3" onclick={() => (confirmingUndo = true)} data-testid="undo-unpushed">Undo unpushed commits</button>
			{/if}
		</div>
	{/if}
	{#if $sync.mergeDamaged}
		<div role="alert" class="flex flex-wrap items-center gap-2 bg-red-50 p-2 text-red-700" data-testid="merge-damaged">
			<p class="min-w-0 flex-1">The record of an open merge is damaged, so it cannot be resumed. Resetting closes it and keeps your files as they are, as uncommitted changes you can commit or discard. Any conflict markers stay in the files until you remove them.</p>
			<button type="button" class="min-h-11 rounded border border-red-700 px-3" onclick={() => sync.resetDamagedMerge()} data-testid="reset-merge">Reset the merge</button>
		</div>
	{/if}
</section>
