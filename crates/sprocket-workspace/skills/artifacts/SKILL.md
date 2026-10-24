---
name: artifacts
description: Use when working on artifacts or writing `html-visual` and `jsx-visual` blocks.
---

# Artifacts

1. Write a UTF-8 file with the normal file tools. Use `.md` for Markdown, `.html` for HTML, and `.jsx` for React. Other text files render as Markdown. Keep the file at or below 500,000 bytes.
2. Call `add_artifact` with the absolute or relative `path` to the file. The artifact belongs to the current project, so all of its threads see it.
3. To revise the content, edit the file normally. Sprocket syncs the edits to the artifact.
4. In your response, put `artifact:<artifactId>` in its own paragraph for each artifact the user should see, for example `artifact:ks73zzsnfj2najtd871p43f45s8ec23d`.

`list_artifacts` returns IDs and metadata for the current project. Artifacts can render from the cloud without a local file. To work on one locally, call `save_artifact` with `artifactId` and an absolute `path` or one relative to the current working directory. This saves and binds the file so future edits sync. An existing destination must have identical content; otherwise choose another path.

After moving a file, call `edit_artifact` with `artifactId` and the new `path`. This binds the existing file and replaces the cloud content without touching the file. The filename supplies the title.

When a file goes missing, the artifact keeps its last preview and reports a local error. Sprocket doesn't recreate the file. If both cloud and disk changed, sync pauses. Inspect both versions, then resolve with `edit_artifact` or save the cloud version to a new path. An unchanged older local file never replaces newer cloud content.

## React previews

The preview is a sandboxed iframe (`allow-scripts` only) with React 19 and Babel JSX in scope: no bundler, no `import`/`require`, no npm packages, no `localStorage`/`sessionStorage`, no forms, no popups.

1. Define a component named `App`, as a function or const. That is what mounts.
2. Keep components, styles (inline `<style>` or `style={{ ... }}`), and copy in one artifact. Load external assets from public CDN URLs.
3. Use React 19 APIs (`React.useState`, etc.).
4. Render a complete page, not a fragment.

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

## Visuals

A fenced block tagged `html-visual` (an HTML document or fragment) or `jsx-visual` (React, following the rules above) renders inline in your message once its closing fence arrives. Use one for a chart, table, diagram, or mockup that belongs to this reply. Use an artifact instead when the user will revisit or edit the page.

- The frame is as wide as the message column and grows to fit the page, up to 1600px. Don't size anything with `vh` or `height: 100%`; give charts fixed pixel heights.
- The frame is transparent over the thread. Leave `html`, `body`, and the outermost element without a background, horizontal padding, border, or title. Give a box its own background only when it must stand apart, with at least 16px of padding and `var(--radius)` corners.
- `:root` carries the app's theme, and it updates live when the user switches light or dark mode. Use these tokens instead of fixed colors: `--background`, `--foreground`, `--surface`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--accent-strong`, `--accent-soft`, `--destructive`, `--destructive-foreground`, `--border`, `--input`, `--ring`, `--chart-1` to `--chart-5` for data series, `--radius`, `--font-sans`, and `--font-mono`.
- Check the page with `agent-browser` before sending it.
