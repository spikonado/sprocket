import type { ArtifactType } from '$convex/lib/validators';

const ARTIFACT_TYPES = new Set<ArtifactType>(['markdown', 'html', 'react']);

export function parseArtifactType(value: unknown): ArtifactType {
	if (typeof value === 'string' && ARTIFACT_TYPES.has(value as ArtifactType)) {
		return value as ArtifactType;
	}
	return 'markdown';
}

/**
 * Escape sequences that would let artifact source break out of its inline
 * script tag. Only used where the source lands inside a <script> element —
 * never on full documents (their own script tags must keep working).
 */
function escapeInlineScript(source: string): string {
	return source
		.replace(/<\/(script)/gi, '<\\/$1')
		.replace(/<!--/g, '<\\!--')
		.replace(/<(script)/gi, '<\\$1');
}

function previewDocumentShell(headExtra: string, body: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${headExtra}</head>
<body>
${body}
</body>
</html>`;
}

/** Build a full HTML document that mounts agent-authored React/JSX as `App`. */
export function buildReactPreviewDocument(source: string): string {
	const body = escapeInlineScript(source.trim());
	return previewDocumentShell(
		`<style>
  html, body, #root { margin: 0; min-height: 100%; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
</style>
<script src="https://unpkg.com/@babel/standalone@7.26.5/babel.min.js"></script>
`,
		`<div id="root"></div>
<script type="module">
import * as React from "https://esm.sh/react@19.1.0";
import { createRoot } from "https://esm.sh/react-dom@19.1.0/client";
window.__artifactRuntime = { React, createRoot };
</script>
<script type="text/babel" data-presets="react">
const { React, createRoot } = window.__artifactRuntime;
delete window.__artifactRuntime;

${body}

const __root = document.getElementById('root');
if (typeof App === 'undefined') {
  __root.textContent = 'React artifact must define a function/component named App.';
} else {
  createRoot(__root).render(React.createElement(App));
}
</script>`
	);
}

/** Normalize HTML artifact content into a document suitable for iframe srcdoc. */
export function buildHtmlPreviewDocument(source: string): string {
	const trimmed = source.trim();
	if (/^<!DOCTYPE html>/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
		return trimmed;
	}
	return previewDocumentShell('', trimmed);
}

/** Returns null for artifact types that render as text rather than a live preview. */
export function buildArtifactPreviewDocument(
	artifactType: ArtifactType,
	content: string
): string | null {
	if (artifactType === 'react') {
		return buildReactPreviewDocument(content);
	}
	if (artifactType === 'html') {
		return buildHtmlPreviewDocument(content);
	}
	return null;
}
