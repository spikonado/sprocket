import { v } from 'convex/values';
import { internalMutation } from '@convex/_generated/server';
import { reconcileTerminalRun } from '@convex/lib/runTerminal';
import { isRunFinalStatus } from '@convex/lib/validators';

export const continueCleanup = internalMutation({
	args: {
		runId: v.id('runs'),
		completedAt: v.number(),
		jobCursor: v.number(),
		questionCursor: v.union(v.number(), v.null())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get('runs', args.runId);

		if (run && isRunFinalStatus(run.status)) {
			await reconcileTerminalRun(ctx, run, args);
		}

		return null;
	}
});
