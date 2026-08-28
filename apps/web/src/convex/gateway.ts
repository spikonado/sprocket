import { v, ConvexError, type Infer } from 'convex/values';
import { mutation } from '@convex/_generated/server';
import { modelGatewayTokenSecret } from '@convex/lib/gatewayFetch';
import { verifyGatewayToken } from '@convex/lib/gatewayToken';
import { applyGatewayUsageCharge, gatewayQuotaStatus } from '@convex/lib/rateLimits';

const vQuota = v.object({
	userId: v.string(),
	tier: v.union(v.literal('free'), v.literal('pro'), v.literal('admin')),
	exhausted: v.boolean(),
	message: v.optional(v.string())
});

async function userFromGatewayToken(token: string) {
	try {
		return await verifyGatewayToken(modelGatewayTokenSecret(), token);
	} catch (error) {
		throw new ConvexError(error instanceof Error ? error.message : 'Invalid gateway token.');
	}
}

export const checkQuota = mutation({
	args: { token: v.string() },
	returns: vQuota,
	handler: async (ctx, args) => {
		const payload = await userFromGatewayToken(args.token);
		const status = await gatewayQuotaStatus(ctx, payload.userId);
		const result: Infer<typeof vQuota> = {
			userId: payload.userId,
			tier: status.tier,
			exhausted: status.exhausted
		};
		if (status.message) {
			result.message = status.message;
		}
		return result;
	}
});

export const consumeQuota = mutation({
	args: {
		token: v.string(),
		units: v.number()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const payload = await userFromGatewayToken(args.token);
		await applyGatewayUsageCharge(ctx, payload.userId, Math.max(0, Math.ceil(args.units)));
		return null;
	}
});
