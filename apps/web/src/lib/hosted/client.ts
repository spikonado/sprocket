import { api } from '$convex/_generated/api';
import type { Id } from '$convex/_generated/dataModel';
import {
	HOSTED_THREAD_LIST_MAX_PAGES,
	HOSTED_THREAD_PAGE_SIZE
} from '$convex/lib/hostedThreadList';
import { HOSTED_TRANSCRIPT_DETAIL_CHUNK_SIZE } from '$convex/lib/hostedTranscript';
import { MACHINE_REQUEST_TTL_MS } from '$convex/lib/machineRequests';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import type { Validator } from 'convex/values';
import { parse } from 'convex-helpers/validators';
import {
	MACHINE_REQUEST_DISCONNECT_MS,
	MACHINE_REQUEST_TIMEOUT,
	MACHINE_REQUEST_WAIT_MS,
	machineRequestIdForRun,
	runAgentCommand,
	vAgentRunStart,
	vFilesystemBrowseResult,
	vProjectAttachment,
	vProjectAttachmentList,
	vWorkspacePathResolution,
	vWorkspaceSkillsResult,
	type MachineCommand
} from '$lib/hosted/machineRequests';
import { collectThreadSnapshot, type HostedThreadListPage } from '$lib/hosted/threads';
import type {
	AgentRunRequest,
	AgentRunStart,
	DesktopApi,
	FilesystemBrowseResult,
	LiveCompletionWatchEvent,
	LocalTranscriptPage,
	LocalTranscriptPart,
	ProjectAttachment,
	ThreadCacheSnapshot,
	ThreadCacheUserRequest,
	ThreadCacheWatchEvent,
	TranscriptPageRequest,
	TranscriptScopeRequest,
	WorkspacePathResolution,
	WorkspaceSkillsResult
} from '$lib/types/sprocket';

export type HostedConnectionState = {
	isWebSocketConnected: boolean;
	hasEverConnected?: boolean;
};

export type HostedConvexClient = {
	query<Query extends FunctionReference<'query'>>(
		query: Query,
		args: FunctionArgs<Query>
	): Promise<FunctionReturnType<Query>>;
	mutation<Mut extends FunctionReference<'mutation'>>(
		mutation: Mut,
		args: FunctionArgs<Mut>
	): Promise<FunctionReturnType<Mut>>;
	onUpdate<Query extends FunctionReference<'query'>>(
		query: Query,
		args: FunctionArgs<Query>,
		callback: (result: FunctionReturnType<Query>) => void,
		onError?: (error: Error) => void
	): () => void;
	subscribeToConnectionState?(callback: (state: HostedConnectionState) => void): () => void;
};

export {
	HOSTED_THREAD_PAGE_SIZE,
	HOSTED_THREAD_LIST_MAX_PAGES
} from '$convex/lib/hostedThreadList';
export { snapshotThreadsFromPage, collectThreadSnapshot } from '$lib/hosted/threads';
export {
	MACHINE_REQUEST_DISCONNECT_MS,
	MACHINE_REQUEST_TIMEOUT,
	MACHINE_REQUEST_WAIT_MS,
	machineRequestIdForRun,
	runAgentCommand
} from '$lib/hosted/machineRequests';

const NO_MACHINE_COMMAND = 'Select an online machine to run this.';
const RUN_BOUND_TO_OTHER_MACHINE = 'This run was already sent to another machine.';

type ListPageArgs = FunctionArgs<typeof api.hostedThreads.listPage>;
type ListPageResult = FunctionReturnType<typeof api.hostedThreads.listPage>;
type SyncTimestamp = { current: number | null };

function requireMachineId(machineId: string | null): string {
	if (!machineId) {
		throw new Error(NO_MACHINE_COMMAND);
	}
	return machineId;
}

function listPageArgs(cursor: string | null, selectedThreadId?: Id<'threadRecords'>): ListPageArgs {
	const args: ListPageArgs = {
		paginationOpts: { numItems: HOSTED_THREAD_PAGE_SIZE, cursor }
	};
	if (selectedThreadId !== undefined) {
		args.selectedThreadId = selectedThreadId;
	}
	return args;
}

