import { flushSync } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
	TranscriptDisplayDetails,
	TranscriptDisplayRow,
	TranscriptDetailCursor
} from '$lib/types/sprocket';
import {
	buildAssistantTimeline,
	buildCommandSessionCommandMap,
	buildOpenExecCommandSessions,
	partitionWorkSectionTools,
	groupAssistantTimeline
} from '$lib/chat/assistant-timeline';
import { WorkDetails } from '$lib/project/work-details';
import { TranscriptSectionKeys } from '$lib/chat/transcript-section-keys';
import ReasoningDisclosure from '$lib/components/home/reasoning-disclosure';
import WorkTools from '$lib/components/home/work-tools';

type Props = {
	row: TranscriptDisplayRow;
	load: (
		row: TranscriptDisplayRow,
		cursor: TranscriptDetailCursor,
		signal: AbortSignal
	) => Promise<TranscriptDisplayDetails>;
	inProgress: boolean;
	viewport: HTMLDivElement | null;
	beforeChange: (follow: boolean) => () => void;
};

const PREFETCH_VIEWPORTS = 3;
const MAX_STALLED_PREFETCH_PAGES = 2;

export default function WorkSectionDetails({
	row,
	load,
	inProgress,
	viewport,
	beforeChange
}: Props) {
	const [version, setVersion] = useState(0);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const topRef = useRef<HTMLDivElement | null>(null);
	const bottomRef = useRef<HTMLDivElement | null>(null);
	const lastTopRef = useRef(0);
	const directionRef = useRef<'older' | 'newer'>('newer');
	const stalledPagesRef = useRef({ older: 0, newer: 0 });

	const loadRef = useRef(load);
	const rowRef = useRef(row);
	const inProgressRef = useRef(inProgress);
	const beforeChangeRef = useRef(beforeChange);
	const viewportRef = useRef(viewport);
	useLayoutEffect(() => {
		loadRef.current = load;
		rowRef.current = row;
		inProgressRef.current = inProgress;
		beforeChangeRef.current = beforeChange;
		viewportRef.current = viewport;
	});

	function distanceFromViewport(edge: HTMLDivElement | null) {
		const root = viewportRef.current;
		if (!root || !edge) return Number.POSITIVE_INFINITY;
		const bounds = root.getBoundingClientRect();
		const target = edge.getBoundingClientRect();
		if (target.bottom < bounds.top) return bounds.top - target.bottom;
		if (target.top > bounds.bottom) return target.top - bounds.bottom;
		return 0;
	}

	const historyRef = useRef<WorkDetails | null>(null);
	if (!historyRef.current) {
		historyRef.current = new WorkDetails(
			(cursor, signal) => loadRef.current(rowRef.current, cursor, signal),
			() => setVersion((value) => value + 1),
			async (update, edge) => {
				const stalledPages = stalledPagesRef.current;
				const previousDistance = edge
					? distanceFromViewport(edge === 'older' ? topRef.current : bottomRef.current)
					: undefined;
				const restore = beforeChangeRef.current(inProgressRef.current && edge !== 'older');
				flushSync(update);
				restore();
				lastTopRef.current = viewportRef.current?.scrollTop ?? 0;
				if (edge && previousDistance !== undefined) {
					const nextDistance = distanceFromViewport(
						edge === 'older' ? topRef.current : bottomRef.current
					);
					stalledPages[edge] = nextDistance <= previousDistance + 1 ? stalledPages[edge] + 1 : 0;
				}
			}
		);
	}
	const history = historyRef.current;

	const details = {
		parts: history.parts,
		loading: history.loading,
		indexing: history.indexing,
		error: history.error,
		stale: history.stale,
		previousBefore: history.previousBefore,
		nextAfter: history.nextAfter
	};
	const timeline = buildAssistantTimeline(details.parts, []);
	const tools = timeline.filter((item) => item.type === 'tool');
	const grouped = groupAssistantTimeline(timeline).filter((block) => block.type !== 'text');
	const partitioned = partitionWorkSectionTools(
		grouped,
		inProgress,
		buildOpenExecCommandSessions(tools, inProgress)
	);
	const commands = buildCommandSessionCommandMap(tools);
	const blockKeysRef = useRef<TranscriptSectionKeys | null>(null);
	if (!blockKeysRef.current) blockKeysRef.current = new TranscriptSectionKeys();
	const settled = blockKeysRef.current.reconcileBlocks(row.id, partitioned.settledBlocks);

	function prefetchNearbyDetails() {
		const stalledPages = stalledPagesRef.current;
		if (
			!viewport ||
			viewport.clientHeight <= 0 ||
			history.loading ||
			history.error ||
			history.indexing
		)
			return;
		const direction = directionRef.current;
		const directions: Array<'older' | 'newer'> =
			direction === 'older' ? ['older', 'newer'] : ['newer', 'older'];
		for (const next of directions) {
			const cursor = next === 'older' ? history.previousBefore : history.nextAfter;
			if (cursor === undefined || stalledPages[next] >= MAX_STALLED_PREFETCH_PAGES) continue;
			const edge = next === 'older' ? topRef.current : bottomRef.current;
			if (distanceFromViewport(edge) > viewport.clientHeight * PREFETCH_VIEWPORTS) continue;
			void history.more(next);
			return;
		}
	}

	const prefetchRef = useRef(prefetchNearbyDetails);
	useLayoutEffect(() => {
		prefetchRef.current = prefetchNearbyDetails;
	});

	useLayoutEffect(() => {
		if (inProgress) stalledPagesRef.current.newer = 0;
		void history.refresh();
	}, [history, inProgress, row.revision]);

	useEffect(() => {
		return () => history.stop();
	}, [history]);

	useLayoutEffect(() => {
		prefetchRef.current();
	}, [version]);

	useLayoutEffect(() => {
		const root = viewport;
		const top = topRef.current;
		const bottom = bottomRef.current;
		if (!root || !top || !bottom) return;
		const stalledPages = stalledPagesRef.current;
		lastTopRef.current = root.scrollTop;
		function scroll() {
			if (!root || root.scrollTop === lastTopRef.current) return;
			const next = root.scrollTop < lastTopRef.current ? 'older' : 'newer';
			lastTopRef.current = root.scrollTop;
			directionRef.current = next;
			stalledPages[next] = 0;
			prefetchRef.current();
		}
		const observer = globalThis.IntersectionObserver
			? new IntersectionObserver(() => prefetchRef.current(), {
					root,
					rootMargin: `${root.clientHeight * PREFETCH_VIEWPORTS}px 0px`
				})
			: undefined;
		const resizeObserver = globalThis.ResizeObserver
			? new ResizeObserver(() => {
					stalledPages.older = 0;
					stalledPages.newer = 0;
					prefetchRef.current();
				})
			: undefined;
		observer?.observe(top);
		observer?.observe(bottom);
		if (containerRef.current) resizeObserver?.observe(containerRef.current);
		resizeObserver?.observe(root);
		root.addEventListener('scroll', scroll);
		return () => {
			observer?.disconnect();
			resizeObserver?.disconnect();
			root.removeEventListener('scroll', scroll);
		};
	}, [viewport]);

	return (
		<div ref={containerRef} aria-busy={details.loading || details.indexing}>
			<div ref={topRef} data-work-edge="older" className="h-px" aria-hidden="true"></div>
			{details.stale ? <p role="status">Showing saved details while reconnecting.</p> : null}
			<div className="space-y-2">
				{settled.map(({ block, renderKey }) => (
					<div key={renderKey} data-work-detail>
						{block.type === 'reasoning' ? (
							<ReasoningDisclosure text={block.text} inProgress={false} />
						) : (
							<WorkTools
								tools={block.tools}
								toolKey={block.toolKey}
								preserveExpansion
								inProgress={inProgress}
								commands={commands}
							/>
						)}
					</div>
				))}
				{partitioned.runningTools.length > 0 ? (
					<div data-work-detail>
						<WorkTools
							tools={partitioned.runningTools}
							running
							inProgress={inProgress}
							commands={commands}
						/>
					</div>
				) : null}
			</div>
			{details.error ? (
				<p role="status">
					Could not load these details.{' '}
					<button
						className="underline"
						onClick={() => {
							stalledPagesRef.current.older = 0;
							stalledPagesRef.current.newer = 0;
							void history.retryFailed();
						}}
					>
						Retry
					</button>
				</p>
			) : (details.loading || details.indexing) && details.parts.length === 0 ? (
				<p role="status">Loading details...</p>
			) : null}
			<div ref={bottomRef} data-work-edge="newer" className="h-px" aria-hidden="true"></div>
		</div>
	);
}
