---
name: making-artifacts-and-visuals
description: Use before making or changing an artifact or an `html-visual`, `jsx-visual`, or `json-render` block.
---

# Artifacts and visuals

## Artifacts

1. Write the file as `.md`, `.html`, `.jsx` for React, or `.render.json` for json-render. Other text files render as Markdown. Artifact tools report a `.render.json` file's content type as `markdown`, and the UI still renders it as json-render.
2. Register it with `add_artifact`.
3. Revise it by editing the file.

When the bound file goes missing, the artifact keeps its last content, and `save_artifact` writes it back. When both the file and the cloud copy changed, sync pauses. Compare the two versions, then resolve it with `edit_artifact` or by saving the cloud copy to a new path with `save_artifact`.

## Visuals

Use the reply text around the fence only for what the page doesn't show.

An HTML or React visual's frame is transparent over the thread, as wide as the message column, and grows to fit the page up to 1600px.

- Leave `html`, `body`, and the outermost element without a background, horizontal padding, border, or title.
- Give a box its own background only when it must stand apart, with at least 16px of padding and `var(--radius)` corners.
- Size from content and fixed pixel heights, since a `vh` or `height: 100%` size follows the frame.
- Take every color from the `:root` tokens, which follow the user's light or dark theme live. Data series use `--chart-1` to `--chart-5`. Everything else uses `--background`, `--foreground`, `--surface`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--accent-strong`, `--accent-soft`, `--destructive`, `--destructive-foreground`, `--border`, `--input`, and `--ring`. Shape and type come from `--radius`, `--font-sans`, and `--font-mono`.

When verifying a visual through `agent-browser`, add a temporary `:root` block with values for the tokens it uses, since a standalone file has none.

## Pages

HTML and React pages, in artifacts and visuals alike, run in a sandboxed iframe that allows scripts only. They get no `localStorage`, `sessionStorage`, forms, or popups. Load libraries and assets from public CDN URLs.

An HTML page is a complete document (`<!DOCTYPE html>…`) or a fragment.

A React page is one JSX source compiled by Babel in the browser, with React 19 as the global `React`. It mounts the component named `App`, or the default export. Only `react` and `react-dom` imports resolve, so keep components and styles (inline `<style>` or `style={{ ... }}`) in that source.

## json-render

