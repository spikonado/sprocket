import { NonRetryableError } from '@convex-dev/workpool';
import { v, type Infer } from 'convex/values';
import { internal } from '@convex/_generated/api';
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx
} from '@convex/_generated/server';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import {
	isExactListing,
	isLcscCode,
	lookupDigikey,
	lookupJlcpcb,
	lookupLcsc,
	lookupMouser,
	normalizePartNumber,
	sourceConfigured,
	type PartListing,
	type SourceLimits,
	type SourceOutcome
} from '@convex/lib/partSources';
import {
	partSources,
	vLookupPartsResult,
	vPartListing,
	vPartSource,
	type LookupPartsPayload,
	type PartSource
} from '@convex/lib/validators';

export const MAX_PARTS = 50;

/** The DigiKey and Mouser daily quotas are shared by every user. */
export const CACHE_TTL_MS = 30 * 60_000;

const LOOKUP_DEADLINE_MS = 3 * 60_000;

export const PRICE_BREAKS_SHOWN = 5;

const CLEANUP_BATCH_SIZE = 200;

type LookupPartsResult = Infer<typeof vLookupPartsResult>;

type SourceNotes = NonNullable<LookupPartsResult['unavailable']>;

const SOURCE_LOOKUPS: Record<
	PartSource,
	(keys: string[], limits: SourceLimits) => Promise<Map<string, SourceOutcome>>
> = { jlcpcb: lookupJlcpcb, lcsc: lookupLcsc, digikey: lookupDigikey, mouser: lookupMouser };

export const readCache = internalQuery({
	args: { source: vPartSource, queries: v.array(v.string()), now: v.number() },
	returns: v.array(v.object({ query: v.string(), listings: v.array(vPartListing) })),
	handler: async (ctx, args) => {
		const hits = [];

		for (const query of args.queries) {
			const entry = await ctx.db
				.query('partListingCache')
				.withIndex('by_source_and_query', (q) => q.eq('source', args.source).eq('query', query))
				.first();

			if (entry && entry.expiresAt > args.now) hits.push({ query, listings: entry.listings });
		}

		return hits;
	}
});

export const writeCache = internalMutation({
	args: {
		source: vPartSource,
		entries: v.array(v.object({ query: v.string(), listings: v.array(vPartListing) }))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const expiresAt = Date.now() + CACHE_TTL_MS;

		for (const { query, listings } of args.entries) {
			const existing = await ctx.db
				.query('partListingCache')
				.withIndex('by_source_and_query', (q) => q.eq('source', args.source).eq('query', query))
				.first();

			if (existing) {
				await ctx.db.patch('partListingCache', existing._id, { listings, expiresAt });
			} else {
				await ctx.db.insert('partListingCache', {
					source: args.source,
					query,
					listings,
					expiresAt
				});
			}
		}

		return null;
	}
});

export const cleanupExpired = internalMutation({
	args: {},
	returns: v.number(),
	handler: async (ctx): Promise<number> => {
		const expired = await ctx.db
			.query('partListingCache')
			.withIndex('by_expiresAt', (q) => q.lte('expiresAt', Date.now()))
			.take(CLEANUP_BATCH_SIZE);

		for (const entry of expired) await ctx.db.delete('partListingCache', entry._id);

		if (expired.length === CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.partsLookup.cleanupExpired, {});
		}

		return expired.length;
	}
});

async function lookupSource(
	ctx: ActionCtx,
	source: PartSource,
	keys: string[],
	limits: SourceLimits
): Promise<Map<string, SourceOutcome>> {
	const queries = [...new Set(keys)];

	if (queries.length === 0) return new Map();

	const hits = await ctx.runQuery(internal.partsLookup.readCache, {
		source,
		queries,
		now: Date.now()
	});

	const outcomes = new Map<string, SourceOutcome>(
		hits.map(({ query, listings }) => [query, { listings }])
	);

	const misses = queries.filter((query) => !outcomes.has(query));

	if (misses.length === 0) return outcomes;
	const fetched = await SOURCE_LOOKUPS[source](misses, limits);

	const entries = [...fetched].flatMap(([query, outcome]) =>
		'listings' in outcome ? [{ query, listings: outcome.listings }] : []
	);

	if (entries.length > 0) {
		await ctx.runMutation(internal.partsLookup.writeCache, { source, entries });
	}

	for (const [query, outcome] of fetched) outcomes.set(query, outcome);

	return outcomes;
}

function withUnitPrice(listing: PartListing, quantity: number) {
	const breaks = listing.priceBreaks.toSorted((a, b) => a.quantity - b.quantity);

	const applicable = Math.max(
		breaks.findLastIndex((price) => price.quantity <= quantity),
		0
	);

	return {
		...listing,
		unitPrice: breaks[applicable]?.price,
		priceBreaks: breaks.slice(applicable, applicable + PRICE_BREAKS_SHOWN)
	};
}

