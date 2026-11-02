import { FolderPlus, Search, X } from 'lucide-react';
import { useState } from 'react';
import type { Project } from '$lib/types/sprocket';
import { cn } from '$lib/utils';

export default function ProjectSelectorMenu({
	projects,
	isSelected,
	allProjectsSelected = false,
	onSelect,
	onSelectAll,
	onAddProject,
	onRemoveProject
}: {
	projects: Project[];
	isSelected: (project: Project) => boolean;
	allProjectsSelected?: boolean;
	onSelect: (project: Project) => void;
	onSelectAll?: () => void;
	onAddProject: () => void;
	onRemoveProject?: (project: Project) => void;
}) {
	const [search, setSearch] = useState('');

	const filteredProjects = projects.filter((project) =>
		project.displayName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
	);

	return (
		<span className="inbox-project-menu" aria-label="Projects">
			<label className="inbox-project-search">
				<Search size={14} aria-hidden="true" />
				<input
					value={search}
					onChange={(event) => setSearch(event.currentTarget.value)}
					aria-label="Search projects"
					placeholder="Search projects"
				/>
			</label>
			<span className="inbox-project-list block">
				{onSelectAll && (
					<button
						type="button"
						className={cn('inbox-project-option', allProjectsSelected && 'inbox-project-selected')}
						aria-pressed={allProjectsSelected}
						onClick={() => {
							setSearch('');
							onSelectAll();
						}}
					>
						All projects
					</button>
				)}
				{filteredProjects.map((project) => {
					const duplicateName = projects.some(
						(other) =>
							other.workspacePath !== project.workspacePath &&
							other.displayName === project.displayName
					);

					const label = duplicateName
						? `${project.displayName}, ${project.workspacePath}`
						: project.displayName;

					return (
						<span className="flex items-center" key={project.workspacePath}>
							<button
								type="button"
								className={cn(
									'inbox-project-option',
									isSelected(project) && 'inbox-project-selected'
								)}
								aria-pressed={isSelected(project)}
								aria-label={label}
								title={project.workspacePath}
								onClick={() => {
									setSearch('');
									onSelect(project);
								}}
							>
								<span className="block truncate">{project.displayName}</span>
								{duplicateName && (
									<small className="text-muted-foreground block truncate font-mono">
										{project.workspacePath}
									</small>
								)}
							</button>
							{onRemoveProject && (
								<button
									type="button"
									className="inbox-icon shrink-0"
									aria-label={`Remove ${label} from project list`}
									title={`Remove ${project.workspacePath} from project list`}
									onClick={() => {
										setSearch('');
										onRemoveProject(project);
									}}
								>
									<X size={14} aria-hidden="true" />
								</button>
							)}
						</span>
					);
				})}
			</span>
			<span className="inbox-project-footer">
				<button
					type="button"
					className="inbox-project-option"
					onClick={() => {
						setSearch('');
						onAddProject();
					}}
				>
					<span className="inline-flex items-center gap-2">
						<FolderPlus size={14} aria-hidden="true" />
						Add project
					</span>
				</button>
			</span>
		</span>
	);
}
