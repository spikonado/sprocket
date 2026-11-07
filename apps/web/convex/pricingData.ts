import { v } from 'convex/values';
import { internalMutation, internalQuery } from '@convex/_generated/server';
import { vDodoPublicPrice, type DodoPublicPrice } from '@convex/lib/dodoProducts';
import { vTierPricingConfig } from '@convex/lib/pricingValidators';
import { getTierRow, MODEL_USAGE_UNITS_PER_DOLLAR, tierForProduct } from '@convex/lib/tiers';

// Durable global bound on concurrent refreshes per provider environment,
// enforced inside the lease transaction so it holds across action instances.
const DODO_MAX_ACTIVE_REFRESH_LEASES = 8;

export const getProductPricesForEnvironment = internalQuery({
	args: {
		environment: v.string(),
		productIds: v.array(v.string()),
		now: v.number()
	},
	returns: v.array(
		v.object({
			productId: v.string(),
			price: v.union(vDodoPublicPrice, v.null()),
			expiresAt: v.number(),
			refreshFailed: v.boolean(),
			retryAt: v.union(v.number(), v.null()),
			validatedAt: v.union(v.number(), v.null()),
			leaseActive: v.boolean()
		})
	),
	handler: async (ctx, { environment, productIds, now }) => {
		const rows: Array<{
			productId: string;
			price: DodoPublicPrice | null;
			expiresAt: number;
			refreshFailed: boolean;
			retryAt: number | null;
			validatedAt: number | null;
			leaseActive: boolean;
		}> = [];

		for (const productId of new Set(productIds)) {
			const cached = await ctx.db
				.query('dodoPricingCache')
				.withIndex('by_environment_and_productId', (query) =>
					query.eq('environment', environment).eq('productId', productId)
				)
				.unique();

			if (cached) {
				rows.push({
					productId,
					price: cached.price ?? null,
					expiresAt: cached.expiresAt,
					refreshFailed: cached.refreshFailed ?? false,
					retryAt: cached.retryAt ?? null,
					validatedAt: cached.validatedAt ?? null,
					leaseActive: cached.leaseExpiresAt !== undefined && cached.leaseExpiresAt > now
				});
			}
		}

		return rows;
	}
});

export const acquireProductRefreshLease = internalMutation({
	args: {
		environment: v.string(),
		productId: v.string(),
		leaseOwner: v.string(),
		leaseExpiresAt: v.number(),
		now: v.number()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const cached = await ctx.db
			.query('dodoPricingCache')
			.withIndex('by_environment_and_productId', (query) =>
				query.eq('environment', args.environment).eq('productId', args.productId)
			)
			.unique();

		if (cached) {
			const leased = cached.leaseExpiresAt !== undefined && cached.leaseExpiresAt > args.now;

			if (leased && cached.leaseOwner !== args.leaseOwner) return false;

			if (!cached.refreshFailed && cached.expiresAt > args.now) return false;

			// Negative-cache backoff: definitive failures hold until expiresAt;
			// transient failures hold until retryAt. Rechecked here inside the
			// claim transaction so an earlier read snapshot cannot slip a fetch
			// past a freshly written failure row.
			if (cached.refreshFailed === true) {
				const holdUntil =
					cached.retryAt !== undefined && cached.retryAt !== null
						? cached.retryAt
						: cached.expiresAt;

				if (holdUntil > args.now) return false;
			}
		}

		const activeLeases = await ctx.db
			.query('dodoPricingCache')
			.withIndex('by_environment_and_leaseExpiresAt', (q) =>
				q.eq('environment', args.environment).gt('leaseExpiresAt', args.now)
			)
			.take(DODO_MAX_ACTIVE_REFRESH_LEASES);

		if (activeLeases.length >= DODO_MAX_ACTIVE_REFRESH_LEASES) return false;

		if (cached) {
			await ctx.db.patch('dodoPricingCache', cached._id, {
				leaseOwner: args.leaseOwner,
				leaseExpiresAt: args.leaseExpiresAt
			});

			return true;
		}

		await ctx.db.insert('dodoPricingCache', {
			environment: args.environment,
			productId: args.productId,
			expiresAt: 0,
			leaseOwner: args.leaseOwner,
			leaseExpiresAt: args.leaseExpiresAt
		});

		return true;
	}
});

export const cacheProductPrice = internalMutation({
	args: {
		environment: v.string(),
		productId: v.string(),
		price: v.union(vDodoPublicPrice, v.null()),
		refreshFailed: v.boolean(),
		retryAt: v.optional(v.union(v.number(), v.null())),
		expiresAt: v.number(),
		leaseOwner: v.string(),
		now: v.number()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const cached = await ctx.db
			.query('dodoPricingCache')
			.withIndex('by_environment_and_productId', (query) =>
				query.eq('environment', args.environment).eq('productId', args.productId)
			)
			.unique();

		if (!cached || cached.leaseOwner !== args.leaseOwner) return null;

		// A transient failure keeps the last confirmed price for bounded stale
		// display; the stale deadline (validatedAt) is untouched so retries can
		// never extend it. Definitive failures and successful refreshes replace
		// the price.
		const preserveStale = args.refreshFailed && args.retryAt !== null && cached.price;

		await ctx.db.patch('dodoPricingCache', cached._id, {
			price: preserveStale ? cached.price : (args.price ?? undefined),
			refreshFailed: args.refreshFailed,
			retryAt: args.retryAt === null ? undefined : args.retryAt,
			expiresAt: args.expiresAt,
			validatedAt:
				!args.refreshFailed && args.price
					? args.now
					: preserveStale
						? cached.validatedAt
						: undefined,
			leaseOwner: undefined,
			leaseExpiresAt: undefined
		});

		return null;
	}
});

export const getPublicPlans = internalQuery({
	args: {},
	returns: v.array(vTierPricingConfig),
	handler: async (ctx) => {
		const tiers = await ctx.db.query('tiers').collect();
		const seen = new Set<string>();

		const plans = tiers.map((tier) => {
			if (seen.has(tier.tierId)) throw new Error(`Duplicate tiers rows for tier "${tier.tierId}".`);
			seen.add(tier.tierId);

			return {
				id: tier.tierId,
				label: tier.label,
				monthlyUsageDollars: tier.monthly / MODEL_USAGE_UNITS_PER_DOLLAR,
				description: tier.description ?? null,
				features: tier.features ?? [],
				displayOrder: tier.displayOrder ?? (tier.tierId === 'free' ? 0 : 100),
				highlighted: tier.highlighted ?? false,
				monthlyProductId: tier.monthlyProductId ?? null,
				annualProductId: tier.annualProductId ?? null
			};
		});

		return plans.sort(
			(left, right) =>
				left.displayOrder - right.displayOrder ||
				left.label.localeCompare(right.label) ||
				left.id.localeCompare(right.id)
		);
	}
});

export const getTierProduct = internalQuery({
	args: {
		tierId: v.string(),
		interval: v.union(v.literal('monthly'), v.literal('annual'))
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, { tierId, interval }) => {
		const tier = await getTierRow(ctx, tierId);

		if (!tier) return null;
		const productId = interval === 'monthly' ? tier.monthlyProductId : tier.annualProductId;

		if (!productId) return null;

		// Throws when another tier also sells this product.
		await tierForProduct(ctx, productId);

		return productId;
	}
});
