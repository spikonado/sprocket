<script lang="ts">
	import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss.svelte';
	import type { Project } from '$lib/types/sprocket';
	import { Check, ChevronDown, FolderPlus } from '@lucide/svelte';

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
	const selectedProjectIndex = $derived(
		projects.findIndex((project) => project.workspacePath === workspacePath)
	);
	let isOpen = $state(false);
	let activeIndex = $state(0);
	let rootElement = $state<HTMLDivElement | null>(null);
	let triggerElement = $state<HTMLButtonElement | null>(null);
	let menuItems = $state<HTMLButtonElement[]>([]);

	function hasDuplicateName(project: Project) {
		return projects.some(
			(other) =>
				other.workspacePath !== project.workspacePath && other.displayName === project.displayName
		);
	}

	function projectOptionLabel(project: Project) {
		return hasDuplicateName(project)
			? `${project.displayName}, ${project.workspacePath}`
			: project.displayName;
	}

	function focusMenuItem(index: number) {
		const itemCount = projects.length + 1;
		activeIndex = (index + itemCount) % itemCount;
		queueMicrotask(() => menuItems[activeIndex]?.focus());
	}

	function openMenu(index = selectedProjectIndex >= 0 ? selectedProjectIndex : 0) {
		isOpen = true;
		focusMenuItem(index);
	}

	function closeMenu(restoreFocus: boolean) {
		isOpen = false;
		if (restoreFocus) {
			queueMicrotask(() => triggerElement?.focus());
		}
	}

	function selectProject(project: Project) {
		closeMenu(true);
		if (project.workspacePath !== workspacePath) {
			onProject(project.workspacePath);
		}
	}

	function addProject() {
		closeMenu(false);
		onAddProject();
	}

	function activateMenuItem(index: number) {
		const project = projects[index];
		if (project) {
			selectProject(project);
			return;
		}

		addProject();
	}

	function handleTriggerKeydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
			return;
		}

		event.preventDefault();
		openMenu(event.key === 'ArrowUp' ? projects.length : undefined);
	}

	function handleMenuKeydown(event: KeyboardEvent, index: number) {
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				focusMenuItem(index + 1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				focusMenuItem(index - 1);
				break;
			case 'Home':
				event.preventDefault();
				focusMenuItem(0);
				break;
			case 'End':
				event.preventDefault();
				focusMenuItem(projects.length);
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				activateMenuItem(index);
				break;
			case 'Tab':
				isOpen = false;
				break;
		}
	}

	$effect(() => {
		if (!isOpen) {
			return;
		}

		return listenOpenMenuDismiss({
			getRoot: () => rootElement,
			onOutside: () => closeMenu(false),
			onEscape: () => closeMenu(true)
		});
	});

	$effect(() => {
		if (projects.length === 0) {
			isOpen = false;
		}
	});
</script>

<div bind:this={rootElement} class="create-thread-heading">
	{#if projects.length}
		<h1>
			What should we build in <span class="create-thread-project-phrase"
				><span class="create-thread-project-control"
					><button
						bind:this={triggerElement}
						type="button"
						class="create-thread-project-trigger"
						aria-label={`Select project. Current project: ${selectedProjectName}`}
						aria-haspopup="menu"
						aria-expanded={isOpen}
						aria-controls={isOpen ? 'create-thread-project-menu' : undefined}
						onclick={() => {
							if (isOpen) {
								closeMenu(false);
							} else {
								openMenu();
							}
						}}
						onkeydown={handleTriggerKeydown}
					>
						<span>{selectedProjectName}</span>
						<ChevronDown class={isOpen ? 'is-open' : ''} aria-hidden="true" />
					</button>

					{#if isOpen}
						<span
							id="create-thread-project-menu"
							class="create-thread-project-menu"
							role="menu"
							aria-label="Projects"
						>
							<span class="create-thread-project-options">
								{#each projects as project, index (project.workspacePath)}
									<button
										bind:this={menuItems[index]}
										type="button"
										class:active={activeIndex === index}
										class:selected={project.workspacePath === workspacePath}
										role="menuitemradio"
										aria-checked={project.workspacePath === workspacePath}
										aria-label={projectOptionLabel(project)}
										onpointerenter={() => {
											activeIndex = index;
										}}
										onkeydown={(event) => handleMenuKeydown(event, index)}
										onclick={() => selectProject(project)}
									>
										<span class="create-thread-project-option-label">
											<span>{project.displayName}</span>
											{#if hasDuplicateName(project)}
												<small title={project.workspacePath}>{project.workspacePath}</small>
											{/if}
										</span>
										<Check aria-hidden="true" />
									</button>
								{/each}
							</span>
							<span class="create-thread-project-menu-footer">
								<button
									bind:this={menuItems[projects.length]}
									type="button"
									class:active={activeIndex === projects.length}
									role="menuitem"
									onpointerenter={() => {
										activeIndex = projects.length;
									}}
									onkeydown={(event) => handleMenuKeydown(event, projects.length)}
									onclick={addProject}
								>
									<FolderPlus aria-hidden="true" />
									<span>Add project</span>
								</button>
							</span>
						</span>
					{/if}</span
				><span aria-hidden="true">?</span></span
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
