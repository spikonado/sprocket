'use node';

import { WorkOS } from '@workos-inc/node';
import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { action, type ActionCtx } from '@convex/_generated/server';
import type { Id } from '@convex/_generated/dataModel';
import { getUserId } from '@convex/lib/auth';
import { VAULT_PROVIDER_KEY_CONTEXT, keyHint, parseChatGPTAuth } from '@convex/lib/providers';
import {
	vCredentialProviderId,
	type CredentialProviderId
} from '@convex/lib/validators';

function workosClient(): WorkOS {
	const apiKey = process.env.WORKOS_API_KEY?.trim();
	if (!apiKey) {
		throw new Error('WorkOS Vault is not configured.');
	}
	return new WorkOS(apiKey);
}

function vaultObjectName(provider: CredentialProviderId, userId: string): string {
	return provider === 'chatgpt' ? `chatgpt-auth:${userId}` : `openai-api-key:${userId}`;
}

async function upsertVaultSecret(
	ctx: ActionCtx,
	userId: string,
	provider: CredentialProviderId,
	value: string,
	hint: string
): Promise<{ configured: true; keyHint: string; updatedAt: number }> {
	const workos = workosClient();
	const existing = await ctx.runQuery(internal.providerCredentialRefs.getCredentialRef, {
		userId,
		provider
	});
	const updatedAt = Date.now();
	let vaultObjectId: string;
	if (existing) {
		await workos.vault.updateObject({ id: existing.vaultObjectId, value });
		vaultObjectId = existing.vaultObjectId;
	} else {
		const created = await workos.vault.createObject({
			name: vaultObjectName(provider, userId),
			value,
			context: { ...VAULT_PROVIDER_KEY_CONTEXT }
		});
		vaultObjectId = created.id;
	}
	await ctx.runMutation(internal.providerCredentialRefs.upsertCredentialRef, {
		userId,
		provider,
		vaultObjectId,
		keyHint: hint,
		updatedAt
	});
	return { configured: true, keyHint: hint, updatedAt };
}

async function clearVaultSecret(
	ctx: ActionCtx,
	userId: string,
	provider: CredentialProviderId
): Promise<{ configured: false }> {
	const existing = await ctx.runQuery(internal.providerCredentialRefs.getCredentialRef, {
		userId,
		provider
	});
	if (existing) {
		// Fail closed: deleting the Convex ref while Vault still holds the
		// deterministic object name permanently breaks later create/replace.
		await workosClient().vault.deleteObject({ id: existing.vaultObjectId });
		await ctx.runMutation(internal.providerCredentialRefs.deleteCredentialRef, {
			userId,
			provider
		});
	}
	return { configured: false };
}

export const setOpenAIApiKey = action({
	args: { apiKey: v.string() },
	handler: async (ctx, args): Promise<{ configured: true; keyHint: string; updatedAt: number }> => {
		const userId = await getUserId(ctx);
		const apiKey = args.apiKey.trim();
		if (apiKey.length < 16) {
			throw new Error('OpenAI API key looks invalid.');
		}
		return await upsertVaultSecret(ctx, userId, 'openai', apiKey, keyHint(apiKey));
	}
});

export const clearOpenAIApiKey = action({
	args: {},
	handler: async (ctx): Promise<{ configured: false }> => {
		const userId = await getUserId(ctx);
		return await clearVaultSecret(ctx, userId, 'openai');
	}
});

export const setChatGPTAuth = action({
	args: { authJson: v.string() },
	handler: async (ctx, args): Promise<{ configured: true; keyHint: string; updatedAt: number }> => {
		const userId = await getUserId(ctx);
		const { authJson, keyHint: hint } = parseChatGPTAuth(args.authJson);
		return await upsertVaultSecret(ctx, userId, 'chatgpt', authJson, hint);
	}
});

export const clearChatGPTAuth = action({
	args: {},
	handler: async (ctx): Promise<{ configured: false }> => {
		const userId = await getUserId(ctx);
		return await clearVaultSecret(ctx, userId, 'chatgpt');
	}
});

export const getRunProviderCredential = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		provider: vCredentialProviderId
	},
	handler: async (
		ctx,
		args
	): Promise<
		{ provider: 'openai'; apiKey: string } | { provider: 'chatgpt'; authJson: string } | null
	> => {
		const userId = await authorizeRunCredentialAccess(
			ctx,
			args.runId,
			args.claimId,
			args.executionSecret
		);
		const credential = await ctx.runQuery(internal.providerCredentialRefs.getCredentialRef, {
			userId,
			provider: args.provider
		});
		if (!credential) return null;
		const value = (
			await workosClient().vault.readObject({ id: credential.vaultObjectId })
		).value?.trim();
		if (!value) {
			throw new Error(
				args.provider === 'chatgpt'
					? 'ChatGPT auth is unavailable.'
					: 'OpenAI API key is unavailable.'
			);
		}
		return args.provider === 'chatgpt'
			? { provider: 'chatgpt', authJson: value }
			: { provider: 'openai', apiKey: value };
	}
});

/** Best-effort write-back after the local Rig ChatGPT client refreshes tokens. */
export const updateRunChatGPTAuth = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		authJson: v.string()
	},
	handler: async (ctx, args): Promise<{ updated: boolean }> => {
		const userId = await authorizeRunCredentialAccess(
			ctx,
			args.runId,
			args.claimId,
			args.executionSecret
		);
		const existing = await ctx.runQuery(internal.providerCredentialRefs.getCredentialRef, {
			userId,
			provider: 'chatgpt'
		});
		if (!existing) return { updated: false };
		const { authJson, keyHint: hint } = parseChatGPTAuth(args.authJson);
		await workosClient().vault.updateObject({
			id: existing.vaultObjectId,
			value: authJson
		});
		await ctx.runMutation(internal.providerCredentialRefs.upsertCredentialRef, {
			userId,
			provider: 'chatgpt',
			vaultObjectId: existing.vaultObjectId,
			keyHint: hint,
			updatedAt: Date.now()
		});
		return { updated: true };
	}
});

async function authorizeRunCredentialAccess(
	ctx: ActionCtx,
	runId: Id<'runs'>,
	claimId: string,
	executionSecret: string
): Promise<string> {
	const run = await ctx.runQuery(internal.providerCredentialRefs.getAuthorizedRun, {
		runId,
		claimId,
		executionSecret
	});
	if (!run) throw new Error('Run is no longer active.');
	return run.userId;
}
