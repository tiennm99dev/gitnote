<script>
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { authSession } from '#lib/auth/index.js';
	import { PROVIDER_IDS, PROVIDERS } from '#lib/auth/providers.js';
	import { deleteDeviceRepo, openDeviceRepo } from '#lib/git/device-repos.js';
	import { describeLocalWork, describeWorkCounts, isSameWork, listLocalRepos, removeLocalCopies } from '#lib/git/local-repos.js';

	/** @typedef {import('#lib/git/limits.js').ProviderId} ProviderId */

	/** @type {import('#lib/auth/session.js').Account[]} */
	let accounts = $state([]);
	let loaded = $state(false);
	/** @type {Partial<Record<ProviderId, string>>} */
	let tokens = $state({});
	/** @type {Partial<Record<ProviderId, string>>} */
	let errors = $state({});
	/** @type {ProviderId | null} */
	let busy = $state(null);
	/**
	 * The sign-out being confirmed.
	 * @type {{ provider: ProviderId, work: import('#lib/git/local-repos.js').LocalWork[], wipe: boolean, changed: boolean } | null}
	 */
	let leaving = $state(null);

	/**
	 * @param {unknown} error
	 * @returns {string}
	 */
	const messageOf = (error) => (error instanceof Error ? error.message : 'Something went wrong.');

	const reload = async () => {
		accounts = await authSession.listAccounts();
	};

	onMount(() => {
		reload()
			.catch((error) => {
				errors = { github: messageOf(error) };
			})
			.finally(() => {
				loaded = true;
			});
	});

	/**
	 * @param {ProviderId} provider
	 * @param {() => Promise<void>} action
	 */
	const run = async (provider, action) => {
		busy = provider;
		errors = { ...errors, [provider]: undefined };
		try {
			await action();
		} catch (error) {
			errors = { ...errors, [provider]: messageOf(error) };
		} finally {
			busy = null;
		}
	};

	/**
	 * @param {ProviderId} provider
	 * @returns {Promise<void>}
	 */
	const signIn = (provider) =>
		run(provider, async () => {
			location.assign(await authSession.beginSignIn(provider));
		});

	/**
	 * @param {SubmitEvent} event
	 * @param {ProviderId} provider
	 * @returns {Promise<void>}
	 */
	const saveToken = (event, provider) => {
		event.preventDefault();
		return run(provider, async () => {
			await authSession.connectWithToken(provider, tokens[provider] ?? '');
			tokens = { ...tokens, [provider]: '' };
			await reload();
		});
	};

	/**
	 * @param {ProviderId} provider
	 * @returns {Promise<import('#lib/git/local-repos.js').LocalWork[]>}
	 */
	const countWork = (provider) =>
		describeLocalWork(
			listLocalRepos().filter((repo) => repo.provider === provider),
			openDeviceRepo
		);

	/**
	 * @param {ProviderId} provider
	 * @returns {Promise<void>}
	 */
	const startSignOut = (provider) =>
		run(provider, async () => {
			leaving = { provider, work: await countWork(provider), wipe: false, changed: false };
		});

	/**
	 * Another tab may have committed or cloned since the list was shown, so the
	 * choice stands only for what is there now: the recount stops before anything
	 * is deleted, and each deletion checks its copy again under the repo's lock. The
	 * sign-in goes last: with it still here, a deletion that fails can simply be
	 * tried again.
	 * @returns {Promise<void> | undefined}
	 */
	const finishSignOut = () => {
		if (!leaving) return;
		const { provider, work, wipe } = leaving;
		return run(provider, async () => {
			const current = await countWork(provider);
			if (!isSameWork(work, current)) {
				leaving = { provider, work: current, wipe: wipe && current.length > 0, changed: true };
				return;
			}
			if (wipe) {
				const { failed, changed } = await removeLocalCopies(work, deleteDeviceRepo);
				if (failed.length > 0 || changed.length > 0) {
					leaving = { provider, work: await countWork(provider), wipe, changed: changed.length > 0 };
					if (failed.length > 0) throw new Error(`Could not delete ${failed.map((repo) => repo.fullName).join(', ')}. You are still signed in, so you can try again.`);
					return;
				}
			}
			await authSession.signOut(provider);
			leaving = null;
			await reload();
		});
	};
