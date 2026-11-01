<script>
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import NoteWorkspace from '#lib/components/NoteWorkspace.svelte';
	import { listLocalRepos } from '#lib/git/local-repos.js';

	const repoId = $derived(page.params.id ?? '');
	const repo = $derived(listLocalRepos().find((item) => item.id === repoId && item.ready));
</script>

<svelte:head>
	<title>{repo ? `${repo.fullName} - gitnote` : 'gitnote'}</title>
</svelte:head>

{#if repo}
	{#key repo.id}
		<NoteWorkspace {repo} path={page.params.path ?? ''} />
	{/key}
{:else}
	<main class="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 p-6" data-testid="repo-not-here">
		<h1 class="text-2xl font-bold">This repository is not on this device</h1>
		<p>Clone it first, then open it from the list.</p>
		<a class="underline" href={resolve('/repos')}>Repositories</a>
	</main>
{/if}