function transcriptPageArgs(
	request: TranscriptPageRequest
): FunctionArgs<typeof api.hostedThreads.transcriptPage> {
	const args: FunctionArgs<typeof api.hostedThreads.transcriptPage> = {
		threadId: request.threadId
	};
	if (request.before !== undefined) args.before = request.before;
	if (request.limit !== undefined) args.limit = request.limit;
	return args;
}

function cursorKey(cursor: string | null): string {
	return cursor ?? '';
}

function watchQuery<Query extends FunctionReference<'query'>>(
	convex: HostedConvexClient,
	query: Query,
	args: FunctionArgs<Query>,
	signal: AbortSignal,
	onValue: (value: FunctionReturnType<Query>) => void | 'stop'
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const querySubscription = {
			unsubscribe() {}
		};
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			querySubscription.unsubscribe();
			action();
		};
		const onAbort = () => finish(() => resolve());
		if (signal.aborted) {
			resolve();
			return;
		}
		signal.addEventListener('abort', onAbort);
		querySubscription.unsubscribe = convex.onUpdate(
			query,
			args,
			(value) => {
				if (settled) return;
				try {
					if (onValue(value) === 'stop') {
						finish(() => resolve());
					}
				} catch (error) {
					finish(() => reject(error instanceof Error ? error : new Error(String(error))));
				}
			},
			(error) => {
				if (signal.aborted) {
					finish(() => resolve());
					return;
				}
				finish(() => reject(error));
			}
		);
		if (settled) {
			querySubscription.unsubscribe();
		}
	});
}

function watchThreadListPages(
	convex: HostedConvexClient,
	request: ThreadCacheUserRequest,
	signal: AbortSignal,
	onEvent: (event: ThreadCacheWatchEvent) => void,
	lastSyncedAt: SyncTimestamp
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		let settled = false;
		const pageCursors: (string | null)[] = [];
		const subscriptions = new Map<string, () => void>();
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			for (const unsubscribe of subscriptions.values()) {
				unsubscribe();
			}
			subscriptions.clear();
			pageCursors.length = 0;
			action();
		};
		const onAbort = () => finish(() => resolve());
		signal.addEventListener('abort', onAbort);

		const invalidate = () => {
			if (settled) return;
			lastSyncedAt.current = Date.now();
			onEvent({ status: 'live', lastSyncedAt: lastSyncedAt.current });
		};

		const disposeAfter = (index: number) => {
			for (let i = pageCursors.length - 1; i > index; i -= 1) {
				const key = cursorKey(pageCursors[i] ?? null);
				subscriptions.get(key)?.();
				subscriptions.delete(key);
				pageCursors.pop();
			}
		};

		const subscribePage = (cursor: string | null) => {
			if (settled) return;
			if (pageCursors.length >= HOSTED_THREAD_LIST_MAX_PAGES) {
				finish(() => reject(new Error('Thread history exceeds the supported snapshot size.')));
				return;
			}
			const key = cursorKey(cursor);
			if (subscriptions.has(key)) return;
			pageCursors.push(cursor);
			const subscription = {
				unsubscribe() {}
			};
			subscriptions.set(key, () => subscription.unsubscribe());
			const selectedThreadId = cursor === null ? request.selectedThreadId : undefined;
			subscription.unsubscribe = convex.onUpdate(
				api.hostedThreads.listPage,
				listPageArgs(cursor, selectedThreadId),
				(page: ListPageResult) => {
					if (settled) return;
					const foreign =
						page.page.some((thread) => thread.userId !== request.userId) ||
						(page.selected !== null && page.selected.userId !== request.userId);
					if (foreign) {
						finish(() => resolve());
						return;
					}
					const index = pageCursors.findIndex((pageCursor) => pageCursor === cursor);
					if (index < 0) return;
					if (page.isDone) {
						disposeAfter(index);
						invalidate();
						return;
					}
					if (cursorKey(page.continueCursor) === key) {
						finish(() => reject(new Error('Thread list cursor did not advance.')));
						return;
					}
					if (pageCursors[index + 1] === page.continueCursor) {
						invalidate();
						return;
					}
					disposeAfter(index);
					subscribePage(page.continueCursor);
				},
				(error) => {
					if (signal.aborted) {
						finish(() => resolve());
						return;
					}
					finish(() => reject(error));
				}
			);
			if (settled) {
				subscription.unsubscribe();
				subscriptions.delete(key);
			}
		};

		subscribePage(null);
	});
}

