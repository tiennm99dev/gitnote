<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { authSession } from '#lib/auth/index.js';
	import { isNative, watchSignInReturn } from '#lib/platform/native.js';
	import './layout.css';

	/** @type {{children: import('svelte').Snippet}} */
	let { children } = $props();

	onMount(() => {
		if (!isNative()) return;
		return watchSignInReturn({
			isAwaited: (url) => authSession.isAwaitedCallback(url),
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- the path comes from resolve(), and the query is the provider's
			open: (query) => goto(resolve('/auth/callback') + query, { replaceState: true })
		});
	});
</script>

<svelte:head>
	<title>gitnote</title>
</svelte:head>

{@render children()}
