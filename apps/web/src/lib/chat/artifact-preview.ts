import type { ArtifactType } from '@convex/lib/validators';
import { z } from 'zod';

const artifactTypeSchema = z.enum(['markdown', 'html', 'react']);

export function parseArtifactType(value: string): ArtifactType {
	const parsed = artifactTypeSchema.safeParse(value);

	return parsed.success ? parsed.data : 'markdown';
}

/** Escape sequences that would break out of the inline <script> holding the react source. */
function escapeInlineScript(source: string): string {
	return source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
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

const REACT_ERROR_STYLE = `<style>
  #artifact-error { margin: 16px; padding: 12px; border: 1px solid #f87171; border-radius: 8px; color: #b91c1c; font: 13px/1.5 ui-monospace, monospace; white-space: pre-wrap; }
</style>
`;

const REACT_ARTIFACT_STYLE = `<style>
  html, body, #root { margin: 0; min-height: 100%; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
</style>
`;

function reactDocument(source: string, headStart: string): string {
	const body = escapeInlineScript(source.trim());

	return previewDocumentShell(
		`${headStart}${REACT_ERROR_STYLE}<script src="https://unpkg.com/@babel/standalone@7.26.5/babel.min.js"></script>
<script>
window.addEventListener('error', (event) => {
  const root = document.getElementById('root');
  if (!root || root.hasChildNodes()) return;
  const el = document.createElement('div');
  el.id = 'artifact-error';
  el.textContent = 'Artifact failed to render: ' + (event.message || 'unknown error');
  root.appendChild(el);
});
</script>
`,
		`<div id="root"></div>
<script type="module">
import * as React from "https://esm.sh/react@19.1.0";
import { createRoot } from "https://esm.sh/react-dom@19.1.0/client";
window.React = React;
window.createRoot = createRoot;
window.exports = {};
window.require = (name) => {
  if (name === 'react') return React;
  if (name === 'react-dom' || name === 'react-dom/client') return { createRoot };
  if (name === 'react/jsx-runtime')
    return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment };
  throw new Error('Artifact previews cannot import "' + name + '"');
};
</script>
<script type="text/babel" data-presets="react" data-plugins="transform-modules-commonjs">
${body}

const __root = document.getElementById('root');
const __App = typeof App !== 'undefined' ? App : exports.default;
if (!__App) {
  __root.textContent = 'React artifact must define a function/component named App.';
} else {
  window.createRoot(__root).render(window.React.createElement(__App));
}
</script>`
	);
}

/** Build a full HTML document that mounts agent-authored React/JSX as `App`. */
export function buildReactPreviewDocument(source: string): string {
	return reactDocument(source, REACT_ARTIFACT_STYLE);
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
	if (artifactType === 'react') return buildReactPreviewDocument(content);

	if (artifactType === 'html') return buildHtmlPreviewDocument(content);

	return null;
}

export type VisualKind = Exclude<ArtifactType, 'markdown'>;

export const VISUAL_HEIGHT_MESSAGE = 'sprocket-visual-height';

export const VISUAL_THEME_MESSAGE = 'sprocket-visual-theme';

const VISUAL_THEME_TOKENS = [
	'--background',
	'--foreground',
	'--surface',
	'--card',
	'--card-foreground',
	'--popover',
	'--popover-foreground',
	'--primary',
	'--primary-foreground',
	'--secondary',
	'--secondary-foreground',
	'--muted',
	'--muted-foreground',
	'--accent',
	'--accent-foreground',
	'--accent-strong',
	'--accent-soft',
	'--destructive',
	'--destructive-foreground',
	'--border',
	'--input',
	'--ring',
	'--chart-1',
	'--chart-2',
	'--chart-3',
	'--chart-4',
	'--chart-5',
	'--radius'
];

// The frame cannot load the app's web fonts, so it gets system stacks.
const VISUAL_FONT_TOKENS =
	"--font-sans:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
	"--font-mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;";

const VISUAL_BASE_CSS =
	'html{color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}' +
	'body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}';

/** CSS that gives a visual the app's current theme tokens; the page itself stays transparent. */
export function readVisualThemeCss(): string {
	const root = document.documentElement;
	const style = getComputedStyle(root);

	const tokens = VISUAL_THEME_TOKENS.map(
		(name) => `${name}:${style.getPropertyValue(name).trim()};`
	).join('');

	const colorScheme = root.dataset.theme === 'dark' ? 'dark' : 'light';

	return `:root{color-scheme:${colorScheme};${tokens}${VISUAL_FONT_TOKENS}}${VISUAL_BASE_CSS}`;
}

// Restyles on theme messages and reports the page height so the frame can fit it.
const VISUAL_SCRIPT = `(function(){var s=document.getElementById('sprocket-theme'),r=document.documentElement;
addEventListener('message',function(e){var d=e.data;if(e.source===parent&&d&&d.type==='${VISUAL_THEME_MESSAGE}')s.textContent=d.css;});
new ResizeObserver(function(){parent.postMessage({type:'${VISUAL_HEIGHT_MESSAGE}',height:Math.ceil(r.getBoundingClientRect().height)},'*');}).observe(r);})();`;

function visualPrelude(themeCss: string): string {
	return `<style id="sprocket-theme">${themeCss}</style>\n<script>${VISUAL_SCRIPT}</script>\n`;
}

/** Build the document for a visual that an agent wrote inline in a message. */
export function buildVisualDocument(kind: VisualKind, source: string, themeCss: string): string {
	const prelude = visualPrelude(themeCss);

	if (kind === 'react') return reactDocument(source, prelude);

	const trimmed = source.trim();
	const doctype = /^<!doctype[^>]*>/i.exec(trimmed);

	if (!doctype && !/^<html[\s>]/i.test(trimmed)) return previewDocumentShell(prelude, trimmed);

	// Elements before <html> land in the implied <head>, ahead of the page's own styles.
	return `<!DOCTYPE html>${prelude}${doctype ? trimmed.slice(doctype[0].length) : trimmed}`;
}