function waitForMachineResult(
	convex: HostedConvexClient,
	id: Id<'machineRequests'>
): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const querySubscription = {
			unsubscribe() {}
		};
		const connectionSubscription = {
			unsubscribe() {}
		};
		let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(waitTimer);
			if (disconnectTimer !== undefined) clearTimeout(disconnectTimer);
			querySubscription.unsubscribe();
			connectionSubscription.unsubscribe();
			action();
		};
		const waitTimer = setTimeout(() => {
			finish(() => reject(new Error(MACHINE_REQUEST_TIMEOUT)));
		}, MACHINE_REQUEST_WAIT_MS);
		connectionSubscription.unsubscribe =
			convex.subscribeToConnectionState?.((state) => {
				if (settled) return;
				if (state.isWebSocketConnected) {
					if (disconnectTimer !== undefined) {
						clearTimeout(disconnectTimer);
						disconnectTimer = undefined;
					}
					return;
				}
				if (!state.hasEverConnected || disconnectTimer !== undefined) return;
				disconnectTimer = setTimeout(() => {
					finish(() => reject(new Error(MACHINE_REQUEST_TIMEOUT)));
				}, MACHINE_REQUEST_DISCONNECT_MS);
			}) ?? (() => {});
		querySubscription.unsubscribe = convex.onUpdate(
			api.machineRequests.get,
			{ id },
			(row) => {
				if (row.status === 'completed') {
					finish(() => {
						if (row.result === undefined) {
							reject(new Error('Machine request completed without a result.'));
							return;
						}
						resolve(row.result);
					});
					return;
				}
				if (row.status === 'failed') {
					finish(() => reject(new Error(row.error ?? 'Machine request failed.')));
				}
			},
			(error) => finish(() => reject(error))
		);
		if (settled) {
			querySubscription.unsubscribe();
			connectionSubscription.unsubscribe();
		}
	});
}

async function enqueueAndWait(
	convex: HostedConvexClient,
	machineId: string,
	requestId: string,
	command: MachineCommand
): Promise<string> {
	const pending = convex.mutation(api.machineRequests.enqueue, {
		machineId,
		requestId,
		command,
		expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS
	});
	const id = await new Promise<Id<'machineRequests'>>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(MACHINE_REQUEST_TIMEOUT)),
			MACHINE_REQUEST_TTL_MS
		);
		void pending.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
	return await waitForMachineResult(convex, id);
}

function parseMachineJson<T>(validator: Validator<T, 'required', string>, result: string): T {
	return parse(validator, JSON.parse(result));
}

