---
name: artifacts
description: Use when creating artifacts (rendered markdown docs, HTML pages, or self-contained React UI) for design previews, interactive mocks, or durable docs that can be iterated on.
---

# Artifacts

Publish rendered content into the conversation with `create_artifact` / `update_artifact`. Do **not** write design-preview files into the workspace unless the user explicitly asks for files on disk. Artifacts render inside the conversation.

- Reusing an existing title in the same thread updates that artifact (new version) instead of creating a duplicate.
- `update_artifact` replaces content only (full replacement, not a patch); `title` and `contentType` are fixed at creation.

## React UI (`contentType: "react"`), the default for most scenarios

The preview is a sandboxed iframe (`allow-scripts` only) with React 19 and Babel JSX in scope: no bundler, no `import`/`require`, no npm packages, no `localStorage`/`sessionStorage`, no forms, no popups.

1. Define a component named **`App`** (function or const); that is what mounts.
2. Self-contained: components, styles (inline `<style>` or `style={{ ... }}`), and copy in one artifact. External assets only via public CDN URLs.
3. React 19 APIs only (`React.useState`, etc.), not React 18 APIs.
4. Compose a complete first-viewport page for design review, not a fragment.

```jsx
function App() {
	return (
		<div>
			<style>{`/* page styles */`}</style>
			<header>…</header>
			<main>…</main>
		</div>
	);
}
```

## HTML (`contentType: "html"`)

Provide a complete HTML document (`<!DOCTYPE html>…`) when React is unnecessary.
