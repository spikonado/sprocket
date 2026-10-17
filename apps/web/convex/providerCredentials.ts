import { action, internalQuery, type ActionCtx } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { v } from 'convex/values';
import { getExecutionRun } from '@convex/lib/auth';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { getProviderHandoff } from '@convex/lib/contextHandoff';
import {
	credentialName,
	deleteVaultObject,
	providerFetch,
	readVaultObject,
	storeVaultObject,
	type VaultObject
} from '@convex/lib/workosVault';

const OPENAI_API_ORIGIN = 'https://api.openai.com';

const OPENAI_CREDENTIAL_NAME_PREFIX = 'sprocket-openai-';

async function validateOpenAiKey(apiKey: string): Promise<void> {
	const response = await providerFetch(`${OPENAI_API_ORIGIN}/v1/models`, {
		headers: { authorization: `Bearer ${apiKey}` }
	});

	if (response.status === 401 || response.status === 403) {
		throw new Error('OpenAI rejected this API key.');
	}

	if (!response.ok) {
		throw new Error('OpenAI could not validate this API key. Try again in a moment.');
	}
}

export const getMyConfiguration = action({
	args: {},
	returns: v.object({
		openai: v.boolean(),
		chatgpt: v.boolean(),
		chatgptModelIds: v.union(v.array(v.string()), v.null())
	}),
	handler: async (
		ctx: ActionCtx
	): Promise<{ openai: boolean; chatgpt: boolean; chatgptModelIds: string[] | null }> => {
		const identity = await ctx.auth.getUserIdentity();

		if (!identity) throw new Error('Authentication required.');

		const openAiObject: VaultObject | null = await readVaultObject(
			await credentialName(OPENAI_CREDENTIAL_NAME_PREFIX, identity.subject)
		);

		// Cloud-held ChatGPT is retired; released clients read these fields to
		// render the connection state and must see it as disconnected.
		return { openai: openAiObject !== null, chatgpt: false, chatgptModelIds: null };
	}
});

export const saveOpenAiKey = action({
	args: { apiKey: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();

		if (!identity) throw new Error('Authentication required.');
		const apiKey = args.apiKey.trim();

		if (!apiKey || apiKey.length > 512) throw new Error('Enter a valid OpenAI API key.');
		await validateOpenAiKey(apiKey);
		await storeVaultObject(
			await credentialName(OPENAI_CREDENTIAL_NAME_PREFIX, identity.subject),
			apiKey
		);

		return null;
	}
});

export const removeOpenAiKey = action({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();

		if (!identity) throw new Error('Authentication required.');
		await deleteVaultObject(await credentialName(OPENAI_CREDENTIAL_NAME_PREFIX, identity.subject));

		return null;
	}
});

export const authorizeOpenAiCredential = internalQuery({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.string(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);

		if (
			run.cancellationRequestedAt !== undefined ||
			!ownsActiveRunClaim(run, args.claimId, Date.now())
		) {
			throw new Error(RUN_NO_LONGER_ACTIVE);
		}

		if (
			(run.completionProvider ?? 'spikonado') !== 'openai' &&
			(await getProviderHandoff(ctx, run, await ctx.db.get('threadRecords', run.threadId)))
				?.completionProvider !== 'openai'
		) {
			throw new Error('Run is not configured to use OpenAI directly.');
		}

		return run.userId;
	}
});

export const issueOpenAiCredential = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.object({ apiKey: v.string() }),
	handler: async (ctx, args) => {
		const userId: string = await ctx.runQuery(
			internal.providerCredentials.authorizeOpenAiCredential,
			args
		);

		const object = await readVaultObject(
			await credentialName(OPENAI_CREDENTIAL_NAME_PREFIX, userId)
		);

		if (!object) throw new Error('OpenAI is no longer configured. Add an API key in Settings.');
		await ctx.runQuery(internal.providerCredentials.authorizeOpenAiCredential, args);

		return { apiKey: object.value };
	}
});
