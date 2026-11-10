import { action, internalQuery, type ActionCtx } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { ConvexError, v, type ObjectType } from 'convex/values';
import { getExecutionRun } from '@convex/lib/auth';
import { runAcceptsNewWork } from '@convex/lib/runLease';
import { agentError } from '@convex/lib/agentErrors';
import { getProviderHandoff } from '@convex/lib/contextHandoff';
import {
	credentialName,
	deleteVaultObject,
	providerFetch,
	readVaultObject,
	storeVaultObject
} from '@convex/lib/workosVault';

const apiKeyProviderIds = [
	'openai',
	'anthropic',
	'vercel',
	'openrouter',
	'opencode',
	'opencode-go'
] as const;

type ApiKeyProvider = (typeof apiKeyProviderIds)[number];

type CredentialProvider = ApiKeyProvider | 'claude';

const vApiKeyProvider = v.union(...apiKeyProviderIds.map((provider) => v.literal(provider)));

const vCredentialProvider = v.union(vApiKeyProvider, v.literal('claude'));

function bearer(apiKey: string): HeadersInit {
	return { authorization: `Bearer ${apiKey}` };
}

const apiKeyProviders: Record<
	ApiKeyProvider,
	{ label: string; validationUrl: string; headers: (apiKey: string) => HeadersInit }
> = {
	openai: {
		label: 'OpenAI',
		validationUrl: 'https://api.openai.com/v1/models',
		headers: bearer
	},
	anthropic: {
		label: 'Anthropic',
		validationUrl: 'https://api.anthropic.com/v1/models',
		headers: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' })
	},
	vercel: {
		label: 'Vercel AI Gateway',
		validationUrl: 'https://ai-gateway.vercel.sh/v1/credits',
		headers: bearer
	},
	openrouter: {
		label: 'OpenRouter',
		validationUrl: 'https://openrouter.ai/api/v1/key',
		headers: bearer
	},
	opencode: {
		label: 'OpenCode',
		validationUrl: 'https://opencode.ai/inference/v1/models',
		headers: bearer
	},
	'opencode-go': {
		label: 'OpenCode Go',
		validationUrl: 'https://opencode.ai/inference/go/v1/models',
		headers: bearer
	}
};

const CLAUDE_TOKEN_PATTERN = /^sk-ant-oat01-[\w-]+$/;

function vaultName(provider: CredentialProvider, userId: string) {
	return credentialName(`sprocket-${provider}-`, userId);
}

async function userCredentialName(ctx: ActionCtx, provider: CredentialProvider) {
	const identity = await ctx.auth.getUserIdentity();

	if (!identity) throw new Error('Authentication required.');

	return await vaultName(provider, identity.subject);
}

async function isConfigured(ctx: ActionCtx, provider: CredentialProvider) {
	return (await readVaultObject(await userCredentialName(ctx, provider))) !== null;
}

export const getMyConfiguration = action({
	args: {},
	returns: v.object({
		openai: v.boolean(),
		claude: v.boolean(),
		anthropic: v.boolean(),
		vercel: v.boolean(),
		openrouter: v.boolean(),
		opencode: v.boolean(),
		opencodeGo: v.boolean()
	}),
	handler: async (ctx) => {
		const [openai, claude, anthropic, vercel, openrouter, opencode, opencodeGo] = await Promise.all(
			(
				[
					'openai',
					'claude',
					'anthropic',
					'vercel',
					'openrouter',
					'opencode',
					'opencode-go'
				] as const
			).map((provider) => isConfigured(ctx, provider))
		);

		return { openai, claude, anthropic, vercel, openrouter, opencode, opencodeGo };
	}
});

async function saveApiKeyHandler(ctx: ActionCtx, provider: ApiKeyProvider, rawApiKey: string) {
	const { label, validationUrl, headers } = apiKeyProviders[provider];
	const name = await userCredentialName(ctx, provider);
	const apiKey = rawApiKey.trim();

	if (!apiKey || apiKey.length > 512) throw new ConvexError(`Enter a valid ${label} API key.`);
	const response = await providerFetch(validationUrl, { headers: headers(apiKey) });

	if (response.status === 401 || response.status === 403) {
		throw new ConvexError(`${label} rejected this API key.`);
	}

	if (!response.ok) {
		throw new ConvexError(`${label} could not validate this API key. Try again in a moment.`);
	}

	await storeVaultObject(name, apiKey);

	return null;
}

async function removeApiKeyHandler(ctx: ActionCtx, provider: ApiKeyProvider) {
	await deleteVaultObject(await userCredentialName(ctx, provider));

	return null;
}

export const saveApiKey = action({
	args: { provider: vApiKeyProvider, apiKey: v.string() },
	returns: v.null(),
	handler: (ctx, args) => saveApiKeyHandler(ctx, args.provider, args.apiKey)
});

export const removeApiKey = action({
	args: { provider: vApiKeyProvider },
	returns: v.null(),
	handler: (ctx, args) => removeApiKeyHandler(ctx, args.provider)
});

export const saveOpenAiKey = action({
	args: { apiKey: v.string() },
	returns: v.null(),
	handler: (ctx, args) => saveApiKeyHandler(ctx, 'openai', args.apiKey)
});

export const removeOpenAiKey = action({
	args: {},
	returns: v.null(),
	handler: (ctx) => removeApiKeyHandler(ctx, 'openai')
});

export const saveClaudeToken = action({
	args: { token: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const name = await userCredentialName(ctx, 'claude');
		const token = args.token.trim();

		if (token.length > 512 || !CLAUDE_TOKEN_PATTERN.test(token)) {
			throw new ConvexError("That isn't a valid Claude token. Sign in with Claude again.");
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

		if (!runAcceptsNewWork(run, args.claimId, Date.now())) {
			throw agentError('RUN_NO_LONGER_ACTIVE');
		}

		if (
			(run.completionProvider ?? 'spikonado') !== args.provider &&
			(await getProviderHandoff(ctx, run, await ctx.db.get('threadRecords', run.threadId)))
				?.completionProvider !== args.provider
		) {
			throw new ConvexError(`Run is not configured to use ${args.provider} credentials.`);
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

	const object = await readVaultObject(await vaultName(provider, userId));

	if (!object) return null;
	await ctx.runQuery(internal.providerCredentials.authorizeRunCredential, authorizeArgs);

	return object.value;
}

async function issueApiKeyHandler(
	ctx: ActionCtx,
	args: ObjectType<typeof runCredentialArgs>,
	provider: ApiKeyProvider
) {
	const apiKey = await readRunCredential(ctx, args, provider);

	if (apiKey === null) {
		throw new ConvexError(
			`${apiKeyProviders[provider].label} is no longer configured. Add an API key in Settings.`
		);
	}

	return { apiKey };
}

export const issueApiKey = action({
	args: { ...runCredentialArgs, provider: vApiKeyProvider },
	returns: v.object({ apiKey: v.string() }),
	handler: (ctx, { provider, ...args }) => issueApiKeyHandler(ctx, args, provider)
});

export const issueOpenAiCredential = action({
	args: runCredentialArgs,
	returns: v.object({ apiKey: v.string() }),
	handler: (ctx, args) => issueApiKeyHandler(ctx, args, 'openai')
});

export const issueClaudeCredential = action({
	args: runCredentialArgs,
	returns: v.object({ token: v.string() }),
	handler: async (ctx, args) => {
		const token = await readRunCredential(ctx, args, 'claude');

		if (token === null) {
			throw new ConvexError('Claude is no longer connected. Add a token in Settings.');
		}

		return { token };
	}
});
