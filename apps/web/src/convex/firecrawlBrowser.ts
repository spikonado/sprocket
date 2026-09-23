'use node';

import { BlockList, isIP } from 'node:net';
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
const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_RETRY_BUDGET_MS = 120_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_RESULT_CHARS = 8_000;
const MAX_SCREENSHOT_BYTES = 600_000;
const SAVING_IN_USE_ERROR =
	"Saving can't be enforced currently as the main browser session is in use by another agent. Ask the user whether they want the cookies and login state saved for future use. If yes, they have to stop the other agent and its browser session.";
const GONE_STATUSES = new Set([404, 410]);
const CHROME_WRAPPER_DEV_FD_FAILURE =
	/\/usr\/bin\/google-chrome-stable: line \d+: \/dev\/fd\/\d+: No such file or directory/;
const CLOUD_BROWSER_LOCAL_URL_ERROR =
	"browser_interact runs in a browser in the cloud, not a local browser. This URL points to localhost or a private network that the cloud browser cannot reach on the user's machine. Do not retry it. Use a publicly reachable URL or ask the user to expose the local server through a tunnel.";
const LOCAL_ADDRESSES = new BlockList();

for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.168.0.0', 16]
] as const) {
	LOCAL_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
	['::', 128],
	['::1', 128],
	['fc00::', 7],
	['fe80::', 10]
] as const) {
	LOCAL_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

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

class BrowserWorkerStartupError extends Error {}

class RetryAbortedBeforeRequest extends Error {
	constructor(readonly reason: Error) {
		super('Browser request retry aborted before sending.');
	}
}

function retryAfterSeconds(response: Response): number | undefined {
	const value = response.headers.get('retry-after')?.trim();
	if (!value) return undefined;
	const numeric = Number(value);
	const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(value) - Date.now()) / 1_000;
	return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

function retryAfterDetailSeconds(detail: string | null | undefined): number | undefined {
	const seconds = Number(detail?.match(/\bretry after\s+(\d+(?:\.\d+)?)s\b/i)?.[1]);
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
	body?: RequestBody,
	beforeRateLimitRetry?: () => Promise<void>
): Promise<z.infer<typeof providerResponseSchema>> {
	const key = env.FIRECRAWL_BROWSER_API_KEY?.trim();
	if (!key) throw new Error('FIRECRAWL_BROWSER_API_KEY is not configured.');
	let retries = 0;
	let retryWaitMs = 0;
	for (;;) {
		const response = await fetch(`https://api.firecrawl.dev/v2/interact${path}`, {
			method,
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (response.ok) return readJson(response, method === 'DELETE' ? 'success' : 'reject');
		const headerDelay = retryAfterSeconds(response);
		const data = await readJson(response, 'reject').catch(() => null);
		const detail = data?.error?.trim().slice(0, MAX_RESULT_CHARS);
		const delaySeconds = headerDelay ?? retryAfterDetailSeconds(detail);
		const delayMs = delaySeconds === undefined ? undefined : delaySeconds * 1_000;
		if (
			response.status !== 429 ||
			delayMs === undefined ||
			retries >= MAX_RATE_LIMIT_RETRIES ||
			retryWaitMs + delayMs > RATE_LIMIT_RETRY_BUDGET_MS
		) {
			throw new FirecrawlError(response.status, detail, headerDelay);
		}
		retries += 1;
		retryWaitMs += delayMs;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		try {
			await beforeRateLimitRetry?.();
		} catch (error) {
			throw new RetryAbortedBeforeRequest(
				error instanceof Error ? error : new Error(String(error))
			);
		}
	}
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

function commandFailure(result: z.infer<typeof executionSchema>): string | undefined {
	if (result.killed || result.error || (result.exitCode != null && result.exitCode !== 0)) {
		return result.stderr || result.error || 'Browser command failed or timed out.';
	}
	return undefined;
}

function isBrowserWorkerStartupFailure(result: z.infer<typeof executionSchema>): boolean {
	return [result.stderr, result.error].some(
		(message) => message && CHROME_WRAPPER_DEV_FD_FAILURE.test(message)
	);
}

function isLocalBrowserUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value.includes('://') ? value : `http://${value}`);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	const hostname = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '');
	if (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		hostname === 'host.docker.internal' ||
		hostname === 'gateway.docker.internal'
	) {
		return true;
	}
	const family = isIP(hostname);
	return family !== 0 && LOCAL_ADDRESSES.check(hostname, family === 4 ? 'ipv4' : 'ipv6');
}

function shellCommands(value: string): string[][] {
	const commands: string[][] = [];
	let tokens: string[] = [];
	let token = '';
	let tokenStarted = false;
	let quote: "'" | '"' | undefined;
	let comment = false;

	const endToken = () => {
		if (!tokenStarted) return;
		tokens.push(token);
		token = '';
		tokenStarted = false;
	};
	const endCommand = () => {
		endToken();
		if (tokens.length > 0) commands.push(tokens);
		tokens = [];
	};

	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (comment) {
			if (character === '\n') {
				comment = false;
				endCommand();
			}
			continue;
		}
		if (quote) {
			if (character === quote) {
				quote = undefined;
			} else if (character === '\\' && quote === '"' && index + 1 < value.length) {
				const escaped = value[++index];
				if (escaped !== '\n') token += escaped;
			} else {
				token += character;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			tokenStarted = true;
		} else if (character === '\\' && index + 1 < value.length) {
			const escaped = value[++index];
			if (escaped !== '\n') {
				token += escaped;
				tokenStarted = true;
			}
		} else if (character === '#' && !tokenStarted) {
			comment = true;
		} else if (character === '\n' || ';|&()'.includes(character)) {
			endCommand();
		} else if (/\s/.test(character)) {
			endToken();
		} else {
			token += character;
			tokenStarted = true;
		}
	}
	endCommand();
	return commands;
}

function opensLocalBrowserUrl(command: string): boolean {
	return shellCommands(command).some((tokens) => {
		if (tokens[0] !== 'agent-browser') return false;
		const commandIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith('-'));
		return tokens[commandIndex] === 'open' && isLocalBrowserUrl(tokens[commandIndex + 1] || '');
	});
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
	const reservation = {
		reservationId,
		expiresAt: Date.now() + SESSION_TTL_SECONDS * 1_000 + FETCH_TIMEOUT_MS
	};
	const reserved = await ctx.runMutation(internal.browserCapacity.reserve, {
		...reservation,
		returnIfFull: true
	});
	if (!reserved) {
		await reconcileProviderSessions(ctx).catch(() => undefined);
		await ctx.runMutation(internal.browserCapacity.reserve, reservation);
	}
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
	const needsProviderReconciliation = await ctx.runQuery(
		internal.browserSessions.needsProviderReconciliation,
		{
			threadId: args.threadId,
			userId: args.userId,
			activeAfter: Date.now() - ACTIVITY_TTL_SECONDS * 1_000
		}
	);
	if (needsProviderReconciliation) {
		await reconcileProviderSessions(ctx).catch(() => undefined);
	}
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
	const validateExecution = async () => {
		await ctx.runMutation(internal.browserSessions.beforeExecute, {
			id: session._id,
			operationId,
			runId: args.runId,
			claimId: args.claimId
		});
	};
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
		await validateExecution();
		executing = true;
		const parsed = executionSchema.safeParse(
			await request(
				'POST',
				`/${encodeURIComponent(sessionId)}/execute`,
				{
					code,
					language,
					timeout: EXECUTE_TIMEOUT_SECONDS
				},
				validateExecution
			)
		);
		if (!parsed.success) {
			throw new Error('Firecrawl execute response was incomplete.');
		}
		const failure = commandFailure(parsed.data);
		if (failure) {
			executing = false;
			if (isBrowserWorkerStartupFailure(parsed.data)) {
				try {
					await destroy(ctx, sessionId!);
					destroyed = true;
				} catch {
					await ctx.runMutation(internal.browserSessions.quarantine, {
						id: session._id,
						operationId
					});
					throw new ConvexError(
						'The browser worker could not start Chrome and its session is closing. Retry shortly.'
					);
				}
				throw new BrowserWorkerStartupError(
					'The browser worker could not start Chrome. Its broken session was closed.'
				);
			}
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
		if (error instanceof RetryAbortedBeforeRequest) throw error.reason;
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
	if (opensLocalBrowserUrl(args.command)) toolError(new Error(CLOUD_BROWSER_LOCAL_URL_ERROR));
	let replacementAttempted = false;
	for (;;) {
		try {
			const result = await execute(ctx, args, args.command, 'bash', args.enforce_saving);
			return clip([outputText(result), result.stderr].filter(Boolean).join('\n'));
		} catch (error) {
			if (error instanceof BrowserWorkerStartupError && !replacementAttempted) {
				replacementAttempted = true;
				continue;
			}
			if (error instanceof BrowserWorkerStartupError) {
				toolError(
					new Error('The replacement browser worker also failed to start Chrome. Retry later.')
				);
			}
			toolError(error);
		}
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

async function reconcileProviderSessions(ctx: ActionCtx) {
	if (!env.FIRECRAWL_BROWSER_API_KEY?.trim()) return;
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
	if (destroyed.size === 0) return;
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
}

export const reconcile = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await reconcileProviderSessions(ctx);
		return null;
	}
});
