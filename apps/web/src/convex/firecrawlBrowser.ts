'use node';

import { z } from 'zod';
import { ConvexError, v } from 'convex/values';
import { internal } from '@convex/_generated/api';
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
const SAVING_IN_USE_ERROR =
	"Saving can't be enforced currently as the main browser session is in use by another agent. Ask the user whether they want the cookies and login state saved for future use. If yes, they have to stop the other agent and its browser session.";
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
	constructor(
		readonly status: number,
		detail?: string,
		retryAfterSeconds?: number
	) {
		super(
			[
				`Firecrawl request failed (HTTP ${status}).`,
				detail || (status === 429 ? 'A request-rate or concurrency limit was reached.' : ''),
				retryAfterSeconds === undefined
					? ''
					: `Wait at least ${retryAfterSeconds} seconds before retrying.`
			]
				.filter(Boolean)
				.join(' ')
		);
	}
}

function retryAfterSeconds(response: Response): number | undefined {
	const value = response.headers.get('retry-after')?.trim();
	if (!value) return undefined;
	const numeric = Number(value);
	const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(value) - Date.now()) / 1_000;
	return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
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
	const key = env.FIRECRAWL_BROWSER_API_KEY?.trim();
	if (!key) throw new Error('FIRECRAWL_BROWSER_API_KEY is not configured.');
	const response = await fetch(`https://api.firecrawl.dev/v2/interact${path}`, {
		method,
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!response.ok) {
		const retryAfter = retryAfterSeconds(response);
		const data = await readJson(response, 'reject').catch(() => null);
		throw new FirecrawlError(
			response.status,
			data?.error?.trim().slice(0, MAX_RESULT_CHARS),
			retryAfter
		);
	}
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

async function destroy(ctx: ActionCtx, sessionId: string): Promise<void> {
	try {
		await provider('DELETE', `/${encodeURIComponent(sessionId)}`);
	} catch (error) {
		if (!isGone(error)) throw error;
	}
	await ctx.runMutation(internal.browserCapacity.releaseSession, { sessionId });
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
	const help = words[0] === 'help';
	if (!words.length || words[0].startsWith('-')) {
		throw new Error('Provide an agent-browser command without global options.');
	}
	if (MANAGED_SUBCOMMANDS.has(words[0]) || words.some((word) => MANAGED_FLAG.test(word))) {
		throw new Error('Browser session and profile management are handled by Sprocket.');
	}
	if (words[0] === 'screenshot') throw new Error('Use browser_screenshot to receive an image.');
	if (help) words[0] = '--help';
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
	return result.stdout || result.result || undefined;
}

type BrowserArgs = {
	runId: Id<'runs'>;
	claimId: string;
	userId: string;
	threadId: Id<'threadRecords'>;
};

async function createSession(ctx: ActionCtx, profileName: string, saveChanges: boolean) {
	if (!env.FIRECRAWL_BROWSER_API_KEY?.trim())
		throw new Error('FIRECRAWL_BROWSER_API_KEY is not configured.');
	const reservationId = crypto.randomUUID();
	await ctx.runMutation(internal.browserCapacity.reserve, {
		reservationId,
		expiresAt: Date.now() + SESSION_TTL_SECONDS * 1_000 + FETCH_TIMEOUT_MS
	});
	try {
		const data = await provider('POST', '', {
			ttl: SESSION_TTL_SECONDS,
			activityTtl: ACTIVITY_TTL_SECONDS,
			recordSession: false,
			profile: { name: profileName, saveChanges }
		});
		const { id } = z.object({ id: z.string().min(1) }).parse(data);
		await ctx.runMutation(internal.browserCapacity.attach, { reservationId, sessionId: id });
		return data;
	} catch (error) {
		if (
			error instanceof FirecrawlError &&
			[400, 401, 402, 403, 404, 409, 422, 429].includes(error.status)
		) {
			await ctx.runMutation(internal.browserCapacity.releaseReservation, { reservationId });
		}
		throw error;
	}
}

async function execute(
	ctx: ActionCtx,
	args: BrowserArgs,
	code: string,
	language: 'bash' | 'node',
	enforceSaving = false
) {
	const operationId = crypto.randomUUID();
	const session = await ctx.runMutation(internal.browserSessions.acquire, {
		threadId: args.threadId,
		userId: args.userId,
		runId: args.runId,
		claimId: args.claimId,
		operationId,
		enforce_saving: enforceSaving
	});
	let sessionId = session.sessionId;
	let createdId: string | undefined;
	const startedAt = sessionId ? Date.now() : session.startedAt;
	const creationDeadline = startedAt + SESSION_TTL_SECONDS * 1_000;
	let destroyed = false;
	let executing = false;
	try {
		if (!sessionId || (enforceSaving && !session.saveChanges)) {
			let saveChanges = enforceSaving || session.saveChanges;
			let data: unknown;
			try {
				data = await createSession(ctx, session.profileName, saveChanges);
			} catch (error) {
				if (!(error instanceof FirecrawlError && error.status === 409 && saveChanges)) {
					throw error;
				}
				if (enforceSaving) throw new ConvexError(SAVING_IN_USE_ERROR);
				await ctx.runMutation(internal.browserSessions.beforeExecute, {
					id: session._id,
					operationId,
					runId: args.runId,
					claimId: args.claimId
				});
				saveChanges = false;
				data = await createSession(ctx, session.profileName, saveChanges);
			}
			createdId = z.object({ id: z.string().min(1) }).parse(data).id;
			const created = createdSchema.parse(data);
			const expiresAt = Date.parse(created.expiresAt ?? '');
			const attached = await ctx.runMutation(internal.browserSessions.attach, {
				id: session._id,
				operationId,
				claimId: args.claimId,
				sessionId: created.id,
				saveChanges,
				startedAt,
				expiresAt: Number.isFinite(expiresAt)
					? Math.min(expiresAt, creationDeadline)
					: creationDeadline,
				liveViewUrl: optionalHttpUrl(created.liveViewUrl),
				interactiveLiveViewUrl: optionalHttpUrl(created.interactiveLiveViewUrl)
			});
			createdId = undefined;
			if (!attached) {
				throw new Error(
					'The browser session or saving preference changed before creation completed. No action ran. Retry.'
				);
			}
			sessionId = created.id;
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
			await ctx.runMutation(internal.browserSessions.discardUnattached, {
				id: session._id,
				sessionId: createdId,
				expiresAt: creationDeadline
			});
		}
		if (executing && isGone(error)) {
			await ctx.runMutation(internal.browserCapacity.releaseSession, { sessionId: sessionId! });
			destroyed = true;
			throw new ConvexError(
				'browser_expired: The browser session ended. No action was replayed. Retry to open a new session from the saved profile. Unsaved browser state may be lost.'
			);
		}
		if (executing && error instanceof FirecrawlError && error.status === 429) {
			throw new ConvexError(`${error.message} The command did not run.`);
		}
		if (executing) {
			await ctx.runMutation(internal.browserSessions.quarantine, {
				id: session._id,
				operationId
			});
			throw new ConvexError(
				'The provider did not confirm whether the command completed. The session is closing. Do not repeat purchases, messages, or other actions without checking their outcome first.'
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

export async function interact(
	ctx: ActionCtx,
	args: BrowserArgs & { command: string; enforce_saving?: boolean }
) {
	try {
		const result = await execute(ctx, args, commandCode(args.command), 'bash', args.enforce_saving);
		return clip([outputText(result), result.stderr].filter(Boolean).join('\n'));
	} catch (error) {
		toolError(error);
	}
}

export async function screenshot(ctx: ActionCtx, args: BrowserArgs) {
	try {
		// Firecrawl drops console.log output and can truncate stdout unless the write finishes.
		const result = await execute(
			ctx,
			args,
			"var image = await page.screenshot({ type: 'png' }); await new Promise((resolve, reject) => process.stdout.write(JSON.stringify({ byteLength: image.length, url: page.url(), dataBase64: image.length <= 600000 ? image.toString('base64') : '' }), error => error ? reject(error) : resolve()));",
			'node'
		);
		const output = outputText(result);
		if (!output?.trim()) throw new Error('Firecrawl returned empty screenshot output.');
		let decoded: unknown;
		try {
			decoded = JSON.parse(output);
		} catch {
			throw new Error('Firecrawl returned malformed screenshot JSON.');
		}
		const parsed = z
			.object({
				byteLength: z.number().int().nonnegative(),
				url: z.string().max(MAX_RESULT_CHARS),
				dataBase64: z.string().max(800_000)
			})
			.safeParse(decoded);
		if (!parsed.success) throw new Error('Firecrawl returned an invalid screenshot.');
		const image = parsed.data;
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

export const closeDetached = internalAction({
	args: { sessionId: v.string(), expiresAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		try {
			await destroy(ctx, args.sessionId);
		} catch {
			if (Date.now() < args.expiresAt) {
				await ctx.scheduler.runAfter(60_000, internal.firecrawlBrowser.closeDetached, args);
			}
		}
		return null;
	}
});

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
			if (session.sessionId) await destroy(ctx, session.sessionId);
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
		await ctx.runMutation(internal.browserCapacity.expire, {});
		if (!env.FIRECRAWL_BROWSER_API_KEY?.trim()) return null;
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
		for (const slot of await ctx.runQuery(internal.browserCapacity.active, {})) {
			if (slot.sessionId && destroyed.has(slot.sessionId)) {
				await ctx.runMutation(internal.browserCapacity.releaseSession, {
					sessionId: slot.sessionId
				});
			}
		}
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
