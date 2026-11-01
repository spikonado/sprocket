import { use } from 'react';
import { MarkdownFileLinksContext, markdownFileTarget } from '$lib/chat/markdown-file-links';
import type { MarkdownImageScope } from '$lib/chat/markdown-images';
import { leafName } from '$lib/chat/side-panel';
import { ReferenceCard } from '$lib/components/artifact-reference';

function kindOf(path: string) {
	if (path.endsWith('.kicad_pro')) return 'KiCad project';

	return path.endsWith('.kicad_sch') ? 'KiCad schematic' : 'KiCad board';
}

export default function KicadReference({
	path,
	imageScope
}: {
	path: string;
	imageScope?: MarkdownImageScope;
}) {
	const fileLinks = use(MarkdownFileLinksContext);
	const target = fileLinks ? markdownFileTarget(path, fileLinks.roots, imageScope) : null;

	return (
		<ReferenceCard
			data-kicad-reference={path}
			icon={<img src="/kicad.svg" alt="" className="size-5" />}
			title={leafName(path)}
			kind={kindOf(path)}
			onOpen={fileLinks && target ? () => fileLinks.open(target) : undefined}
		/>
	);
}
