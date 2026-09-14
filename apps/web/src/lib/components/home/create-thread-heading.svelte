<script lang="ts">
	import type { Project } from '$lib/types/sprocket';
	import { ChevronDown } from '@lucide/svelte';

	let {
		projects,
		workspacePath,
		onProject,
		onAddProject
	}: {
		projects: Project[];
		workspacePath: string | null;
		onProject: (workspacePath: string) => void;
		onAddProject: () => void;
	} = $props();

	const selectedProject = $derived(
		projects.find((project) => project.workspacePath === workspacePath)
	);
	const selectedProjectName = $derived(selectedProject?.displayName ?? 'Choose a project');

	function projectOptionLabel(project: Project) {
		const duplicateName = projects.some(
			(other) =>
				other.workspacePath !== project.workspacePath && other.displayName === project.displayName
		);
		return duplicateName
			? `${project.displayName} (${project.workspacePath})`
			: project.displayName;
	}
</script>

<div class="create-thread-heading">
	{#if projects.length}
		<h1
			aria-label={selectedProject
				? `What should we build in ${selectedProjectName}?`
				: 'Choose a project for your new thread'}
		>
			What should we build in <span class="create-thread-project-phrase"
				><span class="create-thread-project"
					><span aria-hidden="true">{selectedProjectName}</span><ChevronDown
						size={18}
						aria-hidden="true"
					/><select
						aria-label="Project for new thread"
						value={workspacePath ?? ''}
						onchange={(event) => {
							const selectedWorkspacePath = event.currentTarget.value;
							if (selectedWorkspacePath === '__add__') {
								event.currentTarget.value = workspacePath ?? '';
								onAddProject();
							} else {
								onProject(selectedWorkspacePath);
							}
						}}
						><option value="" disabled>Choose a project</option
						>{#each projects as project (project.workspacePath)}<option
								value={project.workspacePath}>{projectOptionLabel(project)}</option
							>{/each}<option value="__add__">Create/Add project…</option></select
					></span
				>?</span
			>
		</h1>
	{:else}
		<h1>What should we work on?</h1>
		<p class="text-muted-foreground mt-3 text-sm">Add a project to start your first thread.</p>
		<button
			type="button"
			class="mt-5 rounded-lg border border-[var(--hairline)] px-4 py-2 text-sm"
			onclick={onAddProject}>Add project</button
		>
	{/if}
</div>
