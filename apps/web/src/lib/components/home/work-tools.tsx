import { createElement, memo, use, useEffect, useLayoutEffect, useState } from 'react';
import { fileLinkTarget, MarkdownFileLinksContext } from '$lib/chat/markdown-file-links';
import { toolKindIcon } from '$lib/chat/tool-icons';
import { useTranscriptExpanded, type TranscriptStore } from '$lib/home/transcript-store';
import { useTranscriptRunRow } from '$lib/home/transcript-run';
import SaveCardButton from './save-card-button';

type Props = { store: TranscriptStore; rowId: string };

const rowClass =
	'hover:text-foreground focus-visible:ring-ring/60 flex min-w-0 cursor-pointer items-start gap-1.5 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none';

const WorkTools = memo(function WorkTools({ store, rowId }: Props) {
	const [expanded, setExpanded] = useTranscriptExpanded(store, rowId);
	const preview = useTranscriptRunRow(store, rowId);
	const needsDetails = expanded && preview?.kind === 'tool' && preview.hasMore;
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

	const expandable = expanded || row.hasMore || truncated || summary.includes('\n');

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
			{expandable ? (
				<button
					type="button"
					data-tool-row
					data-work-detail
					className={`${rowClass} max-w-full`}
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
				>
					{content}
				</button>
			) : (
				<div data-tool-row data-work-detail className="flex min-w-0 items-start gap-1.5">
					{content}
				</div>
			)}
			{expanded ? (
				<p
					data-work-detail
					className="bg-muted/50 text-foreground ml-5 max-h-80 overflow-y-auto rounded-md px-2 py-1.5 font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap"
				>
					{summary}
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
			) : fileTarget && fileLinks ? (
				<button
					type="button"
					data-work-detail
					className={`${rowClass} ml-5 text-xs`}
					onClick={() => fileLinks.open(fileTarget)}
				>
					Open file
				</button>
			) : null}
		</div>
	);
});

export default WorkTools;
