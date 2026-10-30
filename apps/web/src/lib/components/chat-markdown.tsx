import { useMemo } from 'react';
import { cn } from '$lib/utils';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import { renderMarkdownBlocks } from '$lib/chat/markdown';
import ArtifactReference from '$lib/components/artifact-reference';
import MarkdownHtml from '$lib/components/markdown-html';
import MermaidDiagram from '$lib/components/mermaid-diagram';
import TranscriptVisual from '$lib/components/transcript-visual';
import type { MarkdownImageScope } from '$lib/chat/markdown-images';

const NO_ARTIFACTS = new Set<string>();

export default function ChatMarkdown({
	content,
	className = '',
	artifacts = [],
	onOpenArtifact,
	openLinksInNewTab = false,
	imageScope
}: {
	content: string;
	className?: string;
	artifacts?: ArtifactEntry[];
	onOpenArtifact?: (artifactId: string) => void;
	openLinksInNewTab?: boolean;
	imageScope?: MarkdownImageScope;
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
							/>
						);
					}

					return null;
				}

				if (block.type === 'visual') {
					return (
						<TranscriptVisual
							key={`${block.type}-${index}`}
							kind={block.kind}
							source={block.source}
						/>
					);
				}

				if (block.type === 'mermaid') {
					return (
						<MermaidDiagram
							key={`${block.type}-${index}`}
							source={block.source}
							codeHtml={block.codeHtml}
						/>
					);
				}

				return (
					<MarkdownHtml key={`${block.type}-${index}`} html={block.html} imageScope={imageScope} />
				);
			})}
		</div>
	);
}
