import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel } from '@convex/_generated/dataModel';

export type ResolvedActor = {
	userId: string;
	identity: {
		subject?: string;
		email?: string;
		name?: string;
		tokenIdentifier: string;
	} | null;
};

export async function resolveActor(
	ctx: GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>,
	guestId?: string
): Promise<ResolvedActor> {
	const identity = await ctx.auth.getUserIdentity();
	if (identity?.tokenIdentifier) {
		return {
			userId: identity.tokenIdentifier,
			identity: {
				subject: identity.subject ?? undefined,
				email: identity.email ?? undefined,
				name: identity.name ?? undefined,
				tokenIdentifier: identity.tokenIdentifier
			}
		};
	}

	const normalizedGuestId: string | undefined = guestId?.trim();
	if (!normalizedGuestId) {
		throw new Error('Authentication required.');
	}
	return {
		userId: `guest:${normalizedGuestId}`,
		identity: null
	};
}
