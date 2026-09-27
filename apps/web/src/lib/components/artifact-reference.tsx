import { FileCode, FileText, Globe } from 'lucide-react';
import type { ArtifactEntry } from '$lib/chat/artifacts';

const TYPE_ICONS = {
	markdown: FileText,
	html: Globe,
	react: FileCode
} as const;

export default function ArtifactReference({
	artifact,
	onOpen
}: {
	artifact: ArtifactEntry;
	onOpen: () => void;
}) {
	const TypeIcon = TYPE_ICONS[artifact.artifactType];

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
				<div className="text-muted-foreground mt-0.5 text-xs">
					Artifact · {artifact.scope === 'project' ? 'Project' : 'Thread'}
				</div>
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
