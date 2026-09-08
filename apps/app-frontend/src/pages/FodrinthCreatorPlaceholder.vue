<script setup>
defineProps({
	title: {
		type: String,
		required: true,
	},
	description: {
		type: String,
		required: true,
	},
})
</script>

<template>
	<div class="p-6 md:p-8">
		<div class="mx-auto max-w-5xl">
			<h1 class="m-0 text-3xl font-bold text-contrast">{{ title }}</h1>
			<p class="mt-2 text-secondary">{{ description }}</p>

			<div
				class="mt-6 flex min-h-72 items-center justify-center rounded-2xl border border-solid border-surface-4 bg-bg-raised p-8"
			>
				<div class="max-w-md text-center">
					<div class="text-xs font-semibold uppercase tracking-wider text-secondary">Fodrinth</div>
					<h2 class="mb-2 mt-2 text-xl font-semibold text-contrast">Coming soon</h2>
					<p class="m-0 text-secondary">
						This section is wired into the app and ready for the next implementation stage.
					</p>
				</div>
			</div>
		</div>
	</div>
</template>
