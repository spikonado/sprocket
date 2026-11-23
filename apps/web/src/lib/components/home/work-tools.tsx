import { createElement, memo, use, useEffect, useLayoutEffect, useState } from 'react';
import { isCommandToolKind } from '@convex/lib/commandToolKinds';
import { fileLinkTarget, MarkdownFileLinksContext } from '$lib/chat/markdown-file-links';
import { toolKindIcon } from '$lib/chat/tool-icons';
import { useTranscriptExpanded, type TranscriptStore } from '$lib/home/transcript-store';
import { useTranscriptRunRow } from '$lib/home/transcript-run';
import HighlightedCommand from './highlighted-command';
import SaveCardButton from './save-card-button';

type Props = { store: TranscriptStore; rowId: string };

export const workRowClass =
	'hover:text-foreground focus-visible:ring-ring/60 flex min-w-0 cursor-pointer items-start gap-1.5 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none';

const EXPANDING_TOOLS = new Set([
	'ask_question',
	'spawn_subagent',
	'control_subagent',
	'poll_subagent',
	'poll_pr',
	'apply_patch'
]);

function expands(name: string) {
	return isCommandToolKind(name) || EXPANDING_TOOLS.has(name);
}

const WorkTools = memo(function WorkTools({ store, rowId }: Props) {
	const [expanded, setExpanded] = useTranscriptExpanded(store, rowId);
	const preview = useTranscriptRunRow(store, rowId);

	const needsDetails =
		expanded && preview?.kind === 'tool' && expands(preview.name) && preview.hasMore;

	const row = useTranscriptRunRow(store, rowId, needsDetails);
	const fileLinks = use(MarkdownFileLinksContext);
	const [summaryElement, setSummaryElement] = useState<HTMLSpanElement | null>(null);
	const [truncated, setTruncated] = useState(false);
	const summary = row?.kind === 'tool' ? row.summary : '';

	useEffect(() => {
		if (needsDetails) return store.openItem(rowId);
	}, [needsDetails, store, rowId]);

	useLayoutEffect(() => {
		if (!summaryElement) return;
		const measure = () => setTruncated(summaryElement.scrollWidth > summaryElement.clientWidth);
		measure();

		if (!globalThis.ResizeObserver) return;
		const observer = new ResizeObserver(measure);
		observer.observe(summaryElement);

		return () => observer.disconnect();
	}, [summaryElement, summary]);

	if (row?.kind !== 'tool') return null;

	const expandable = expands(row.name);
	const showsDetail = expandable && expanded;

	const statusClass =
		row.status === 'failed'
			? 'text-destructive'
			: row.status === 'cancelled' || row.status === 'interrupted'
				? 'text-amber-800 dark:text-amber-200'
				: '';

	const fileTarget =
		row.action?.kind === 'openFile' && fileLinks
			? fileLinkTarget(row.action.path, fileLinks.roots)
			: null;

	const hasDetail = expanded || row.hasMore || truncated || summary.includes('\n');

	let commandEnd = 0;

	const detail = row.commands?.map((command, index) => {
		const start = summary.indexOf(command, commandEnd);

		if (start === -1) return null;

		const prefix = summary.slice(commandEnd, start);
		commandEnd = start + command.length;

		return (
			<span key={index}>
				{prefix}
				<HighlightedCommand command={command} />
			</span>
		);
	});

	let onClick: (() => void) | undefined;

	if (expandable) {
		if (hasDetail) onClick = () => setExpanded(!expanded);
	} else if (fileTarget && fileLinks) {
		onClick = () => fileLinks.open(fileTarget);
	}

	const title =
		!expandable && (truncated || row.hasMore) ? `${summary}${row.hasMore ? '…' : ''}` : undefined;

	const content = (
		<>
			{createElement(toolKindIcon(row.name), {
				className: 'mt-1 size-3.5 shrink-0',
				'aria-hidden': true
			})}
			{row.label ? (
				<span className="shrink-0">
					{row.label}
					{summary ? ':' : ''}
				</span>
			) : null}
			<span ref={setSummaryElement} className="min-w-0 truncate">
				{summary}
			</span>
			{statusClass ? (
				<span className={`shrink-0 ${statusClass}`}>
					({row.status === 'cancelled' ? 'stopped' : row.status})
				</span>
			) : null}
		</>
	);

	return (
		<div
			data-tool-kind={row.name}
			className="text-muted-foreground min-w-0 space-y-1.5 text-[13px] leading-6"
		>
			{onClick ? (
				<button
					type="button"
					data-tool-row
					data-work-detail
					title={title}
					className={`${workRowClass} max-w-full`}
					aria-expanded={expandable ? expanded : undefined}
					onClick={onClick}
				>
					{content}
				</button>
			) : (
				<div
					data-tool-row
					data-work-detail
					title={title}
					className="flex min-w-0 items-start gap-1.5"
				>
					{content}
				</div>
			)}
			{showsDetail ? (
				<p
					data-work-detail
					className="bg-muted/50 text-foreground ml-5 max-h-80 overflow-y-auto rounded-md px-2 py-1.5 font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap"
				>
					{detail}
					{summary.slice(commandEnd)}
				</p>
			) : null}
			{row.error !== undefined ? (
				<p
					data-work-detail
					className={`pl-5 text-xs leading-5 wrap-break-word whitespace-pre-wrap ${statusClass}`}
					role="status"
				>
					{row.error}
				</p>
			) : null}
			{row.action?.kind === 'saveCard' ? (
				<div data-work-detail className="pl-5">
					<SaveCardButton />
				</div>
			) : null}
		</div>
	);
});

export default WorkTools;
