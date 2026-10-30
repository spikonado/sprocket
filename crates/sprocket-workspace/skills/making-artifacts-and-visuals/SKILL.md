---
name: making-artifacts-and-visuals
description: Use before making or changing an artifact or an `html-visual` or `jsx-visual` block.
---

# Artifacts and visuals

## Artifacts

1. Write the file as `.md`, `.html`, or `.jsx` for React. Other text files render as Markdown.
2. Register it with `add_artifact`.
3. Revise it by editing the file.

When the bound file goes missing, the artifact keeps its last content, and `save_artifact` writes it back. When both the file and the cloud copy changed, sync pauses. Compare the two versions, then resolve it with `edit_artifact` or by saving the cloud copy to a new path with `save_artifact`.

## Visuals

Use the reply text around the fence only for what the page doesn't show.

The frame is transparent over the thread, as wide as the message column, and grows to fit the page up to 1600px.

- Leave `html`, `body`, and the outermost element without a background, horizontal padding, border, or title.
- Give a box its own background only when it must stand apart, with at least 16px of padding and `var(--radius)` corners.
- Size from content and fixed pixel heights, since a `vh` or `height: 100%` size follows the frame.
- Take every color from the `:root` tokens, which follow the user's light or dark theme live. Data series use `--chart-1` to `--chart-5`. Everything else uses `--background`, `--foreground`, `--surface`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--accent-strong`, `--accent-soft`, `--destructive`, `--destructive-foreground`, `--border`, `--input`, and `--ring`. Shape and type come from `--radius`, `--font-sans`, and `--font-mono`.

## Pages

HTML and React pages, in artifacts and visuals alike, run in a sandboxed iframe that allows scripts only. They get no `localStorage`, `sessionStorage`, forms, or popups. Load libraries and assets from public CDN URLs.

An HTML page is a complete document (`<!DOCTYPE html>…`) or a fragment.

A React page is one JSX source compiled by Babel in the browser, with React 19 as the global `React`. It mounts the component named `App`, or the default export. Only `react` and `react-dom` imports resolve, so keep components and styles (inline `<style>` or `style={{ ... }}`) in that source.

Open the page in `agent-browser` before sending it. For a visual, add a temporary `:root` block with values for the tokens it uses, since a standalone file has none.