</script>

<svelte:head>
	<title>Accounts - gitnote</title>
</svelte:head>

<main class="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
	<header class="flex items-baseline justify-between gap-4">
		<h1 class="text-3xl font-bold">Accounts</h1>
		<a class="underline" href={resolve('/repos')}>Repositories</a>
	</header>
	<p class="text-gray-600">Your sign-ins stay on this device. They go only to the git host, directly or through the gitnote relay, which stores nothing.</p>

	{#if loaded}
		{#each PROVIDER_IDS as id (id)}
			{@const provider = PROVIDERS[id]}
			{@const account = accounts.find((item) => item.provider === id)}
			<section class="flex flex-col gap-3 rounded border border-gray-300 p-4" data-testid={`account-${id}`}>
				<h2 class="text-xl font-semibold">{provider.label}</h2>

				{#if account}
					<p data-testid={`account-${id}-status`}>
						Connected as <strong>{account.user.login}</strong>
						({account.kind === 'token' ? 'pasted token' : 'signed in'}).
					</p>
					{#if account.needsSignIn}
						<p role="alert" class="text-red-700">This sign-in has ended. Sign in again or paste a new token; your notes on this device are safe.</p>
					{/if}
				{/if}

				{#if errors[id]}
					<p role="alert" class="text-red-700" data-testid={`account-${id}-error`}>{errors[id]}</p>
				{/if}

				{#if !account || account.needsSignIn}
					{#if authSession.signInAvailable(id)}
						<button type="button" class="self-start rounded bg-gray-900 px-3 py-2 text-white disabled:opacity-50" disabled={busy !== null} onclick={() => signIn(id)}>Sign in with {provider.label}</button>
					{:else}
						<p class="text-sm text-gray-600">{provider.label} sign-in is not set up in this build. You can paste a token.</p>
					{/if}

					<form class="flex flex-col gap-2" onsubmit={(event) => saveToken(event, id)}>
						<label class="flex flex-col gap-1">
							<span>Or paste a token</span>
							<input class="rounded border border-gray-400 p-2" type="password" autocomplete="off" spellcheck="false" required bind:value={tokens[id]} />
						</label>
						<p class="text-sm text-gray-600">
							{provider.tokenHint}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the provider's site, not an app route -->
							<a class="underline" href={provider.tokenUrl} target="_blank" rel="noreferrer">Create one</a>
						</p>
						<button type="submit" class="self-start rounded border border-gray-900 px-3 py-2 disabled:opacity-50" disabled={busy !== null}>Check and save</button>
					</form>
				{/if}

				{#if account}
					{#if leaving?.provider === id}
						<div class="flex flex-col gap-2 rounded bg-gray-100 p-3" data-testid={`sign-out-${id}`}>
							<p>Signing out removes the {provider.label} sign-in from this device.</p>
							{#if leaving.changed}
								<p role="alert" class="text-amber-800" data-testid="sign-out-changed">The copies on this device changed while this was open. Check the list, then choose again.</p>
							{/if}
							{#if leaving.work.length > 0}
								<ul class="list-disc pl-5">
									{#each leaving.work as item (item.repo.id)}
										<li data-testid="sign-out-work">{item.repo.fullName}: {describeWorkCounts(item)}</li>
									{/each}
								</ul>
								<label class="flex items-center gap-2">
									<input type="checkbox" bind:checked={leaving.wipe} />
									<span>Also delete these local copies, including anything not pushed</span>
								</label>
							{/if}
							<div class="flex gap-2">
								<button type="button" class="rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" disabled={busy !== null} onclick={finishSignOut}>
									{leaving.wipe ? 'Sign out and delete' : 'Sign out'}
								</button>
								<button
									type="button"
									class="rounded border border-gray-900 px-3 py-2 disabled:opacity-50"
									disabled={busy !== null}
									onclick={() => {
										leaving = null;
									}}>Keep signed in</button
								>
							</div>
						</div>
					{:else}
						<button type="button" class="self-start rounded border border-gray-900 px-3 py-2 disabled:opacity-50" disabled={busy !== null} onclick={() => startSignOut(id)}>Sign out</button>
					{/if}
				{/if}
			</section>
		{/each}
	{/if}
</main>
