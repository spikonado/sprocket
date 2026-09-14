<script lang="ts">
	import type { Project } from '$lib/types/sprocket';
	import { ChevronDown } from '@lucide/svelte';
	let {
		projects,
		repositoryKey,
		onProject,
		onAddProject
	}: {
		projects: Project[];
		repositoryKey: string | null;
		onProject: (key: string) => void;
		onAddProject: () => void;
	} = $props();
</script>

<div class="inbox-create-heading">
	{#if projects.length}
		<h1>
			What should we build in <span class="inbox-project-phrase"
				><span class="inbox-create-project"
					><span aria-hidden="true"
						>{projects.find((project) => project.repositoryKey === repositoryKey)?.displayName ??
							'Choose a project'}</span
					><ChevronDown size={18} aria-hidden="true" /><select
						aria-label="Project for new thread"
						value={repositoryKey ?? ''}
						onchange={(event) => {
							if (event.currentTarget.value === '__add__') onAddProject();
							else onProject(event.currentTarget.value);
						}}
						><option value="" disabled>Choose a project</option
						>{#each projects as project (project.repositoryKey)}<option
								value={project.repositoryKey}>{project.displayName}</option
							>{/each}<option value="__add__">Create/Add project…</option></select
					></span
				>?</span
			>
		</h1>
	{:else}
		<h1>What should we work on?</h1>
		<p class="text-muted-foreground mt-3 text-sm">Add a project to start your first thread.</p>
		<button
			class="mt-5 rounded-lg border border-[var(--hairline)] px-4 py-2 text-sm"
			onclick={onAddProject}>Add project</button
		>
	{/if}
</div>
