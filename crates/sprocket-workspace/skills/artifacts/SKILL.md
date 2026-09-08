---
name: artifacts
description: Use when publishing or editing file-backed artifacts, including Markdown documents, HTML previews, and self-contained React mocks.
---

# Artifacts

1. Write a UTF-8 file with the normal file tools. Use `.md` for Markdown, `.html` for HTML, or `.jsx` for React. Other text files render as Markdown. Keep the file at or below 500,000 bytes.
2. Call `add_artifact` with `path` and `scope`. Relative paths resolve against the current workspace; absolute paths are also accepted. Use `"thread"` for work specific to this conversation or `"project"` for material shared across the project's threads.
3. To revise the content, edit the file normally. Rust detects changes and updates the preview and cloud copy while the thread or project is active.

`list_artifacts` returns IDs and paths for this thread and its project. After moving a file, call `edit_artifact` with `artifactId` and the new `path`. This changes the registration; it does not move or edit the file. The filename supplies the title. Missing files keep their last synced content and report a local error.

## React previews

The preview is a sandboxed iframe (`allow-scripts` only) with React 19 and Babel JSX in scope: no bundler, no `import`/`require`, no npm packages, no `localStorage`/`sessionStorage`, no forms, no popups.

1. Define a component named `App`, as a function or const. That is what mounts.
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

## HTML previews

Provide a complete HTML document (`<!DOCTYPE html>…`) when React is unnecessary.
