import { query } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { remainingCredits, spendableGrants } from '@convex/lib/credits';
import { vMyUsage } from '@convex/lib/docs';
import { readUsage } from '@convex/lib/quota';
import { resolvePlan } from '@convex/lib/tiers';
import { usageMeters } from '@convex/lib/usageMeters';

export const getMyUsage = query({
	args: { now: v.number() },
	returns: vMyUsage,
	handler: async (ctx, args): Promise<Infer<typeof vMyUsage>> => {
		const now = args.now;

		if (!Number.isFinite(now)) throw new Error('Usage display time must be finite.');
		const userId = await getUserId(ctx);
		const plan = await resolvePlan(ctx, userId, now);
		const { tier, label: tierLabel, limits } = plan;
		const { used, window } = await readUsage(ctx, userId, plan, now);
		const grants = await spendableGrants(ctx, userId, now);
		const [next] = grants;

		const credits = next
			? {
					remaining: remainingCredits(grants),
					nextExpiresAt: next.expiresAt,
					nextExpiringAmount: next.units - next.used
				}
			: undefined;

		const resetsAt = window.end;
		const exhausted = used >= limits.modelUsage && !credits;

		return {
			tier,
			tierLabel,
			exhausted,
			resetsAt: exhausted ? resetsAt : null,
			meters: usageMeters.map((meter) => ({
				id: meter.id,
				label: meter.label,
				used,
				limit: limits[meter.id],
				resetsAt
			})),
			credits
		};
	}
});
