<script>
	import './layout.css';

	/** @type {{children: import('svelte').Snippet}} */
	let { children } = $props();
</script>

<svelte:head>
	<title>gitnote</title>
</svelte:head>

{@render children()}
