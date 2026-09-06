'use node';

import { z } from 'zod';
import { ConvexError, v } from 'convex/values';
import { api, internal } from '@convex/_generated/api';
import { env, internalAction, type ActionCtx } from '@convex/_generated/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import type { PaginationResult } from 'convex/server';
import { toAgentToolConvexError } from '@convex/lib/agentErrors';

const SESSION_TTL_SECONDS = 3600;
const ACTIVITY_TTL_SECONDS = 450;
const EXECUTE_TIMEOUT_SECONDS = 120;
const FETCH_TIMEOUT_MS = 140_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_RESULT_CHARS = 8_000;
const MAX_COMMAND_CHARS = 100_000;
const MAX_SCREENSHOT_BYTES = 600_000;
const GONE_STATUSES = new Set([404, 410]);
const MANAGED_SUBCOMMANDS = new Set(['close', 'connect', 'state', 'cookies', 'session']);
const MANAGED_FLAG = /^(--(?:cdp|session|profile|state|session-name))(=|$)/;

const envelopeSchema = z.object({
	success: z.boolean(),
	error: z.string().nullish()
});
const createdSchema = envelopeSchema.extend({
	id: z.string().min(1),
	expiresAt: z.string().nullish(),
	liveViewUrl: z.string().nullish(),
	interactiveLiveViewUrl: z.string().nullish()
});
const executionSchema = envelopeSchema.extend({
	stdout: z.string().nullish(),
	result: z.string().nullish(),
	stderr: z.string().nullish(),
	exitCode: z.number().nullish(),
	killed: z.boolean().nullish()
});
const sessionsSchema = envelopeSchema.extend({
	sessions: z.array(z.object({ id: z.string().min(1), status: z.string() }))
});

class FirecrawlError extends Error {
	constructor(readonly status: number) {
		super(`Firecrawl request failed (HTTP ${status}).`);
	}
}

function isGone<T>(error: T): error is T & FirecrawlError {
	return error instanceof FirecrawlError && GONE_STATUSES.has(error.status);
}

function optionalHttpUrl(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	const parsed = z.url().safeParse(value);
	if (!parsed.success) return undefined;
	const protocol = new URL(parsed.data).protocol;
	return protocol === 'http:' || protocol === 'https:' ? parsed.data : undefined;
}

function clip(text: string) {
	return { text: text.slice(0, MAX_RESULT_CHARS), truncated: text.length > MAX_RESULT_CHARS };
}

function toolError<T>(error: T): never {
	throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
}

async function readJson(
	response: Response,
	empty: 'success' | 'reject'
): Promise<z.infer<typeof providerResponseSchema>> {
	const announced = Number(response.headers.get('content-length'));
	if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
		await response.body?.cancel();
		throw new Error('Firecrawl response exceeded the size limit.');
	}
	if (!response.body) {
		if (empty === 'success' || response.status === 204) return { success: true };
		throw new Error('Firecrawl response was empty.');
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error('Firecrawl response exceeded the size limit.');
		}
		chunks.push(value);
	}
	if (size === 0) {
		if (empty === 'success') return { success: true };
		throw new Error('Firecrawl response was empty.');
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return providerResponseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		throw new Error('Firecrawl response was not valid JSON.');
	}
}

const providerResponseSchema = z
	.object({ success: z.boolean(), error: z.string().nullish() })
	.passthrough();
type RequestBody = {
	ttl?: number;
	activityTtl?: number;
	recordSession?: boolean;
	profile?: { name: string; saveChanges: boolean };
	code?: string;
	language?: 'bash' | 'node';
	timeout?: number;
};

async function request(
	method: string,
	path: string,
	body?: RequestBody
): Promise<z.infer<typeof providerResponseSchema>> {
	const key = env.FIRECRAWL_API_KEY?.trim();
	if (!key) throw new Error('FIRECRAWL_API_KEY is not configured.');
	const response = await fetch(`https://api.firecrawl.dev/v2/interact${path}`, {
		method,
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!response.ok) throw new FirecrawlError(response.status);
	return readJson(response, method === 'DELETE' ? 'success' : 'reject');
}

async function provider(
	method: string,
	path: string,
	body?: RequestBody
): Promise<z.infer<typeof providerResponseSchema>> {
	const data = await request(method, path, body);
	const envelope = envelopeSchema.parse(data);
	if (!envelope.success) throw new Error(envelope.error || 'Firecrawl request failed.');
	return data;
}

async function destroy(sessionId: string): Promise<void> {
	try {
		await provider('DELETE', `/${encodeURIComponent(sessionId)}`);
	} catch (error) {
		if (!isGone(error)) throw error;
	}
}

function tokenizeCommand(command: string): string[] {
	if (command.length > MAX_COMMAND_CHARS || /[\0\r\n]/.test(command)) {
		throw new Error('Browser commands must be a single line, at most 100,000 characters.');
	}
	const words: string[] = [];
	let word = '';
	let quote = '';
	let escaped = false;
	let started = false;
	for (const char of command) {
		if (escaped) {
			word += char;
			escaped = false;
			continue;
		}
		if (char === '\\' && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = '';
			else word += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) words.push(word);
			word = '';
			started = false;
			continue;
		}
		word += char;
		started = true;
	}
	if (quote || escaped) throw new Error('Browser command has an incomplete quote or escape.');
	if (started) words.push(word);
	return words;
}

