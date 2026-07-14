import type {
	GenericActionCtx,
	GenericMutationCtx,
	GenericQueryCtx,
	UserIdentity
} from 'convex/server';
import type { DataModel } from '@convex/_generated/dataModel';

export async function getUserId(
	ctx: GenericActionCtx<DataModel> | GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>
): Promise<string> {
	const identity: UserIdentity | null = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error('Authentication required.');
	}
	return identity.subject;
}