type PartTarget = { part: string; query: string; mpn?: string; keys: Record<PartSource, string[]> };

/** LCSC codes come from JLCPCB, and so do the MPNs of parts given by LCSC code. */
function partTarget(part: string, jlcpcb: Map<string, SourceOutcome>): PartTarget {
	const query = normalizePartNumber(part);
	const outcome = jlcpcb.get(query);
	const listings = outcome && 'listings' in outcome ? outcome.listings : [];

	const exact = listings.filter((listing) => isExactListing(listing, query));

	const mpn = isLcscCode(query) ? exact[0] && normalizePartNumber(exact[0].mpn) : query;

	const mpnKeys = mpn ? [mpn] : [];

	return {
		part,
		query,
		mpn,
		keys: {
			jlcpcb: [query],
			lcsc: isLcscCode(query) ? [query] : exact.map((listing) => listing.sku),
			digikey: mpnKeys,
			mouser: mpnKeys
		}
	};
}

function partResult(
	target: PartTarget,
	outcomes: Partial<Record<PartSource, Map<string, SourceOutcome>>>,
	quantity: number
): LookupPartsResult['parts'][number] {
	const offers: PartListing[] = [];
	const errors: SourceNotes = {};
	const jlcpcbFailed = 'error' in (outcomes.jlcpcb?.get(target.query) ?? {});

	for (const source of partSources) {
		const results = outcomes[source];

		if (!results) continue;
		const keys = target.keys[source];

		if (keys.length === 0) {
			errors[source] = jlcpcbFailed ? 'skipped because the JLCPCB lookup failed' : 'not found';
			continue;
		}

		for (const key of keys) {
			const outcome = results.get(key);

			if (!outcome) continue;

			if ('error' in outcome) errors[source] ??= outcome.error;
			else offers.push(...outcome.listings);
		}

		if (!errors[source] && !offers.some((offer) => offer.source === source)) {
			errors[source] = 'not found';
		}
	}

	const exactMatch = (offer: PartListing) =>
		isExactListing(offer, target.query) ||
		(target.mpn !== undefined && isExactListing(offer, target.mpn));

	const sorted = offers.toSorted((a, b) => Number(exactMatch(b)) - Number(exactMatch(a)));

	return {
		part: target.part,
		offers: sorted.map((offer) => withUnitPrice(offer, quantity)),
		errors: Object.keys(errors).length > 0 ? errors : undefined
	};
}

export async function lookupParts(
	ctx: ActionCtx,
	payload: LookupPartsPayload
): Promise<LookupPartsResult> {
	const parts = payload.parts.map((part) => part.trim());

	if (parts.length === 0 || parts.length > MAX_PARTS) {
		throw new NonRetryableError(`List 1 to ${MAX_PARTS} part numbers.`);
	}

	if (parts.some((part) => !part)) throw new NonRetryableError('Part numbers cannot be empty.');
	const quantity = payload.quantity ?? 1;

	if (!Number.isSafeInteger(quantity) || quantity < 1) {
		throw new NonRetryableError('quantity must be a positive integer.');
	}

	const limits: SourceLimits = { deadline: Date.now() + LOOKUP_DEADLINE_MS };

	const jlcpcb = await lookupSource(ctx, 'jlcpcb', parts.map(normalizePartNumber), limits);
	const targets = parts.map((part) => partTarget(part, jlcpcb));

	const unavailable: SourceNotes = {};
	const outcomes: Partial<Record<PartSource, Map<string, SourceOutcome>>> = { jlcpcb };

	await Promise.all(
		(['lcsc', 'digikey', 'mouser'] as const).map(async (source) => {
			if (!sourceConfigured(source)) {
				unavailable[source] = 'not configured';

				return;
			}

			const keys = targets.flatMap((target) => target.keys[source]);
			outcomes[source] = await lookupSource(ctx, source, keys, limits);
		})
	);

	return {
		quantity,
		unavailable: Object.keys(unavailable).length > 0 ? unavailable : undefined,
		parts: targets.map((target) => partResult(target, outcomes, quantity))
	};
}

export const execute = internalAction({
	args: { jobId: v.id('executorJobs'), runId: v.id('runs'), claimId: v.string() },
	returns: vLookupPartsResult,
	handler: async (ctx, args): Promise<LookupPartsResult> => {
		const job = await ctx.runMutation(internal.webSearchPool.getCloudToolJob, args);

		if (job?.kind !== 'lookup_parts' || !('parts' in job.payload)) {
			throw new NonRetryableError(RUN_NO_LONGER_ACTIVE);
		}

		return await lookupParts(ctx, job.payload);
	}
});
