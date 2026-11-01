<script>
	import { resolve } from '$app/paths';
</script>

<main class="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 p-6">
	<h1 class="text-3xl font-bold" data-testid="app-title">gitnote</h1>
	<p class="text-gray-600">Markdown notes stored in your own git repository.</p>
	<nav class="flex gap-4">
		<a class="underline" href={resolve('/connect')}>Accounts</a>
		<a class="underline" href={resolve('/repos')}>Repositories</a>
	</nav>
</main>
