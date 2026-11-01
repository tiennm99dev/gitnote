<script>
	import { SvelteSet } from 'svelte/reactivity';
	import { formatBytes } from '#lib/git/limits.js';
	import { buildTree, foldersAbove } from '#lib/notes/tree.js';

	/** @typedef {import('#lib/notes/tree.js').TreeNode} TreeNode */

	/**
	 * @typedef {object} Props
	 * @property {readonly { path: string, size: number }[]} entries
	 * @property {readonly string[]} draftPaths
	 * @property {string} current the open path
	 * @property {(path: string) => string} hrefFor
	 * @property {() => void} onopen a file link was followed
	 * @property {(path: string, isFolder: boolean) => void} onrename
	 * @property {(path: string, isFolder: boolean) => void} ondelete
	 */

	/** @type {Props} */
	let { entries, draftPaths, current, hrefFor, onopen, onrename, ondelete } = $props();

	let filter = $state('');
	const expanded = new SvelteSet();
	/** @type {string | null} */
	let actionsFor = $state(null);

	const nodes = $derived(buildTree(entries, draftPaths, filter));
	const filtering = $derived(filter.trim() !== '');

	$effect(() => {
		for (const folder of foldersAbove(current)) expanded.add(folder);
	});

	/** @param {string} path */
	const toggle = (path) => {
		if (expanded.has(path)) expanded.delete(path);
		else expanded.add(path);
	};
</script>

{#snippet actions(/** @type {TreeNode} */ node)}
	<button type="button" class="min-h-11 min-w-11 shrink-0 rounded text-gray-600 hover:bg-gray-100" aria-label="Actions for {node.name}" aria-expanded={actionsFor === node.path} data-testid="tree-actions" onclick={() => (actionsFor = actionsFor === node.path ? null : node.path)}>…</button>
{/snippet}

{#snippet actionPanel(/** @type {TreeNode} */ node)}
	{#if actionsFor === node.path}
		<div class="flex gap-2 py-1 pl-2">
			<button
				type="button"
				class="min-h-11 rounded border border-gray-400 px-3"
				onclick={() => {
					actionsFor = null;
					onrename(node.path, node.type === 'folder');
				}}>Rename or move</button
			>
			<button
				type="button"
				class="min-h-11 rounded border border-red-700 px-3 text-red-700"
				onclick={() => {
					actionsFor = null;
					ondelete(node.path, node.type === 'folder');
				}}>Delete</button
			>
		</div>
	{/if}
{/snippet}

{#snippet branch(/** @type {TreeNode[]} */ items)}
	<ul class="flex flex-col">
		{#each items as node (node.path)}
			<li>
				<div class="flex items-center gap-1">
					{#if node.type === 'folder'}
						<button type="button" class="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded px-1 text-left font-medium hover:bg-gray-100" aria-expanded={filtering || expanded.has(node.path)} data-testid="tree-folder" onclick={() => toggle(node.path)}>
							<span aria-hidden="true">{filtering || expanded.has(node.path) ? '▾' : '▸'}</span>
							<span class="truncate">{node.name}</span>
							{#if node.unsaved}<span class="text-amber-700" title="Holds unsaved text">•</span>{/if}
						</button>
					{:else}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefFor builds the route with resolve() -->
						<a class="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded px-1 hover:bg-gray-100 aria-[current=page]:bg-gray-200" aria-current={node.path === current ? 'page' : undefined} href={hrefFor(node.path)} data-testid="tree-file" onclick={onopen}>
							<span class="truncate">{node.name}</span>
							{#if node.unsaved}<span class="text-amber-700" title="Unsaved text" data-testid="tree-unsaved">•</span>{/if}
						</a>
					{/if}
					{@render actions(node)}
				</div>
				{@render actionPanel(node)}
				{#if node.type === 'folder' && (filtering || expanded.has(node.path))}
					<div class="ml-3 border-l border-gray-200 pl-1">
						{@render branch(node.children)}
					</div>
				{:else if node.type === 'file' && actionsFor === node.path}
					<p class="pl-2 text-sm text-gray-600">{formatBytes(node.size)}</p>
				{/if}
			</li>
		{/each}
	</ul>
{/snippet}

<div class="flex flex-col gap-2">
	<label class="flex flex-col gap-1">
		<span class="text-sm text-gray-600">Filter files</span>
		<input class="rounded border border-gray-400 p-2" type="search" bind:value={filter} data-testid="tree-filter" />
	</label>
	{#if nodes.length === 0}
		<p class="text-sm text-gray-600" data-testid="tree-empty">{filtering ? 'No file matches.' : 'No files yet.'}</p>
	{:else}
		{@render branch(nodes)}
	{/if}
</div>