function commandCode(command: string): string {
	const words = tokenizeCommand(command);
	if (words[0] === 'agent-browser') words.shift();
	if (!words.length || words[0].startsWith('-')) {
		throw new Error('Provide an agent-browser command without global options.');
	}
	if (MANAGED_SUBCOMMANDS.has(words[0]) || words.some((word) => MANAGED_FLAG.test(word))) {
		throw new Error('Browser session and profile management are handled by Sprocket.');
	}
	if (words[0] === 'screenshot') throw new Error('Use browser_screenshot to receive an image.');
	const code = ['agent-browser', ...words]
		.map((word) => `'${word.replaceAll("'", "'\\''")}'`)
		.join(' ');
	if (code.length > MAX_COMMAND_CHARS) {
		throw new Error('Browser commands must be a single line, at most 100,000 characters.');
	}
	return code;
}

function commandFailure(result: z.infer<typeof executionSchema>): string | undefined {
	if (result.killed || result.error || (result.exitCode != null && result.exitCode !== 0)) {
		return result.stderr || result.error || 'Browser command failed or timed out.';
	}
	return undefined;
}

function outputText(result: z.infer<typeof executionSchema>): string | undefined {
	return result.stdout ?? result.result ?? undefined;
}

type BrowserArgs = {
	runId: Id<'runs'>;
	claimId: string;
	executionSecret: string;
	disable_saving?: boolean;
};

async function execute(ctx: ActionCtx, args: BrowserArgs, code: string, language: 'bash' | 'node') {
	const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
		runId: args.runId,
		executionSecret: args.executionSecret
	});
	const operationId = crypto.randomUUID();
	const session = await ctx.runMutation(internal.browserSessions.acquire, {
		threadId: actor.threadId,
		userId: actor.userId,
		runId: args.runId,
		claimId: args.claimId,
		operationId,
		disable_saving: args.disable_saving
	});
	let sessionId = session.sessionId;
	let createdId: string | undefined;
	let destroyed = false;
	let executing = false;
	try {
		if (!sessionId) {
			let data: unknown;
			try {
				data = await provider('POST', '', {
					ttl: SESSION_TTL_SECONDS,
					activityTtl: ACTIVITY_TTL_SECONDS,
					recordSession: false,
					profile: { name: session.profileName, saveChanges: session.saveChanges }
				});
			} catch (error) {
				if (error instanceof FirecrawlError && error.status === 409) {
					throw new ConvexError(
						'profile_in_use: Another conversation is saving to your browser profile. No browser action ran. Retry with disable_saving: true to use the last saved profile without saving changes, or wait for the other session to close.'
					);
				}
				throw error;
			}
			createdId = z.object({ id: z.string().min(1) }).parse(data).id;
			const created = createdSchema.parse(data);
			sessionId = created.id;
			const expiresAt = Date.parse(created.expiresAt ?? '');
			const attached = await ctx.runMutation(internal.browserSessions.attach, {
				id: session._id,
				operationId,
				sessionId,
				expiresAt: Number.isFinite(expiresAt)
					? Math.min(expiresAt, session.expiresAt)
					: session.expiresAt,
				liveViewUrl: optionalHttpUrl(created.liveViewUrl),
				interactiveLiveViewUrl: optionalHttpUrl(created.interactiveLiveViewUrl)
			});
			if (!attached) {
				await destroy(sessionId);
				destroyed = true;
				createdId = undefined;
				throw new Error(
					'The browser was reset or its creation lease expired. No action ran. Retry.'
				);
			}
			createdId = undefined;
		}
		await ctx.runMutation(internal.browserSessions.beforeExecute, {
			id: session._id,
			operationId,
			runId: args.runId,
			claimId: args.claimId
		});
		executing = true;
		const parsed = executionSchema.safeParse(
			await request('POST', `/${encodeURIComponent(sessionId)}/execute`, {
				code,
				language,
				timeout: EXECUTE_TIMEOUT_SECONDS
			})
		);
		if (!parsed.success) {
			throw new Error('Firecrawl execute response was incomplete.');
		}
		const failure = commandFailure(parsed.data);
		if (failure) {
			executing = false;
			throw new Error(clip(failure).text);
		}
		if (!parsed.data.success) {
			throw new Error('Firecrawl execute response was incomplete.');
		}
		executing = false;
		return parsed.data;
	} catch (error) {
		if (createdId) {
			await destroy(createdId);
			destroyed = true;
		}
		if (isGone(error)) {
			destroyed = true;
			throw new ConvexError(
				'browser_expired: The browser session ended. No action was replayed. Retry to open a new session from the saved profile. Unsaved browser state may be lost.'
			);
		}
		if (executing) {
			await ctx.runMutation(internal.browserSessions.quarantine, {
				id: session._id,
				operationId
			});
			throw new ConvexError(
				'browser_outcome_unknown: The provider did not confirm whether the command completed. The session is closing. Do not repeat purchases, messages, or other actions without checking their outcome first.'
			);
		}
		throw error;
	} finally {
		await ctx.runMutation(internal.browserSessions.release, {
			id: session._id,
			operationId,
			destroyed
		});
	}
}

