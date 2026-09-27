import { Check, ChevronDown, FolderPlus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss';
import type { Project } from '$lib/types/sprocket';
import { cn } from '$lib/utils';
import '$lib/components/home/create-thread-heading.css';

export default function CreateThreadHeading({
	projects,
	workspacePath,
	onProject,
	onAddProject
}: {
	projects: Project[];
	workspacePath: string | null;
	onProject: (workspacePath: string) => void;
	onAddProject: () => void;
}) {
	const selectedProject = projects.find((project) => project.workspacePath === workspacePath);
	const selectedProjectName = selectedProject?.displayName ?? 'Choose a project';
	const selectedProjectIndex = projects.findIndex(
		(project) => project.workspacePath === workspacePath
	);
	const [isOpen, setIsOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const rootElement = useRef<HTMLDivElement | null>(null);
	const triggerElement = useRef<HTMLButtonElement | null>(null);
	const menuItems = useRef<Array<HTMLButtonElement | null>>([]);

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

	const focusMenuItem = useCallback(
		(index: number) => {
			const itemCount = projects.length + 1;
			const nextIndex = (index + itemCount) % itemCount;
			setActiveIndex(nextIndex);
			queueMicrotask(() => menuItems.current[nextIndex]?.focus());
		},
		[projects.length]
	);

	const openMenu = useCallback(
		(index?: number) => {
			setIsOpen(true);
			focusMenuItem(index ?? (selectedProjectIndex >= 0 ? selectedProjectIndex : 0));
		},
		[focusMenuItem, selectedProjectIndex]
	);

	const closeMenu = useCallback((restoreFocus: boolean) => {
		setIsOpen(false);
		if (restoreFocus) {
			queueMicrotask(() => triggerElement.current?.focus());
		}
	}, []);

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

	function handleTriggerKeydown(event: React.KeyboardEvent<HTMLButtonElement>) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
			return;
		}

		event.preventDefault();
		openMenu(event.key === 'ArrowUp' ? projects.length : undefined);
	}

	function handleMenuKeydown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
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
				setIsOpen(false);
				break;
		}
	}

	useEffect(() => {
		if (!isOpen) {
			return;
		}

		return listenOpenMenuDismiss({
			getRoot: () => rootElement.current,
			onOutside: () => closeMenu(false),
			onEscape: () => closeMenu(true)
		});
	}, [isOpen, closeMenu]);

	useEffect(() => {
		if (projects.length === 0) {
			setIsOpen(false);
		}
	}, [projects.length]);

	return (
		<div ref={rootElement} className="create-thread-heading">
			{projects.length ? (
				<h1>
					What should we build in{' '}
					<span className="create-thread-project-phrase">
						<span className="create-thread-project-control">
							<button
								ref={triggerElement}
								type="button"
								className="create-thread-project-trigger"
								aria-label={`Select project. Current project: ${selectedProjectName}`}
								aria-haspopup="menu"
								aria-expanded={isOpen}
								aria-controls={isOpen ? 'create-thread-project-menu' : undefined}
								onClick={() => {
									if (isOpen) {
										closeMenu(false);
									} else {
										openMenu();
									}
								}}
								onKeyDown={handleTriggerKeydown}
							>
								<span>{selectedProjectName}</span>
								<ChevronDown className={isOpen ? 'is-open' : ''} aria-hidden="true" />
							</button>

							{isOpen ? (
								<span
									id="create-thread-project-menu"
									className="create-thread-project-menu"
									role="menu"
									aria-label="Projects"
								>
									<span className="create-thread-project-options">
										{projects.map((project, index) => (
											<button
												key={project.workspacePath}
												ref={(element) => {
													menuItems.current[index] = element;
												}}
												type="button"
												className={cn(
													activeIndex === index && 'active',
													project.workspacePath === workspacePath && 'selected'
												)}
												role="menuitemradio"
												aria-checked={project.workspacePath === workspacePath}
												aria-label={projectOptionLabel(project)}
												onPointerEnter={() => {
													setActiveIndex(index);
												}}
												onKeyDown={(event) => handleMenuKeydown(event, index)}
												onClick={() => selectProject(project)}
											>
												<span className="create-thread-project-option-label">
													<span>{project.displayName}</span>
													{hasDuplicateName(project) ? (
														<small title={project.workspacePath}>{project.workspacePath}</small>
													) : null}
												</span>
												<Check aria-hidden="true" />
											</button>
										))}
									</span>
									<span className="create-thread-project-menu-footer">
										<button
											ref={(element) => {
												menuItems.current[projects.length] = element;
											}}
											type="button"
											className={cn(activeIndex === projects.length && 'active')}
											role="menuitem"
											onPointerEnter={() => {
												setActiveIndex(projects.length);
											}}
											onKeyDown={(event) => handleMenuKeydown(event, projects.length)}
											onClick={addProject}
										>
											<FolderPlus aria-hidden="true" />
											<span>Add project</span>
										</button>
									</span>
								</span>
							) : null}
						</span>
						<span aria-hidden="true">?</span>
					</span>
				</h1>
			) : (
				<>
					<h1>What should we work on?</h1>
					<p className="text-muted-foreground mt-3 text-sm">
						Add a project to start your first thread.
					</p>
					<button
						type="button"
						className="mt-5 rounded-lg border border-[var(--hairline)] px-4 py-2 text-sm"
						onClick={onAddProject}
					>
						Add project
					</button>
				</>
			)}
		</div>
	);
}
