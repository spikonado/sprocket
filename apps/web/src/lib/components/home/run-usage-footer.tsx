import { useConvexAuth, useQuery_experimental } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { ModelCatalog } from '@convex/lib/uiModelCatalog';
import {
	API_COST_NOTE,
	breakdownOf,
	cacheHitRate,
	costOf,
	formatCost,
	formatRate,
	formatTokens,
	newTokens
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
	const cost = costOf(usage.data, modelCatalog);
	const hitRate = cacheHitRate(breakdown);

	return (
		<p
			data-run-usage
			className="text-muted-foreground flex flex-wrap gap-x-2 text-[12px] tabular-nums"
		>
			<span>{formatTokens(newTokens(breakdown))} tokens</span>
			{hitRate === null ? null : (
				<>
					<span aria-hidden="true">·</span>
					<span>{formatRate(hitRate)} cached</span>
				</>
			)}
			{cost.usd === null ? null : (
				<>
					<span aria-hidden="true">·</span>
					<span title={cost.partial ? `${API_COST_NOTE} Excludes unpriced models.` : API_COST_NOTE}>
						{formatCost(cost)} API cost
					</span>
				</>
			)}
		</p>
	);
}
