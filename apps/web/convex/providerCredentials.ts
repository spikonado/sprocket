import { action, internalQuery, type ActionCtx } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { v, type ObjectType } from 'convex/values';
import { getExecutionRun } from '@convex/lib/auth';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { agentError } from '@convex/lib/agentErrors';
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

const credentialNamePrefixes = {
	openai: 'sprocket-openai-',
	claude: 'sprocket-claude-'
} as const;

type CredentialProvider = keyof typeof credentialNamePrefixes;

const vCredentialProvider = v.union(v.literal('openai'), v.literal('claude'));

const CLAUDE_TOKEN_PATTERN = /^sk-ant-oat01-[\w-]+$/;

async function userCredentialName(ctx: ActionCtx, provider: CredentialProvider) {
	const identity = await ctx.auth.getUserIdentity();

	if (!identity) throw new Error('Authentication required.');

	return await credentialName(credentialNamePrefixes[provider], identity.subject);
}

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
		claude: v.boolean(),
		chatgpt: v.boolean(),
		chatgptModelIds: v.union(v.array(v.string()), v.null())
	}),
	handler: async (
		ctx: ActionCtx
	): Promise<{
		openai: boolean;
		claude: boolean;
		chatgpt: boolean;
		chatgptModelIds: string[] | null;
	}> => {
		const [openAiObject, claudeObject]: Array<VaultObject | null> = await Promise.all([
			readVaultObject(await userCredentialName(ctx, 'openai')),
			readVaultObject(await userCredentialName(ctx, 'claude'))
		]);

		return {
			openai: openAiObject !== null,
			claude: claudeObject !== null,
			chatgpt: false,
			chatgptModelIds: null
		};
	}
});

export const saveOpenAiKey = action({
	args: { apiKey: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const name = await userCredentialName(ctx, 'openai');
		const apiKey = args.apiKey.trim();

		if (!apiKey || apiKey.length > 512) throw new Error('Enter a valid OpenAI API key.');
		await validateOpenAiKey(apiKey);
		await storeVaultObject(name, apiKey);

		return null;
	}
});

export const removeOpenAiKey = action({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await deleteVaultObject(await userCredentialName(ctx, 'openai'));

		return null;
	}
});

export const saveClaudeToken = action({
	args: { token: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const name = await userCredentialName(ctx, 'claude');
		const token = args.token.trim();

		if (token.length > 512 || !CLAUDE_TOKEN_PATTERN.test(token)) {
			throw new Error('Enter a valid Claude token from `claude setup-token`.');
		}

		await storeVaultObject(name, token);

		return null;
	}
});

export const removeClaudeToken = action({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await deleteVaultObject(await userCredentialName(ctx, 'claude'));

		return null;
	}
});

const runCredentialArgs = {
	runId: v.id('runs'),
	claimId: v.string(),
	executionSecret: v.string()
};

export const authorizeRunCredential = internalQuery({
	args: { ...runCredentialArgs, provider: vCredentialProvider },
	returns: v.string(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);

		if (
			run.cancellationRequestedAt !== undefined ||
			!ownsActiveRunClaim(run, args.claimId, Date.now())
		) {
			throw agentError('RUN_NO_LONGER_ACTIVE');
		}

		if (
			(run.completionProvider ?? 'spikonado') !== args.provider &&
			(await getProviderHandoff(ctx, run, await ctx.db.get('threadRecords', run.threadId)))
				?.completionProvider !== args.provider
		) {
			throw new Error(`Run is not configured to use ${args.provider} credentials.`);
		}

		return run.userId;
	}
});

async function readRunCredential(
	ctx: ActionCtx,
	args: ObjectType<typeof runCredentialArgs>,
	provider: CredentialProvider
): Promise<string | null> {
	const authorizeArgs = { ...args, provider };

	const userId: string = await ctx.runQuery(
		internal.providerCredentials.authorizeRunCredential,
		authorizeArgs
	);

	const object = await readVaultObject(
		await credentialName(credentialNamePrefixes[provider], userId)
	);

	if (!object) return null;
	await ctx.runQuery(internal.providerCredentials.authorizeRunCredential, authorizeArgs);

	return object.value;
}

export const issueOpenAiCredential = action({
	args: runCredentialArgs,
	returns: v.object({ apiKey: v.string() }),
	handler: async (ctx, args) => {
		const apiKey = await readRunCredential(ctx, args, 'openai');

		if (apiKey === null) {
			throw new Error('OpenAI is no longer configured. Add an API key in Settings.');
		}

		return { apiKey };
	}
});

export const issueClaudeCredential = action({
	args: runCredentialArgs,
	returns: v.object({ token: v.string() }),
	handler: async (ctx, args) => {
		const token = await readRunCredential(ctx, args, 'claude');

		if (token === null) throw new Error('Claude is no longer connected. Add a token in Settings.');

		return { token };
	}
});
