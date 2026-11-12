import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, FolderOpen, Globe, Lock, Plus, type LucideIcon } from 'lucide-react';
import githubMarkSvg from 'devicon/icons/github/github-original.svg?raw';
import type { RepositoryVisibility } from '$lib/types/sprocket';

export type ProjectSource = 'folder' | 'clone' | 'create';

const githubMark = githubMarkSvg.replace('fill="#181616"', 'fill="currentColor"');

function GitHubMark({ Badge }: { Badge: LucideIcon }) {
	return (
		<span className="relative block size-7">
			<span
				className="block size-full [&_svg]:size-full"
				aria-hidden
				dangerouslySetInnerHTML={{ __html: githubMark }}
			/>
			<span className="bg-popover absolute -right-1.5 -bottom-1.5 flex size-4 items-center justify-center rounded-full">
				<Badge className="size-3.5" strokeWidth={2.5} />
			</span>
		</span>
	);
}

const sources: {
	id: ProjectSource;
	title: string;
	description: string;
	icon: ReactNode;
}[] = [
	{
		id: 'folder',
		title: 'Local folder',
		description: 'Open a folder that is already on this computer.',
		icon: <FolderOpen className="size-7" strokeWidth={1.6} />
	},
	{
		id: 'clone',
		title: 'Clone a repo',
		description: 'Copy a GitHub repo, or any git URL, into a new folder.',
		icon: <GitHubMark Badge={ArrowDown} />
	},
	{
		id: 'create',
		title: 'New GitHub repo',
		description: 'Create a repo on your GitHub account and a folder for it.',
		icon: <GitHubMark Badge={Plus} />
	}
];

const visibilities: {
	id: RepositoryVisibility;
	title: string;
	description: string;
	Icon: LucideIcon;
}[] = [
	{ id: 'private', title: 'Private', description: 'Only you and people you invite.', Icon: Lock },
	{ id: 'public', title: 'Public', description: 'Anyone on the internet can see it.', Icon: Globe }
];

const tileClass =
	'border-border hover:bg-hover-fill focus-visible:ring-ring flex min-w-0 flex-1 flex-col items-start gap-3 rounded-2xl border p-4 text-left transition outline-none focus-visible:ring-2';

export function SourceChooser({ onChoose }: { onChoose: (source: ProjectSource) => void }) {
	const firstRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		firstRef.current?.focus();
	}, []);

	return (
		<div className="flex flex-col gap-4 p-5">
			<h2 className="text-lg font-medium">Add project</h2>
			<div className="flex flex-col gap-3 sm:flex-row" role="group" aria-label="Project source">
				{sources.map(({ id, title, description, icon }, index) => (
					<button
						key={id}
						ref={index === 0 ? firstRef : undefined}
						type="button"
						className={tileClass}
						onClick={() => onChoose(id)}
					>
						<span className="text-foreground">{icon}</span>
						<span className="flex flex-col gap-1">
							<span className="text-foreground text-base font-medium">{title}</span>
							<span className="text-muted-foreground text-sm">{description}</span>
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

export function BackButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			className="text-muted-foreground hover:text-foreground hover:bg-hover-fill flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm transition"
			onClick={onClick}
		>
			<ArrowLeft className="size-4" strokeWidth={2} />
			Back
		</button>
	);
}

export function RepositoryForm({
	source,
	repository,
	visibility,
	signedIn,
	onRepositoryChange,
	onVisibilityChange,
	onBack,
	onNext
}: {
	source: 'clone' | 'create';
	repository: string;
	visibility: RepositoryVisibility;
	signedIn: boolean;
	onRepositoryChange: (repository: string) => void;
	onVisibilityChange: (visibility: RepositoryVisibility) => void;
	onBack: () => void;
	onNext: () => void;
}) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const canContinue = signedIn && repository.trim().length > 0;

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	return (
		<form
			className="flex flex-col gap-4 p-5"
			onSubmit={(event) => {
				event.preventDefault();

				if (canContinue) {
					onNext();
				}
			}}
		>
			<div className="flex items-center gap-2">
				<BackButton onClick={onBack} />
				<h2 className="text-lg font-medium">
					{source === 'clone' ? 'Clone a repo' : 'New GitHub repo'}
				</h2>
			</div>
			<label className="flex flex-col gap-1.5">
				<span className="text-muted-foreground text-sm">
					{source === 'clone' ? 'Repository' : 'Name'}
				</span>
				<input
					ref={inputRef}
					className="border-border text-foreground placeholder:text-muted-foreground focus:border-foreground/40 rounded-xl border bg-transparent px-3 py-2.5 text-base outline-none"
					value={repository}
					onChange={(event) => onRepositoryChange(event.currentTarget.value)}
					placeholder={
						source === 'clone' ? 'owner/repo or https://github.com/owner/repo' : 'my-robot'
					}
					aria-label={source === 'clone' ? 'Repository to clone' : 'Repository name'}
					autoComplete="off"
					spellCheck={false}
				/>
			</label>
			{source === 'create' && (
				<div className="flex flex-col gap-3 sm:flex-row" role="radiogroup" aria-label="Visibility">
					{visibilities.map(({ id, title, description, Icon }) => (
						<button
							key={id}
							type="button"
							role="radio"
							aria-checked={visibility === id}
							className={`${tileClass} ${visibility === id ? 'border-foreground/50 bg-hover-fill' : ''}`}
							onClick={() => onVisibilityChange(id)}
						>
							<span className="flex items-center gap-2">
								<Icon className="size-4" strokeWidth={2} />
								<span className="text-foreground text-sm font-medium">{title}</span>
							</span>
							<span className="text-muted-foreground text-sm">{description}</span>
						</button>
					))}
				</div>
			)}
			<div className="flex items-center justify-between gap-3">
				<p className="text-muted-foreground text-sm">
					{signedIn
						? 'Uses your GitHub login from Settings → Version Control.'
						: 'Sign in to use GitHub.'}
				</p>
				<button
					type="submit"
					className="border-border text-foreground bg-hover-fill hover:bg-hover-fill-strong shrink-0 rounded-lg border px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-40"
					disabled={!canContinue}
				>
					Choose folder
				</button>
			</div>
		</form>
	);
}
