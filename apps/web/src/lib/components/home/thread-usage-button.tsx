import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ChartColumn } from 'lucide-react';
import { useConvexAuth, useQuery_experimental } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { ModelCatalog } from '@convex/lib/uiModelCatalog';
import {
	API_COST_NOTE,
	breakdownOf,
	cacheHitRate,
	costOf,
	formatCalls,
	formatCost,
	formatRate,
	formatTokens,
	newTokens,
	usageByModel,
	type CostSummary
} from '$lib/chat/ai-usage';
import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss';
import {
	TokenTypeBreakdown,
	UsageLabel,
	UsageSegmented,
	UsageShareList,
	UsageStat,
	type ShareItem
} from '$lib/components/home/ai-usage-parts';

type Scope = 'thread' | 'subagents';

export default function ThreadUsageButton({
	threadId,
	modelCatalog
}: {
	threadId: Id<'threadRecords'>;
	modelCatalog: ModelCatalog | undefined;
}) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		if (!open) return;

		function updatePosition() {
			const trigger = triggerRef.current?.getBoundingClientRect();
			const panel = panelRef.current?.getBoundingClientRect();

			if (!trigger || !panel) return;
			setPosition({
				left: Math.max(
					8,
					Math.min(trigger.right - panel.width, window.innerWidth - panel.width - 8)
				),
				bottom: window.innerHeight - trigger.top + 12,
				maxHeight: Math.max(0, trigger.top - 20)
			});
		}

		updatePosition();
		window.addEventListener('resize', updatePosition);
		window.addEventListener('scroll', updatePosition, true);

		return () => {
			window.removeEventListener('resize', updatePosition);
			window.removeEventListener('scroll', updatePosition, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;

		return listenOpenMenuDismiss({
			getRoot: () => [triggerRef.current, panelRef.current],
			onOutside: () => setOpen(false),
			onEscape: () => {
				setOpen(false);
				triggerRef.current?.focus();
			}
		});
	}, [open]);

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className="text-muted-foreground hover:text-foreground flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg transition sm:size-9"
				aria-label="AI usage"
				title="AI usage"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => {
					setPosition({ visibility: 'hidden' });
					setOpen((wasOpen) => !wasOpen);
				}}
			>
				<ChartColumn className="size-4" aria-hidden="true" />
			</button>
			{open ? (
				<div
					ref={panelRef}
					role="dialog"
					aria-label="AI usage"
					className="bg-popover/96 fixed z-50 w-[min(23rem,calc(100vw-1rem))] overflow-y-auto rounded-[18px] border border-[var(--hairline)] p-4 shadow-[var(--composer-shadow)] backdrop-blur-xl"
					style={position}
				>
					<ThreadUsagePanel threadId={threadId} modelCatalog={modelCatalog} />
				</div>
			) : null}
		</>
	);
}

function ThreadUsagePanel({
	threadId,
	modelCatalog
}: {
	threadId: Id<'threadRecords'>;
	modelCatalog: ModelCatalog | undefined;
}) {
	const [scope, setScope] = useState<Scope>('subagents');
	const convexAuth = useConvexAuth();

	const usage = useQuery_experimental({
		query: api.aiUsage.getThreadUsage,
		args: convexAuth.isAuthenticated && !convexAuth.isLoading ? { threadId } : 'skip'
	});

	if (usage.status === 'error') {
		return <p className="text-muted-foreground text-sm">Couldn’t load usage right now.</p>;
	}

	if (usage.status !== 'success') {
		return <p className="text-muted-foreground text-sm">Loading AI usage…</p>;
	}

	const { subagents } = usage.data;
	const includeSubagents = scope === 'subagents' && subagents.length > 0;

	const rows = includeSubagents
		? [...usage.data.totals, ...subagents.flatMap((subagent) => subagent.totals)]
		: usage.data.totals;

	const breakdown = breakdownOf(rows);
	const cost = costOf(rows, modelCatalog);
	const tokens = newTokens(breakdown);

	const modelItems = shareItems(
		tokens,
		usageByModel(rows, modelCatalog).map((model) => ({
			key: model.key,
			label: model.label,
			detail: model.providerLabel,
			tokens: newTokens(model.breakdown),
			cost: model.cost
		}))
	);

	const subagentItems = shareItems(
		tokens,
		subagents.map((subagent) => ({
			key: subagent.threadId,
			label: subagent.title ?? 'Untitled subagent',
			tokens: newTokens(breakdownOf(subagent.totals)),
			cost: costOf(subagent.totals, modelCatalog)
		}))
	);

	return (
		<div className="space-y-4">
			<p className="text-foreground text-[14px] font-medium">AI usage</p>

			{subagents.length > 0 ? (
				<UsageSegmented
					label="Usage scope"
					value={scope}
					onChange={setScope}
					options={[
						{ id: 'thread', label: 'This thread' },
						{ id: 'subagents', label: `With subagents (${subagents.length})` }
					]}
				/>
			) : null}

			<div className="grid grid-cols-3 gap-3">
				<UsageStat
					label="API cost"
					value={formatCost(cost)}
					detail={cost.partial ? 'Excludes unpriced models' : undefined}
				/>
				<UsageStat
					label="Tokens"
					value={formatTokens(tokens)}
					detail={formatCalls(breakdown.calls)}
				/>
				<UsageStat
					label="Cache hits"
					value={formatRate(cacheHitRate(breakdown))}
					detail="of input"
				/>
			</div>

			<TokenTypeBreakdown amounts={breakdown} />

			{modelItems.length > 1 ? (
				<div className="border-t border-[var(--hairline)] pt-3">
					<UsageLabel>By model</UsageLabel>
					<UsageShareList items={modelItems} />
				</div>
			) : null}

			{includeSubagents ? (
				<div className="border-t border-[var(--hairline)] pt-3">
					<UsageLabel>Subagents</UsageLabel>
					<UsageShareList items={subagentItems} />
				</div>
			) : null}

			<p className="text-muted-foreground text-[11.5px]">API cost: {API_COST_NOTE}</p>
		</div>
	);
}

/** Largest first, each sized by its share of `total` tokens. */
function shareItems(
	total: number,
	entries: { key: string; label: string; detail?: string; tokens: number; cost: CostSummary }[]
): ShareItem[] {
	return [...entries]
		.sort((a, b) => b.tokens - a.tokens)
		.map((entry) => ({
			key: entry.key,
			label: entry.label,
			detail: entry.detail,
			value: `${formatTokens(entry.tokens)} · ${formatCost(entry.cost)}`,
			share: total > 0 ? entry.tokens / total : 0
		}));
}
