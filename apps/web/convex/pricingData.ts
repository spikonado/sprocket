import { v } from 'convex/values';
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import { internalMutation, internalQuery } from '@convex/_generated/server';
import type { DataModel } from '@convex/_generated/dataModel';
import { vDodoPublicPrice, type DodoPublicPrice } from '@convex/lib/dodoProducts';
import { vTierPrice, vTierPricingConfig } from '@convex/lib/pricingValidators';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';

// Durable global bound on concurrent refreshes per provider environment,
// enforced inside the lease transaction so it holds across action instances.
const DODO_MAX_ACTIVE_REFRESH_LEASES = 8;

/**
 * Dodo products must be assigned to exactly one tier interval. Returns the
 * owning tier id, or null when unassigned; multiple assignments fail fast.
 */
export async function lookupTierForProduct(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	productId: string,
	interval?: 'monthly' | 'annual'
): Promise<string | null> {
	const [monthly, annual] = await Promise.all([
		ctx.db
			.query('tiers')
			.withIndex('by_monthlyProductId', (query) => query.eq('monthlyProductId', productId))
			.take(2),
		ctx.db
			.query('tiers')
			.withIndex('by_annualProductId', (query) => query.eq('annualProductId', productId))
			.take(2)
	]);

	const assignments = [...monthly, ...annual];

	if (assignments.length > 1) {
		throw new Error(`Dodo product "${productId}" is assigned more than once.`);
	}

	if (interval === 'monthly' && monthly.length === 0) return null;

	if (interval === 'annual' && annual.length === 0) return null;

	return assignments[0]?.tierId ?? null;
}

export const getCachedTierPrices = internalQuery({
	args: { cacheKey: v.string(), now: v.number() },
	returns: v.union(v.array(vTierPrice), v.null()),
	handler: async (ctx, { cacheKey, now }) => {
		const cached = await ctx.db
			.query('dodoPricingCache')
			.withIndex('by_cacheKey', (query) => query.eq('cacheKey', cacheKey))
			.unique();

		return cached && cached.expiresAt > now ? cached.tierPrices : null;
	}
});

export const cacheTierPrices = internalMutation({
	args: { cacheKey: v.string(), tierPrices: v.array(vTierPrice), expiresAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const cached = await ctx.db
			.query('dodoPricingCache')
			.withIndex('by_cacheKey', (query) => query.eq('cacheKey', args.cacheKey))
			.unique();

		if (cached) await ctx.db.replace('dodoPricingCache', cached._id, args);
		else await ctx.db.insert('dodoPricingCache', args);

		return null;
	}
});

export const getProductPricesForEnvironment = internalQuery({
	args: {
		environment: v.string(),
		// Legacy aggregate cache key; rows under it predate per-product entries.
		cacheKey: v.string(),
		productIds: v.array(v.string()),
		now: v.number()
	},
	returns: v.array(
		v.object({
			productId: v.union(v.string(), v.null()),
			price: v.union(vDodoPublicPrice, v.null()),
			expiresAt: v.number(),
			refreshFailed: v.boolean(),
			retryAt: v.union(v.number(), v.null()),
			validatedAt: v.union(v.number(), v.null()),
			leaseActive: v.boolean()
		})
	),
	handler: async (ctx, { environment, cacheKey, productIds, now }) => {
		// The legacy aggregate row was keyed to a specific product set; serve it
		// only when the current catalog maps to exactly that set, so an old
		// snapshot never misattributes prices after a remap.
		let expectedLegacyIds: Set<string> | null = null;

		if (cacheKey.startsWith(`${environment}:`)) {
			expectedLegacyIds = new Set(
				cacheKey
					.slice(environment.length + 1)
					.split('|')
					.map((part) => part.split(':')[2])
					.filter((id) => id !== undefined && id.length > 0)
			);
		}

		const requestIds = new Set(productIds);

		const rows: Array<{
			productId: string | null;
			price: DodoPublicPrice | null;
			expiresAt: number;
			refreshFailed: boolean;
			retryAt: number | null;
			validatedAt: number | null;
			leaseActive: boolean;
		}> = [];

		for (const productId of requestIds) {
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

		// Legacy aggregate row: serves prices for products without a per-product
		// row while unexpired; per-product rows always win for products they cover.
		if (
			expectedLegacyIds !== null &&
			expectedLegacyIds.size === requestIds.size &&
			[...requestIds].every((id) => expectedLegacyIds.has(id))
		) {
			const legacy = await ctx.db
				.query('dodoPricingCache')
				.withIndex('by_cacheKey', (query) => query.eq('cacheKey', cacheKey))
				.unique();

			if (legacy && legacy.expiresAt > now && legacy.tierPrices) {
				for (const tierPrice of legacy.tierPrices) {
					if (rows.some((row) => row.productId === tierPrice.price.productId)) continue;

					rows.push({
						productId: tierPrice.price.productId,
						price: tierPrice.price,
						expiresAt: legacy.expiresAt,
						refreshFailed: false,
						retryAt: null,
						validatedAt: legacy.validatedAt ?? legacy.expiresAt,
						leaseActive: false
					});
				}
			}
		}

		return rows;
	}
});

/**
 * Claims the refresh lease for one product; false when another instance holds
 * it, the row is fresh, or a negative-cache/backoff deadline is still pending.
 * The backoff recheck happens here, inside the transaction, so the action's
 * earlier snapshot cannot race a fresh negative entry.
 */
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

			// A live lease from another owner means a refresh is already running.
			// A fresh non-failed row also needs no refresh.
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

		// Durable global budget: count live leases environment-wide and refuse
		// the claim once the cap is reached, regardless of which instance owns
		// them. This is the last check so budget contention loses to every
		// cheaper per-row reason to refuse.
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
			cacheKey: `${args.environment}:${args.productId}`,
			environment: args.environment,
			productId: args.productId,
			expiresAt: 0,
			leaseOwner: args.leaseOwner,
			leaseExpiresAt: args.leaseExpiresAt
		});

		return true;
	}
});

/** Writes a single product outcome (positive or negative) and releases the lease. */
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

		// Only the lease holder may write; an expired lease means another
		// instance recovered the refresh and owns the row now.
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
						? (cached.validatedAt ?? cached.expiresAt)
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
				weeklyUsageDollars: tier.weekly / MODEL_USAGE_UNITS_PER_DOLLAR,
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
		const tier = await lookupTierRow(ctx, tierId);

		if (!tier) return null;
		const productId = interval === 'monthly' ? tier.monthlyProductId : tier.annualProductId;

		if (!productId) return null;

		if ((await lookupTierForProduct(ctx, productId)) === null) return null;

		return productId;
	}
});

async function lookupTierRow(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
) {
	const rows = await ctx.db
		.query('tiers')
		.withIndex('by_tierId', (query) => query.eq('tierId', tierId))
		.take(2);

	if (rows.length > 1) throw new Error(`Duplicate tiers rows for tier "${tierId}".`);

	return rows[0] ?? null;
}

/** Mapped product for a tier/interval without the uniqueness gate; internal use. */
export async function getTierProductId(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string,
	interval: 'monthly' | 'annual'
): Promise<string | null> {
	const tier = await lookupTierRow(ctx, tierId);

	if (!tier) return null;

	return interval === 'monthly' ? (tier.monthlyProductId ?? null) : (tier.annualProductId ?? null);
}

export const getTierForProduct = internalQuery({
	args: { productId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, { productId }) => await lookupTierForProduct(ctx, productId)
});