A `json-render` fence or a `.render.json` artifact holds a [json-render](https://json-render.dev/docs) spec. The app renders it with its own components and theme, so the spec carries content and layout only. Reach for it first for structured output such as tables, metrics, status cards, alerts, tabs, and simple bar or line charts. Use an HTML or React page for anything the components below can't express.

A spec is a flat map of elements. Each element has a `type`, its `props`, and `children` listing other element keys:

```json
{
	"root": "ci",
	"elements": {
		"ci": { "type": "Card", "props": { "title": "CI" }, "children": ["jobs"] },
		"jobs": {
			"type": "Table",
			"props": { "columns": ["Job", "Status"], "rows": [["lint", "pass"]] },
			"children": []
		}
	}
}
```

In a fence, write the spec as JSONL patches, one per line, so the UI fills in while the reply streams:

```text
{"op":"add","path":"/root","value":"ci"}
{"op":"add","path":"/elements/ci","value":{"type":"Card","props":{"title":"CI"},"children":["jobs"]}}
{"op":"add","path":"/elements/jobs","value":{"type":"Table","props":{"columns":["Job","Status"],"rows":[["lint","pass"]]},"children":[]}}
```

- Seed data under `state` and read it with `{ "$state": "/path" }`. Element-level `visible`, `repeat`, and `on` fields, with the built-in `setState`, `pushState`, and `removeState` actions, make a UI interactive. Look up their syntax in the [data binding](https://json-render.dev/docs/data-binding) and [visibility](https://json-render.dev/docs/visibility) docs.
- Leave `className` unset, since the app only ships the classes its own components use.

Components:

<!-- json-render-components:start -->

- Card: { title?: string, description?: string, maxWidth?: "sm" | "md" | "lg" | "full", centered?: boolean, className?: string } - Container card for content sections. Use for forms/content boxes, NOT for page headers. [accepts children]
- Stack: { direction?: "horizontal" | "vertical", gap?: "none" | "sm" | "md" | "lg" | "xl", align?: "start" | "center" | "end" | "stretch", justify?: "start" | "center" | "end" | "between" | "around", className?: string } - Flex container for layouts [accepts children]
- Grid: { columns?: number, gap?: "sm" | "md" | "lg" | "xl", className?: string } - Grid layout (1-6 columns) [accepts children]
- Separator: { orientation?: "horizontal" | "vertical" } - Visual separator line
- Tabs: { tabs: Array<{ label: string, value: string }>, defaultValue?: string, value?: string } - Tab navigation. Use { $bindState } on value for active tab binding. [accepts children] [events: change]
- Accordion: { items: Array<{ title: string, content: string }>, type?: "single" | "multiple" } - Collapsible sections. Items as [{title, content}]. Type 'single' (default) or 'multiple'.
- Collapsible: { title: string, defaultOpen?: boolean } - Collapsible section with trigger. Children render inside. [accepts children]
- Dialog: { title: string, description?: string, openPath: string } - Modal dialog. Set openPath to a boolean state path. Use setState to toggle. [accepts children]
- Drawer: { title: string, description?: string, openPath: string } - Bottom sheet drawer. Set openPath to a boolean state path. Use setState to toggle. [accepts children]
- Carousel: { items: Array<{ title?: string, description?: string }> } - Horizontally scrollable carousel of cards.
- Table: { columns: Array<string>, rows: Array<Array<string>>, caption?: string } - Data table. columns: header labels. rows: 2D array of cell strings, e.g. [["Alice","admin"],["Bob","user"]].
- Heading: { text: string, level?: "h1" | "h2" | "h3" | "h4" } - Heading text (h1-h4)
- Text: { text: string, variant?: "body" | "caption" | "muted" | "lead" | "code" } - Paragraph text
- Image: { src?: string, alt: string, width?: number, height?: number } - Image component. Renders an img tag when src is provided, otherwise a placeholder.
- Avatar: { src?: string, name: string, size?: "sm" | "md" | "lg" } - User avatar with fallback initials
- Badge: { text: string, variant?: "default" | "secondary" | "destructive" | "outline" } - Status badge
- Alert: { title: string, message?: string, type?: "info" | "success" | "warning" | "error" } - Alert banner
- Progress: { value: number, max?: number, label?: string } - Progress bar (value 0-100)
- Skeleton: { width?: string, height?: string, rounded?: boolean } - Loading placeholder skeleton
- Spinner: { size?: "sm" | "md" | "lg", label?: string } - Loading spinner indicator
- Tooltip: { content: string, text: string } - Hover tooltip. Shows content on hover over text.
- Popover: { trigger: string, content: string } - Popover that appears on click of trigger.
- Input: { label: string, name: string, type?: "text" | "email" | "password" | "number", placeholder?: string, value?: string, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Text input field. Use { $bindState } on value for two-way binding. Use checks for validation (e.g. required, email, minLength). validateOn controls timing (default: blur). [events: submit, focus, blur]
- Textarea: { label: string, name: string, placeholder?: string, rows?: number, value?: string, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Multi-line text input. Use { $bindState } on value for binding. Use checks for validation. validateOn controls timing (default: blur).
- Select: { label: string, name: string, options: Array<string>, placeholder?: string, value?: string, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Dropdown select input. Use { $bindState } on value for binding. Use checks for validation. validateOn controls timing (default: change). [events: change]
- Checkbox: { label: string, name: string, checked?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Checkbox input. Use { $bindState } on checked for binding. Use checks for validation. validateOn controls timing (default: change). [events: change]
- Radio: { label: string, name: string, options: Array<string>, value?: string, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Radio button group. Use { $bindState } on value for binding. Use checks for validation. validateOn controls timing (default: change). [events: change]
- Switch: { label: string, name: string, checked?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Toggle switch. Use { $bindState } on checked for binding. Use checks for validation. validateOn controls timing (default: change). [events: change]
- Slider: { label?: string, min?: number, max?: number, step?: number, value?: number } - Range slider input. Use { $bindState } on value for binding. [events: change]
- Button: { label: string, variant?: "primary" | "secondary" | "danger", disabled?: boolean } - Clickable button. Bind on.press for handler. [events: press]
- Link: { label: string, href: string } - Anchor link. Bind on.press for click handler. [events: press]
- DropdownMenu: { label: string, items: Array<{ label: string, value: string }>, value?: string } - Dropdown menu with trigger button and selectable items. Use { $bindState } on value for selected item binding. [events: select]
- Toggle: { label: string, pressed?: boolean, variant?: "default" | "outline" } - Toggle button. Use { $bindState } on pressed for state binding. [events: change]
- ToggleGroup: { items: Array<{ label: string, value: string }>, type?: "single" | "multiple", value?: string } - Group of toggle buttons. Type 'single' (default) or 'multiple'. Use { $bindState } on value. [events: change]
- ButtonGroup: { buttons: Array<{ label: string, value: string }>, selected?: string } - Segmented button group. Use { $bindState } on selected for selected value. [events: change]
- Pagination: { totalPages: number, page?: number } - Page navigation. Use { $bindState } on page for current page number. [events: change]
- Metric: { label: string, value: string, detail?: string } - One headline number with its label. Put several in a Grid for a dashboard
- BarGraph: { title?: string, data: Array<{ label: string, value: number }> } - Vertical bar chart. Values must be zero or above
- LineGraph: { title?: string, data: Array<{ label: string, value: number }> } - Line chart through the data points in order

<!-- json-render-components:end -->