export async function interact(ctx: ActionCtx, args: BrowserArgs & { command: string }) {
	try {
		const result = await execute(ctx, args, commandCode(args.command), 'bash');
		return clip([outputText(result), result.stderr].filter(Boolean).join('\n'));
	} catch (error) {
		toolError(error);
	}
}

export async function screenshot(ctx: ActionCtx, args: BrowserArgs) {
	try {
		const result = await execute(
			ctx,
			args,
			"var image = await page.screenshot({ type: 'png' }); console.log(JSON.stringify({ byteLength: image.length, url: page.url(), dataBase64: image.length <= 600000 ? image.toString('base64') : '' }));",
			'node'
		);
		const image = z
			.object({
				byteLength: z.number().int().nonnegative(),
				url: z.string().max(MAX_RESULT_CHARS),
				dataBase64: z.string().max(800_000)
			})
			.parse(JSON.parse(outputText(result) ?? ''));
		if (image.byteLength <= MAX_SCREENSHOT_BYTES) {
			const bytes = Buffer.from(image.dataBase64, 'base64');
			if (
				bytes.length !== image.byteLength ||
				bytes.toString('base64') !== image.dataBase64 ||
				bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
			) {
				throw new Error('Firecrawl returned an invalid screenshot.');
			}
		}
		return {
			...image,
			mediaType: 'image/png' as const,
			truncated: image.byteLength > MAX_SCREENSHOT_BYTES
		};
	} catch (error) {
		toolError(error);
	}
}

export const close = internalAction({
	args: { id: v.id('browserSessions') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const operationId = crypto.randomUUID();
		const session = await ctx.runMutation(internal.browserSessions.claimClose, {
			id,
			operationId
		});
		if (!session) return null;
		try {
			if (session.sessionId) await destroy(session.sessionId);
			await ctx.runMutation(internal.browserSessions.release, {
				id,
				operationId,
				destroyed: true
			});
		} catch {
			await ctx.runMutation(internal.browserSessions.release, { id, operationId });
			await ctx.scheduler.runAfter(60_000, internal.firecrawlBrowser.close, { id });
		}
		return null;
	}
});

export const reconcile = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		if (!env.FIRECRAWL_API_KEY?.trim()) return null;
		const before = Date.now();
		const listed = sessionsSchema.safeParse(await provider('GET', '?status=destroyed'));
		if (!listed.success) {
			throw new Error('Firecrawl session list was missing or malformed. Reconcile skipped.');
		}
		const destroyed = new Set(
			listed.data.sessions
				.filter((session) => session.status === 'destroyed')
				.map((session) => session.id)
		);
		let cursor: string | null = null;
		for (;;) {
			const batch: PaginationResult<Doc<'browserSessions'>> = await ctx.runQuery(
				internal.browserSessions.list,
				{ paginationOpts: { cursor, numItems: 100 } }
			);
			await ctx.runMutation(internal.browserSessions.reconcile, {
				ids: batch.page
					.filter((session) => session.sessionId && destroyed.has(session.sessionId))
					.map((session) => session._id),
				before
			});
			if (batch.isDone) break;
			cursor = batch.continueCursor;
		}
		return null;
	}
});
