import { FileCode, FileText, Globe, LayoutDashboard, type LucideIcon } from 'lucide-react';
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
		<div
			data-artifact-reference={artifact.key}
			className="bg-card my-3 flex min-w-0 items-center gap-3 rounded-lg border p-3 shadow-xs"
		>
			<div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md border">
				<TypeIcon className="text-muted-foreground size-4" aria-hidden="true" />
			</div>
			<div className="min-w-0 flex-1">
				<div className="text-foreground truncate text-sm font-medium">{artifact.title}</div>
				<div className="text-muted-foreground mt-0.5 text-xs">Artifact</div>
			</div>
			<button
				type="button"
				className="bg-background text-foreground hover:bg-muted shrink-0 rounded-md border px-3 py-1.5 text-sm font-medium transition"
				onClick={onOpen}
				aria-label={`View ${artifact.title}`}
			>
				View
			</button>
		</div>
	);
}
