import { use } from 'react';
import { MarkdownFileLinksContext, markdownFileTarget } from '$lib/chat/markdown-file-links';
import type { MarkdownImageScope } from '$lib/chat/markdown-images';
import { ReferenceCard } from '$lib/components/artifact-reference';

export default function KicadReference({
	path,
	imageScope
}: {
	path: string;
	imageScope?: MarkdownImageScope;
}) {
	const fileLinks = use(MarkdownFileLinksContext);
	// Encoded so `#`, `?`, and `%` in filenames survive the link parsing.
	const href = path.split('/').map(encodeURIComponent).join('/');
	const target = fileLinks ? markdownFileTarget(href, fileLinks.roots, imageScope) : null;

	return (
		<ReferenceCard
			data-kicad-reference={path}
			icon={<img src="/kicad.svg" alt="" className="size-5" />}
			title={projectName(path)}
			kind="KiCad project"
			onOpen={fileLinks && target ? () => fileLinks.open(target) : undefined}
		/>
	);
}

function projectName(path: string) {
	return path.slice(path.lastIndexOf('/') + 1, -'.kicad_pro'.length);
}
