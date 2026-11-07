import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from '@convex/_generated/server';
import { resolveCustomerOwner } from '@convex/billingCustomers';
import { creditExpiresAt, grantForPayment } from '@convex/lib/credits';
import { vCreditPackExpiry, vCreditPackTerms, vPackPrice } from '@convex/lib/pricingValidators';

function getPackRow(ctx: QueryCtx, productId: string) {
	return ctx.db
		.query('creditPacks')
		.withIndex('by_productId', (q) => q.eq('productId', productId))
		.unique();
}

/** A pack is sellable once the price sync confirmed its product is a paid one-time product. */
export const getSellablePack = internalQuery({
	args: { productId: v.string() },
	returns: v.union(vCreditPackTerms, v.null()),
	handler: async (ctx, { productId }) => {
		const pack = await getPackRow(ctx, productId);

		if (pack?.price?.productId !== productId) return null;

		return { units: pack.units, expiresAfter: pack.expiresAfter };
	}
});

/**
 * Grants a paid pack once per payment, on the terms recorded at checkout, and revokes its
 * unused units on any refund or dispute. Grants only move forward, so delivery order doesn't matter.
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
		units: v.number(),
		expiresAfter: vCreditPackExpiry
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

		if (!args.succeeded) return null;

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
			productId: args.productId,
			units: args.units,
			used: 0,
			expiresAt: creditExpiresAt(args.paidAt, args.expiresAfter),
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
