import {
	coercePersistedModelId,
	getModelDefinition,
	type SupportedReasoningEffort
} from '@convex/lib/models';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';

type SweepTotals = { scanned: number; rewritten: number };

/**
 * Section-5 compat sweep (BACKWARDS_COMPATIBILITY.md): stored rows can carry a
 * reasoning effort their model no longer supports. Idempotent; exits without
 * writes once every row is valid. Delete alongside the rest of the shim once
 * the removal gate passes.
 */
export const rewriteDroppedMaxReasoning = internalMutation({
	args: {},
	returns: v.object({ scanned: v.number(), rewritten: v.number() }),
	handler: async (ctx) => {
		const totals: SweepTotals = { scanned: 0, rewritten: 0 };
		await sweepThreadRecords(ctx, totals);
		await sweepRuns(ctx, totals);
		return totals;
	}
});

async function sweepThreadRecords(ctx: MutationCtx, totals: SweepTotals) {
	for (const row of await ctx.db.query('threadRecords').collect()) {
		const effort = clampEffort(row.selectedModel, row.reasoningEffort);
		totals.scanned += 1;
		if (effort !== undefined && effort !== row.reasoningEffort) {
			await ctx.db.patch(row._id, { reasoningEffort: effort });
			totals.rewritten += 1;
		}
	}
}

async function sweepRuns(ctx: MutationCtx, totals: SweepTotals) {
	for (const row of await ctx.db.query('runs').collect()) {
		const effort = clampEffort(row.selectedModel, row.reasoningEffort);
		totals.scanned += 1;
		if (effort !== undefined && effort !== row.reasoningEffort) {
			await ctx.db.patch(row._id, { reasoningEffort: effort });
			totals.rewritten += 1;
		}
	}
}

function clampEffort(
	selectedModel: string,
	reasoningEffort: SupportedReasoningEffort
): SupportedReasoningEffort | undefined {
	const model = getModelDefinition(coercePersistedModelId(selectedModel));
	return model.reasoningEfforts.some((effort) => effort === reasoningEffort)
		? reasoningEffort
		: model.defaultReasoningEffort;
}