export function createHostedApi(
	client: HostedConvexClient,
	getMachineId: () => string | null
): DesktopApi {
	let registered: ThreadCacheUserRequest | null = null;
	const runMachineBySubmission = new Map<string, string>();
	const runInFlight = new Map<string, Promise<AgentRunStart>>();

	function cacheRequest(request: ThreadCacheUserRequest): ThreadCacheUserRequest {
		if (
			registered &&
			registered.userId === request.userId &&
			request.selectedThreadId === undefined &&
			registered.selectedThreadId
		) {
			return { userId: request.userId, selectedThreadId: registered.selectedThreadId };
		}
		return request;
	}

	async function runMachineCommand(command: MachineCommand): Promise<string> {
		const machineId = requireMachineId(getMachineId());
		return await enqueueAndWait(client, machineId, crypto.randomUUID(), command);
	}

	return {
		browseFilesystem: async (input): Promise<FilesystemBrowseResult> => {
			const command: MachineCommand =
				input.cwd === undefined
					? { kind: 'browseFilesystem', partialPath: input.partialPath }
					: { kind: 'browseFilesystem', partialPath: input.partialPath, cwd: input.cwd };
			return parseMachineJson(vFilesystemBrowseResult, await runMachineCommand(command));
		},
		listWorkspaceSkills: async (input): Promise<WorkspaceSkillsResult> =>
			parseMachineJson(
				vWorkspaceSkillsResult,
				await runMachineCommand({ kind: 'listWorkspaceSkills', workspacePath: input.workspacePath })
			),
		resolveWorkspacePath: async (input): Promise<WorkspacePathResolution> => {
			const command: MachineCommand =
				input.createIfMissing === undefined
					? { kind: 'resolveWorkspacePath', workspacePath: input.workspacePath }
					: {
							kind: 'resolveWorkspacePath',
							workspacePath: input.workspacePath,
							createIfMissing: input.createIfMissing
						};
			return parseMachineJson(vWorkspacePathResolution, await runMachineCommand(command));
		},
		listProjectAttachments: async (): Promise<ProjectAttachment[]> => {
			const machineId = getMachineId();
			if (!machineId) {
				return [];
			}
			return parseMachineJson(
				vProjectAttachmentList,
				await enqueueAndWait(client, machineId, crypto.randomUUID(), { kind: 'listProjects' })
			);
		},
		attachProject: async (attachment): Promise<ProjectAttachment> => {
			const command: MachineCommand =
				attachment.replaceWorkspacePath === undefined
					? { kind: 'attachProject', workspacePath: attachment.workspacePath }
					: {
							kind: 'attachProject',
							workspacePath: attachment.workspacePath,
							replaceWorkspacePath: attachment.replaceWorkspacePath
						};
			return parseMachineJson(vProjectAttachment, await runMachineCommand(command));
		},
		runAgent: async (request: AgentRunRequest): Promise<AgentRunStart> => {
			const requestId = machineRequestIdForRun(request.submissionId);
			const bound = runMachineBySubmission.get(requestId);
			const selected = getMachineId();
			if (bound && selected && bound !== selected) {
				throw new Error(RUN_BOUND_TO_OTHER_MACHINE);
			}
			const machineId = bound ?? requireMachineId(selected);
			runMachineBySubmission.set(requestId, machineId);
			const pending = runInFlight.get(requestId);
			if (pending) {
				return await pending;
			}
			const started = enqueueAndWait(client, machineId, requestId, runAgentCommand(request)).then(
				(result) => parseMachineJson(vAgentRunStart, result)
			);
			const tracked = started.finally(() => {
				if (runInFlight.get(requestId) === tracked) {
					runInFlight.delete(requestId);
				}
			});
			runInFlight.set(requestId, tracked);
			return await tracked;
		},
		fetchTranscriptPage: async (request, signal): Promise<LocalTranscriptPage> => {
			signal?.throwIfAborted();
			const page = await client.query(
				api.hostedThreads.transcriptPage,
				transcriptPageArgs(request)
			);
			signal?.throwIfAborted();
			return page;
		},
		fetchTranscriptDetails: async (request, signal): Promise<LocalTranscriptPart[]> => {
			const parts: LocalTranscriptPart[] = [];
			for (
				let offset = 0;
				offset < request.numbers.length;
				offset += HOSTED_TRANSCRIPT_DETAIL_CHUNK_SIZE
			) {
				signal?.throwIfAborted();
				const numbers = request.numbers.slice(offset, offset + HOSTED_TRANSCRIPT_DETAIL_CHUNK_SIZE);
				const details = await client.query(api.hostedThreads.transcriptDetails, {
					threadId: request.threadId,
					numbers
				});
				signal?.throwIfAborted();
				parts.push(...details);
			}
			return parts;
		},
		watchTranscript: async (request: TranscriptScopeRequest, handlers) => {
			await watchQuery(
				client,
				api.hostedThreads.transcriptWatch,
				{ threadId: request.threadId },
				handlers.signal,
				(fingerprint) => {
					if (fingerprint.userId !== request.userId) {
						return 'stop';
					}
					handlers.onEvent({
						eventType: 'updated',
						totalParts: fingerprint.totalParts,
						stale: false
					});
				}
			);
		},
		watchLiveCompletion: async (request: TranscriptScopeRequest, handlers) => {
			await watchQuery(
				client,
				api.hostedLive.get,
				{ threadId: request.threadId },
				handlers.signal,
				(live) => {
					const event: LiveCompletionWatchEvent =
						live === null ? { eventType: 'cleared' } : { eventType: 'updated', live };
					handlers.onEvent(event);
				}
			);
		},
		clearTranscriptReplica: async () => {},
		fetchTranscriptAttachment: async (request) => {
			const download = await client.query(api.transcript.attachmentDownload, {
				imageUploadId: request.imageUploadId
			});
			if (!download?.url) {
				return null;
			}
			try {
				const response = await fetch(download.url);
				if (!response.ok) {
					return null;
				}
				return await response.blob();
			} catch {
				return null;
			}
		},
		registerThreadCache: async (request): Promise<ThreadCacheWatchEvent> => {
			registered = request;
			return { status: 'live', lastSyncedAt: null };
		},
		fetchThreadSnapshot: async (request): Promise<ThreadCacheSnapshot> => {
			const scoped = cacheRequest(request);
			const pages: HostedThreadListPage[] = [];
			let cursor: string | null = null;
			for (let page = 0; page < HOSTED_THREAD_LIST_MAX_PAGES; page += 1) {
				const selectedThreadId = page === 0 ? scoped.selectedThreadId : undefined;
				const result: ListPageResult = await client.query(
					api.hostedThreads.listPage,
					listPageArgs(cursor, selectedThreadId)
				);
				pages.push({ page: result.page, selected: result.selected });
				if (result.isDone) break;
				if (page + 1 === HOSTED_THREAD_LIST_MAX_PAGES) {
					throw new Error('Thread history exceeds the supported snapshot size.');
				}
				if (result.continueCursor === cursor) {
					throw new Error('Thread list cursor did not advance');
				}
				cursor = result.continueCursor;
			}
			const threads = collectThreadSnapshot({ userId: request.userId, pages });
			return {
				status: 'live',
				lastSyncedAt: Date.now(),
				threads: threads ?? []
			};
		},
		watchThreadCache: async (request, handlers) => {
			const lastSyncedAt: SyncTimestamp = { current: null };
			const connection = {
				unsubscribe() {}
			};
			connection.unsubscribe =
				client.subscribeToConnectionState?.((state) => {
					if (handlers.signal.aborted) return;
					if (state.isWebSocketConnected) return;
					handlers.onEvent({
						status: state.hasEverConnected ? 'reconnecting' : 'offline',
						lastSyncedAt: lastSyncedAt.current
					});
				}) ?? (() => {});
			try {
				await watchThreadListPages(
					client,
					cacheRequest(request),
					handlers.signal,
					handlers.onEvent,
					lastSyncedAt
				);
			} finally {
				connection.unsubscribe();
			}
		},
		renameThread: async (request) => {
			await client.mutation(api.threads.renameForLocalCache, {
				threadId: request.threadId,
				title: request.title
			});
			return true;
		},
		archiveThread: async (request) => {
			await client.mutation(api.threads.archiveForLocalCache, {
				threadId: request.threadId
			});
			return true;
		},
		restoreThread: async (request) => {
			await client.mutation(api.threads.restoreForLocalCache, {
				threadId: request.threadId
			});
			return true;
		},
		rekeyRepository: async (request) => {
			const result = await client.mutation(api.threads.rekeyRepositoryForLocalCache, {
				from: request.from,
				to: request.to
			});
			return result.count;
		},
		requestRunCancellation: async (request) => {
			await client.mutation(api.agentRuntime.requestCancellation, {
				runId: request.runId
			});
		},
		endAccountSession: async () => {}
	};
}
