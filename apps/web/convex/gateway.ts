import { v, ConvexError, type Infer } from 'convex/values';
import { mutation } from '@convex/_generated/server';
import { modelGatewayTokenSecret } from '@convex/lib/gatewayFetch';
import { verifyGatewayToken } from '@convex/lib/gatewayToken';
import { applyGatewayUsageCharge, gatewayQuotaStatus } from '@convex/lib/rateLimits';
import { vSubscriptionTier } from '@convex/lib/validators';

const vQuota = v.object({
	userId: v.string(),
	tier: vSubscriptionTier,
	exhausted: v.boolean(),
	message: v.optional(v.string())
});

// A single model call charges a small multiple of UNITS_PER_DOLLAR; anything
// above this is a caller bug or a replayed token, not real usage.
const MAX_QUOTA_CHARGE_UNITS = 1_000_000_000_000;

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
		if (!Number.isFinite(args.units) || args.units < 0) {
			throw new ConvexError('Invalid quota units.');
		}
		if (args.units > MAX_QUOTA_CHARGE_UNITS) {
			throw new ConvexError('Quota charge exceeds the per-call limit.');
		}
		await applyGatewayUsageCharge(ctx, payload.userId, Math.ceil(args.units));
		return null;
	}
});
