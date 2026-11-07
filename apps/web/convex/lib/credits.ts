import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';

export function grantForPayment(ctx: QueryCtx, paymentId: string) {
	return ctx.db
		.query('creditGrants')
		.withIndex('by_paymentId', (q) => q.eq('paymentId', paymentId))
		.unique();
}

/** Unrevoked, unexpired grants with units left, soonest expiry first. */
export async function spendableGrants(
	ctx: QueryCtx,
	userId: string,
	now: number
): Promise<Doc<'creditGrants'>[]> {
	const grants = await ctx.db
		.query('creditGrants')
		.withIndex('by_userId_and_expiresAt', (q) => q.eq('userId', userId).gt('expiresAt', now))
		.collect();

	return grants.filter((grant) => grant.revokedAt === undefined && grant.used < grant.units);
}

export function remainingCredits(grants: Doc<'creditGrants'>[]): number {
	return grants.reduce((sum, grant) => sum + grant.units - grant.used, 0);
}

/** Spends `units`, at most `remainingCredits(grants)`, from `grants` in order. */
export async function drawCredits(
	ctx: MutationCtx,
	grants: Doc<'creditGrants'>[],
	units: number
): Promise<void> {
	let left = units;

	for (const grant of grants) {
		if (left <= 0) break;
		const drawn = Math.min(left, grant.units - grant.used);
		await ctx.db.patch('creditGrants', grant._id, { used: grant.used + drawn });
		left -= drawn;
	}
}
