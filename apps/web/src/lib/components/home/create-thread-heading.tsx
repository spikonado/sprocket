import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss';
import ProjectSelectorMenu from './project-selector-menu';
import type { Project } from '$lib/types/sprocket';
import '$lib/components/home/create-thread-heading.css';

export default function CreateThreadHeading({
	projects,
	workspacePath,
	onProject,
	onAddProject,
	onRemoveProject
}: {
	projects: Project[];
	workspacePath: string | null;
	onProject: (workspacePath: string) => void;
	onAddProject: () => void;
	onRemoveProject?: (project: Project) => void;
}) {
	const selectedProject = projects.find((project) => project.workspacePath === workspacePath);
	const selectedProjectName = selectedProject?.displayName ?? 'Choose a project';
	const [isOpen, setIsOpen] = useState(false);
	const rootElement = useRef<HTMLDivElement | null>(null);
	const triggerElement = useRef<HTMLButtonElement | null>(null);
	const focusAddProject = useRef(false);

	const closeMenu = useCallback((restoreFocus: boolean) => {
		setIsOpen(false);

		if (restoreFocus) {
			queueMicrotask(() => triggerElement.current?.focus());
		}
	}, []);

	useEffect(() => {
		if (!isOpen) return;
		rootElement.current?.querySelector('input')?.focus();

		return listenOpenMenuDismiss({
			getRoot: () => rootElement.current,
			onOutside: () => closeMenu(false),
			onEscape: () => closeMenu(true)
		});
	}, [isOpen, closeMenu]);

	useEffect(() => {
		if (projects.length === 0) {
			setIsOpen(false);

			if (focusAddProject.current) {
				triggerElement.current?.focus();
				focusAddProject.current = false;
			}
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
								data-ph-capture-attribute-action="open_project_selector"
								aria-expanded={isOpen}
								onClick={() => setIsOpen(!isOpen)}
							>
								<span>{selectedProjectName}</span>
								<ChevronDown className={isOpen ? 'is-open' : ''} aria-hidden="true" />
							</button>
							{isOpen && (
								<ProjectSelectorMenu
									projects={projects}
									isSelected={(project) => project.workspacePath === workspacePath}
									onSelect={(project) => {
										closeMenu(true);

										if (project.workspacePath !== workspacePath) onProject(project.workspacePath);
									}}
									onAddProject={() => {
										closeMenu(false);
										onAddProject();
									}}
									onRemoveProject={
										onRemoveProject
											? (project) => {
													focusAddProject.current = projects.length === 1;
													closeMenu(true);
													onRemoveProject(project);
												}
											: undefined
									}
								/>
							)}
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
						ref={triggerElement}
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
