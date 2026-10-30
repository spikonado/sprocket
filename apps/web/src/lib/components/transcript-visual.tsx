import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import {
	buildVisualDocument,
	readVisualThemeCss,
	VISUAL_HEIGHT_MESSAGE,
	VISUAL_THEME_MESSAGE,
	type VisualKind
} from '$lib/chat/artifact-preview';

const INITIAL_HEIGHT = 160;

const MAX_HEIGHT = 1600;

const heightMessageSchema = z.object({
	type: z.literal(VISUAL_HEIGHT_MESSAGE),
	height: z.number()
});

export default function TranscriptVisual({ kind, source }: { kind: VisualKind; source: string }) {
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(INITIAL_HEIGHT);

	// Later theme changes are posted to the page, so they restyle it without a reload.
	const srcDoc = useMemo(
		() => buildVisualDocument(kind, source, readVisualThemeCss()),
		[kind, source]
	);

	useEffect(() => {
		const frame = frameRef.current;

		if (!frame) return;

		const onMessage = (event: MessageEvent<unknown>) => {
			if (event.source !== frame.contentWindow) return;

			const message = heightMessageSchema.safeParse(event.data);

			if (message.success) setHeight(Math.min(MAX_HEIGHT, message.data.height));
		};

		const themeObserver = new MutationObserver(() => {
			frame.contentWindow?.postMessage(
				{ type: VISUAL_THEME_MESSAGE, css: readVisualThemeCss() },
				'*'
			);
		});

		window.addEventListener('message', onMessage);
		themeObserver.observe(document.documentElement, { attributeFilter: ['data-theme'] });

		return () => {
			window.removeEventListener('message', onMessage);
			themeObserver.disconnect();
		};
	}, []);

	return (
		<iframe
			ref={frameRef}
			title="Visual"
			srcDoc={srcDoc}
			sandbox="allow-scripts"
			className="my-3 block w-full border-0"
			style={{ height }}
		></iframe>
	);
}
