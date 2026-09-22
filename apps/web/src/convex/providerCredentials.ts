import { action, env, internalQuery } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { v } from 'convex/values';
import { getExecutionRun } from '@convex/lib/auth';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';

const WORKOS_VAULT_ORIGIN = 'https://api.workos.com';
const OPENAI_API_ORIGIN = 'https://api.openai.com';
const OPENAI_CREDENTIAL_NAME_PREFIX = 'sprocket-openai-';

type VaultObject = {
	id: string;
	name: string;
	value: string;
};

function workosApiKey(): string {
	const key = env.WORKOS_API_KEY?.trim();
	if (!key) throw new Error('Provider settings are not configured on this Sprocket deployment.');
	return key;
}

async function credentialName(userId: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
	const suffix = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	return `${OPENAI_CREDENTIAL_NAME_PREFIX}${suffix}`;
}

function workosHeaders(): HeadersInit {
	return {
		authorization: `Bearer ${workosApiKey()}`,
		'content-type': 'application/json'
	};
}

function isVaultObject(value: unknown): value is VaultObject {
	if (typeof value !== 'object' || value === null) return false;
	const object = value as Record<string, unknown>;
	return (
		typeof object.id === 'string' &&
		typeof object.name === 'string' &&
		typeof object.value === 'string'
	);
}

async function readVaultObject(name: string): Promise<VaultObject | null> {
	const response = await fetch(
		`${WORKOS_VAULT_ORIGIN}/vault/v1/kv/name/${encodeURIComponent(name)}`,
		{ headers: workosHeaders() }
	);
	if (response.status === 404) return null;
	if (!response.ok) throw new Error('Couldn’t read the provider credential from WorkOS Vault.');
	const value: unknown = await response.json();
	if (!isVaultObject(value) || value.name !== name) {
		throw new Error('WorkOS Vault returned an invalid provider credential.');
	}
	return value;
}

async function validateOpenAiKey(apiKey: string): Promise<void> {
	const response = await fetch(`${OPENAI_API_ORIGIN}/v1/models`, {
		headers: { authorization: `Bearer ${apiKey}` }
	});
	if (response.status === 401 || response.status === 403) {
		throw new Error('OpenAI rejected this API key.');
	}
	if (!response.ok) {
		throw new Error('OpenAI could not validate this API key. Try again in a moment.');
	}
}

async function storeOpenAiKey(userId: string, apiKey: string): Promise<void> {
	const name = await credentialName(userId);
	const existing = await readVaultObject(name);
	const response = existing
		? await fetch(`${WORKOS_VAULT_ORIGIN}/vault/v1/kv/${encodeURIComponent(existing.id)}`, {
				method: 'PUT',
				headers: workosHeaders(),
				body: JSON.stringify({ value: apiKey })
			})
		: await fetch(`${WORKOS_VAULT_ORIGIN}/vault/v1/kv`, {
				method: 'POST',
				headers: workosHeaders(),
				body: JSON.stringify({
					key_context: { application_id: env.WORKOS_CLIENT_ID },
					name,
					value: apiKey
				})
			});
	if (!response.ok) throw new Error('Couldn’t save the OpenAI key in WorkOS Vault.');
}

export const getMyConfiguration = action({
	args: {},
	returns: v.object({ openai: v.boolean() }),
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Authentication required.');
		return { openai: (await readVaultObject(await credentialName(identity.subject))) !== null };
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
		await storeOpenAiKey(identity.subject, apiKey);
		return null;
	}
});

export const removeOpenAiKey = action({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Authentication required.');
		const object = await readVaultObject(await credentialName(identity.subject));
		if (!object) return null;
		const response = await fetch(
			`${WORKOS_VAULT_ORIGIN}/vault/v1/kv/${encodeURIComponent(object.id)}`,
			{ method: 'DELETE', headers: workosHeaders() }
		);
		if (!response.ok && response.status !== 404) {
			throw new Error('Couldn’t remove the OpenAI key from WorkOS Vault.');
		}
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
		if (!ownsActiveRunClaim(run, args.claimId, Date.now())) throw new Error(RUN_NO_LONGER_ACTIVE);
		if ((run.completionProvider ?? 'spikonado') !== 'openai') {
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
		const object = await readVaultObject(await credentialName(userId));
		if (!object) throw new Error('OpenAI is no longer configured. Add an API key in Settings.');
		await ctx.runQuery(internal.providerCredentials.authorizeOpenAiCredential, args);
		return { apiKey: object.value };
	}
});
