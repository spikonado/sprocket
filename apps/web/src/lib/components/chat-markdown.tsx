import { useMemo } from 'react';
import { cn } from '$lib/utils';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import { renderMarkdownBlocks } from '$lib/chat/markdown';
import ArtifactReference from '$lib/components/artifact-reference';

const NO_ARTIFACTS = new Set<string>();

export default function ChatMarkdown({
	content,
	className = '',
	artifacts = [],
	onOpenArtifact,
	onDeleteArtifact,
	openLinksInNewTab = false
}: {
	content: string;
	className?: string;
	artifacts?: ArtifactEntry[];
	onOpenArtifact?: (artifactId: string) => void;
	onDeleteArtifact?: (artifactId: string) => Promise<void>;
	openLinksInNewTab?: boolean;
}) {
	const artifactById = useMemo(
		() => new Map(artifacts.map((artifact) => [artifact.key, artifact])),
		[artifacts]
	);

	const blocks = useMemo(
		() =>
			renderMarkdownBlocks(
				content,
				onOpenArtifact ? new Set(artifactById.keys()) : NO_ARTIFACTS,
				openLinksInNewTab
			),
		[content, onOpenArtifact, artifactById, openLinksInNewTab]
	);

	return (
		<div className={cn('chat-markdown', className)}>
			{blocks.map((block, index) => {
				if (block.type === 'artifact') {
					const artifact = artifactById.get(block.artifactId);

					if (artifact && onOpenArtifact) {
						return (
							<ArtifactReference
								key={`${block.type}-${index}`}
								artifact={artifact}
								onOpen={() => onOpenArtifact(block.artifactId)}
								onDelete={onDeleteArtifact ? () => onDeleteArtifact(block.artifactId) : undefined}
							/>
						);
					}

					return null;
				}

				return (
					<div
						key={`${block.type}-${index}`}
						className="chat-markdown-html"
						dangerouslySetInnerHTML={{ __html: block.html }}
					/>
				);
			})}
		</div>
	);
}
