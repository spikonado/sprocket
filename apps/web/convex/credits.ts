import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from '@convex/_generated/server';
import { resolveCustomerOwner } from '@convex/billingCustomers';
import { grantForPayment } from '@convex/lib/credits';
import { vPackPrice } from '@convex/lib/pricingValidators';

const DAY = 24 * 60 * 60 * 1_000;

function getPackRow(ctx: QueryCtx, productId: string) {
	return ctx.db
		.query('creditPacks')
		.withIndex('by_productId', (q) => q.eq('productId', productId))
		.unique();
}

export const isPack = internalQuery({
	args: { productId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, { productId }) => (await getPackRow(ctx, productId)) !== null
});

/**
 * Grants a paid pack once per payment and revokes its unused units on any refund or dispute.
 * Grants only move forward, so delivery order doesn't matter.
 */
export const syncPayment = internalMutation({
	args: {
		paymentId: v.string(),
		succeeded: v.boolean(),
		revoked: v.boolean(),
		paidAt: v.number(),
		dodoCustomerId: v.string(),
		metadataUserId: v.optional(v.string()),
		productId: v.string(),
		quantity: v.number()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await grantForPayment(ctx, args.paymentId);

		if (existing) {
			if (args.revoked && existing.revokedAt === undefined) {
				await ctx.db.patch('creditGrants', existing._id, { revokedAt: Date.now() });
			}

			return null;
		}

		const pack = args.succeeded ? await getPackRow(ctx, args.productId) : null;

		if (!pack) return null;

		const userId = await resolveCustomerOwner(ctx, args.dodoCustomerId, args.metadataUserId);

		if (!userId) {
			console.error(
				`Dodo payment ${args.paymentId} belongs to unknown customer ${args.dodoCustomerId}.`
			);

			return null;
		}

		await ctx.db.insert('creditGrants', {
			userId,
			paymentId: args.paymentId,
			productId: pack.productId,
			units: pack.units * args.quantity,
			used: 0,
			expiresAt: args.paidAt + pack.expiresAfterDays * DAY,
			revokedAt: args.revoked ? Date.now() : undefined
		});

		return null;
	}
});

export const listPackProducts = internalQuery({
	args: {},
	returns: v.array(v.string()),
	handler: async (ctx) =>
		(await ctx.db.query('creditPacks').collect()).map((pack) => pack.productId)
});

export const setPackPrice = internalMutation({
	args: { productId: v.string(), price: v.union(vPackPrice, v.null()) },
	returns: v.null(),
	handler: async (ctx, { productId, price }) => {
		const pack = await getPackRow(ctx, productId);

		if (pack) await ctx.db.patch('creditPacks', pack._id, { price: price ?? undefined });

		return null;
	}
});
