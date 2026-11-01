<script>
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { authSession } from '#lib/auth/index.js';
	import { PROVIDERS } from '#lib/auth/providers.js';
	import { assertAuthor } from '#lib/git/repo.js';
	import { accountAuthor, AUTOSAVE_INTERVALS, loadSettings, saveSettings } from '#lib/sync/settings.js';

	const stored = loadSettings();

	let authorName = $state(stored.authorName);
	let authorEmail = $state(stored.authorEmail);
	let autosave = $state(stored.autosave);
	let intervalMinutes = $state(stored.intervalMinutes);
	/** @type {string | null} */
	let failure = $state(null);
	let saved = $state(false);
	/** @type {{ label: string, name: string, email: string }[]} */
	let fallbacks = $state([]);

	onMount(async () => {
		try {
			fallbacks = (await authSession.listAccounts()).map(({ provider, user }) => ({ label: PROVIDERS[provider].label, ...accountAuthor(provider, user) }));
		} catch {
			// The form works without them; they only explain the empty-field default.
		}
	});

	const clearSaved = () => {
		saved = false;
	};

	/** @param {SubmitEvent} event */
	const submit = (event) => {
		event.preventDefault();
		failure = null;
		saved = false;
		const name = authorName.trim();
		const email = authorEmail.trim();
		try {
			// An empty field means the account's value, so only what was typed is checked.
			assertAuthor({ name: name || 'unset', email: email || 'unset' });
			saveSettings({ authorName: name, authorEmail: email, autosave, intervalMinutes });
			authorName = name;
			authorEmail = email;
			saved = true;
		} catch (error) {
			failure = error instanceof Error ? error.message : 'The settings could not be saved.';
		}
	};
</script>

<svelte:head>
	<title>Settings - gitnote</title>
</svelte:head>

<main class="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
	<header class="flex items-center justify-between gap-4">
		<h1 class="text-3xl font-bold">Settings</h1>
		<a class="underline" href={resolve('/repos')}>Repositories</a>
	</header>

	<form class="flex flex-col gap-6" onsubmit={submit} oninput={clearSaved}>
		<fieldset class="flex flex-col gap-3">
			<legend class="mb-1 text-xl font-semibold">Commit author</legend>
			<label class="flex flex-col gap-1">
				<span>Name</span>
				<input class="rounded border border-gray-400 p-2" type="text" autocomplete="name" bind:value={authorName} data-testid="author-name" />
			</label>
			<label class="flex flex-col gap-1">
				<span>Email</span>
				<input class="rounded border border-gray-400 p-2" type="text" autocomplete="email" bind:value={authorEmail} data-testid="author-email" />
			</label>
			<p class="text-sm text-gray-600">Leave a field empty to use your account's value.</p>
			{#each fallbacks as fallback (fallback.label)}
				<p class="text-sm text-gray-600" data-testid="author-fallback">{fallback.label}: {fallback.name || 'no name'} &lt;{fallback.email || 'no email'}&gt;</p>
			{/each}
		</fieldset>

		<fieldset class="flex flex-col gap-3">
			<legend class="mb-1 text-xl font-semibold">Autosave <span class="rounded bg-amber-100 px-2 py-0.5 text-sm font-medium text-amber-900">Beta</span></legend>
			<label class="flex min-h-11 items-center gap-2">
				<input type="checkbox" bind:checked={autosave} data-testid="autosave-toggle" />
				<span>Commit and push changes for me</span>
			</label>
			<label class="flex flex-col gap-1">
				<span>Every</span>
				<select class="rounded border border-gray-400 p-2 disabled:opacity-50" disabled={!autosave} bind:value={intervalMinutes} data-testid="autosave-interval">
					{#each AUTOSAVE_INTERVALS as minutes (minutes)}
						<option value={minutes}>{minutes} {minutes === 1 ? 'minute' : 'minutes'}</option>
					{/each}
				</select>
			</label>
			<p class="text-sm text-gray-600">It runs only while gitnote is open and showing. Going to the background commits on this device, and the push waits until you come back. A conflict stops it until you resolve it.</p>
		</fieldset>

		{#if failure}
			<p role="alert" class="text-red-700" data-testid="settings-error">{failure}</p>
		{/if}
		{#if saved}
			<p role="status" class="text-green-800" data-testid="settings-saved">Saved on this device.</p>
		{/if}
		<button type="submit" class="min-h-11 self-start rounded bg-gray-900 px-4 text-white" data-testid="settings-save">Save settings</button>
	</form>
</main>
