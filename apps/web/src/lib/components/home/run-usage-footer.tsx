import { useConvexAuth, useQuery_experimental } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { ModelCatalog } from '@convex/lib/uiModelCatalog';
import {
	API_COST_NOTE,
	billableTokens,
	breakdownOf,
	cacheHitRate,
	costOf,
	formatCost,
	formatRate,
	formatTokens
} from '$lib/chat/ai-usage';

export default function RunUsageFooter({
	runId,
	modelCatalog
}: {
	runId: Id<'runs'>;
	modelCatalog: ModelCatalog | undefined;
}) {
	const convexAuth = useConvexAuth();

	const usage = useQuery_experimental({
		query: api.aiUsage.getRunUsage,
		args: convexAuth.isAuthenticated && !convexAuth.isLoading ? { runId } : 'skip'
	});

	if (usage.status !== 'success' || usage.data.length === 0) return null;

	const breakdown = breakdownOf(usage.data);

	return (
		<p
			data-run-usage
			className="text-muted-foreground flex flex-wrap gap-x-2 text-[12px] tabular-nums"
		>
			<span>{formatTokens(billableTokens(breakdown))} tokens</span>
			<span aria-hidden="true">·</span>
			<span>{formatRate(cacheHitRate(breakdown))} cached</span>
			<span aria-hidden="true">·</span>
			<span title={API_COST_NOTE}>{formatCost(costOf(usage.data, modelCatalog))} API cost</span>
		</p>
	);
}
