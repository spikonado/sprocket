import { FileCode, FileText, Globe, LayoutDashboard, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import type { ArtifactPreviewType } from '$lib/chat/artifact-preview';

export const ARTIFACT_TYPE_ICONS: Record<ArtifactPreviewType, LucideIcon> = {
	markdown: FileText,
	html: Globe,
	react: FileCode,
	'json-render': LayoutDashboard
};

export default function ArtifactReference({
	artifact,
	onOpen
}: {
	artifact: ArtifactEntry;
	onOpen: () => void;
}) {
	const TypeIcon = ARTIFACT_TYPE_ICONS[artifact.artifactType];

	return (
		<ReferenceCard
			data-artifact-reference={artifact.key}
			icon={<TypeIcon className="text-muted-foreground size-4" aria-hidden="true" />}
			title={artifact.title}
			kind="Artifact"
			onOpen={onOpen}
		/>
	);
}

export function ReferenceCard({
	icon,
	title,
	kind,
	onOpen,
	...data
}: {
	icon: ReactNode;
	title: string;
	kind: string;
	onOpen?: () => void;
	[dataAttribute: `data-${string}`]: string;
}) {
	return (
		<div
			{...data}
			className="bg-card my-3 flex min-w-0 items-center gap-3 rounded-lg border p-3 shadow-xs"
		>
			<div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md border">
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<div className="text-foreground truncate text-sm font-medium">{title}</div>
				<div className="text-muted-foreground mt-0.5 text-xs">{kind}</div>
			</div>
			{onOpen ? (
				<button
					type="button"
					className="bg-background text-foreground hover:bg-muted shrink-0 rounded-md border px-3 py-1.5 text-sm font-medium transition"
					onClick={onOpen}
					aria-label={`View ${title}`}
				>
					View
				</button>
			) : null}
		</div>
	);
}
