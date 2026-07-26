import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { getExecutionRun } from '@convex/lib/auth';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import {
	isRunFinalStatus,
	vCredentialProviderId,
	type CredentialProviderId
} from '@convex/lib/validators';

async function findCredentialRef(
	ctx: MutationCtx | QueryCtx,
	userId: string,
	provider: CredentialProviderId
) {
	return ctx.db
		.query('providerCredentialRefs')
		.withIndex('by_userId_provider', (query) => query.eq('userId', userId).eq('provider', provider))
		.unique();
}

export const getCredentialRef = internalQuery({
	args: {
		userId: v.string(),
		provider: vCredentialProviderId
	},
	handler: async (ctx, args) => findCredentialRef(ctx, args.userId, args.provider)
});

export const getAuthorizedRun = internalQuery({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		if (isRunFinalStatus(run.status)) {
			return null;
		}
		if (!ownsActiveRunClaim(run, args.claimId, Date.now())) {
			return null;
		}
		return { userId: run.userId };
	}
});

export const upsertCredentialRef = internalMutation({
	args: {
		userId: v.string(),
		provider: vCredentialProviderId,
		vaultObjectId: v.string(),
		keyHint: v.string(),
		updatedAt: v.number()
	},
	handler: async (ctx, args) => {
		const existing = await findCredentialRef(ctx, args.userId, args.provider);
		if (existing) {
			await ctx.db.patch(existing._id, {
				vaultObjectId: args.vaultObjectId,
				keyHint: args.keyHint,
				updatedAt: args.updatedAt
			});
			return existing._id;
		}
		return await ctx.db.insert('providerCredentialRefs', {
			userId: args.userId,
			provider: args.provider,
			vaultObjectId: args.vaultObjectId,
			keyHint: args.keyHint,
			updatedAt: args.updatedAt
		});
	}
});

export const deleteCredentialRef = internalMutation({
	args: {
		userId: v.string(),
		provider: vCredentialProviderId
	},
	handler: async (ctx, args) => {
		const existing = await findCredentialRef(ctx, args.userId, args.provider);
		if (existing) {
			await ctx.db.delete(existing._id);
		}
	}
});
