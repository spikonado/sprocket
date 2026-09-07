import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '$convex/_generated/api';
import { MACHINE_REQUEST_TTL_MS } from '$convex/lib/machineRequests';
import type { Id } from '$convex/_generated/dataModel';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import {
	createHostedApi,
	MACHINE_REQUEST_DISCONNECT_MS,
	MACHINE_REQUEST_TIMEOUT,
	MACHINE_REQUEST_WAIT_MS,
	type HostedConvexClient
} from '$lib/hosted/client';
import type { AgentRunRequest, ThreadMessage } from '$lib/types/sprocket';
import { assembleTranscriptParts } from '$lib/project/transcript-parts';

type MachineRequestGet = FunctionReturnType<typeof api.machineRequests.get>;
type HostedLiveGet = FunctionReturnType<typeof api.hostedLive.get>;
type TranscriptWatch = FunctionReturnType<typeof api.hostedThreads.transcriptWatch>;
type ThreadListPage = FunctionReturnType<typeof api.hostedThreads.listPage>;
type ListPageArgs = FunctionArgs<typeof api.hostedThreads.listPage>;
type TranscriptDetailsArgs = FunctionArgs<typeof api.hostedThreads.transcriptDetails>;

function threadId(value: string): Id<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

function runId(value: string): Id<'runs'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'runs'>;
}

function runRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
	return {
		userId: 'user_alice',
		submissionId: 'sub-1',
		prompt: 'Hello',
		imageUploadIds: [],
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard',
		workspacePath: '/work',
		...overrides
	};
}

function overlay(): NonNullable<HostedLiveGet> {
	return {
		threadId: threadId('thread-1'),
		runId: runId('run-1'),
		runStatus: 'running',
		text: 'Hello',
		parts: [],
		runStartedAt: 1
	};
}

function completedMachineRequest(): MachineRequestGet {
	return {
		status: 'completed',
		result: JSON.stringify({ runId: 'run-1', threadId: 'thread-1' })
	};
}

function transcriptWatchResult(overrides: Partial<TranscriptWatch> = {}): TranscriptWatch {
	return {
		threadId: threadId('thread-1'),
		userId: 'user_alice',
		totalParts: 2,
		historyFromNumber: 0,
		latestPartNumber: 1,
		latestPartId: null,
		latestPartCreationTime: null,
		latestSourceKey: null,
		latestRunId: null,
		latestRunStatus: null,
		...overrides
	};
}

function threadListPageResult(args: {
	page: Array<{ _id: Id<'threadRecords'>; userId: string }>;
	isDone: boolean;
	continueCursor: string;
}): ThreadListPage {
	// SAFETY: watch tests only read page[].userId, isDone, continueCursor, and selected.
	return {
		page: args.page,
		isDone: args.isDone,
		continueCursor: args.continueCursor,
		selected: null
	} as ThreadListPage;
}

function detailsMessage(numbers: number[]): ThreadMessage {
	return {
		_id: 'response:run-1',
		threadId: threadId('thread-1'),
		runId: runId('run-1'),
		userId: 'user_alice',
		type: 'response',
		text: numbers.map(String).join(''),
		attachments: [],
		parts: numbers.map((number) => ({
			type: 'text' as const,
			id: `t${number}`,
			text: String(number)
		})),
		runStatus: 'completed',
		runStartedAt: 1,
		sourceNumbers: numbers,
		detailsLoaded: true
	};
}

function mockClient(overrides: Partial<HostedConvexClient> = {}) {
	const unsubscribed = vi.fn();
	const client = {
		query: vi.fn(async () => {
			throw new Error('unexpected query');
		}),
		mutation: vi.fn(async () => {
			throw new Error('unexpected mutation');
		}),
		onUpdate: vi.fn(() => unsubscribed),
		...overrides
	};
	// SAFETY: test doubles only implement the hosted Convex methods these tests call.
	return { client: client as HostedConvexClient, unsubscribed };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('createHostedApi reads without a machine', () => {
	it('lists no project attachments and does not enqueue', async () => {
		const { client } = mockClient();
		const apiClient = createHostedApi(client, () => null);
		await expect(apiClient.listProjectAttachments()).resolves.toEqual([]);
		expect(client.mutation).not.toHaveBeenCalled();
		expect(client.query).not.toHaveBeenCalled();
	});

	it('does not end a remote machine session from the browser', async () => {
		const { client } = mockClient();
		const apiClient = createHostedApi(client, () => 'machine-a');
		await apiClient.endAccountSession({ userId: 'user_alice' });
		expect(client.mutation).not.toHaveBeenCalled();
	});

	it('walks listPage cursors past the first 40 threads and dedups', async () => {
		const first = Array.from({ length: 40 }, (_, index) => ({
			_id: threadId(`t${index}`),
			userId: 'user_alice'
		}));
		const second = [
			{ _id: threadId('t0'), userId: 'user_alice' },
			{ _id: threadId('t40'), userId: 'user_alice' }
		];
		const query = vi
			.fn()
			.mockResolvedValueOnce({
				page: first,
				isDone: false,
				continueCursor: 'page-2',
				selected: { _id: threadId('t-selected'), userId: 'user_alice' }
			})
			.mockResolvedValueOnce({
				page: second,
				isDone: true,
				continueCursor: '',
				selected: null
			});
		const { client } = mockClient({ query });
		const apiClient = createHostedApi(client, () => null);
		await apiClient.registerThreadCache({
			userId: 'user_alice',
			selectedThreadId: threadId('t-selected')
		});
		const snapshot = await apiClient.fetchThreadSnapshot({ userId: 'user_alice' });
		expect(snapshot.threads.map((row) => row._id)).toEqual([
			...first.map((row) => row._id),
			't40',
			't-selected'
		]);
		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls[1]?.[1]).toMatchObject({
			paginationOpts: { numItems: 40, cursor: 'page-2' }
		});
	});

	it('drops a snapshot that includes another user', async () => {
		const { client } = mockClient({
			query: vi.fn(async () => ({
				page: [{ _id: threadId('t1'), userId: 'user_bob' }],
				isDone: true,
				continueCursor: '',
				selected: null
			}))
		});
		const snapshot = await createHostedApi(client, () => null).fetchThreadSnapshot({
			userId: 'user_alice'
		});
		expect(snapshot.threads).toEqual([]);
	});
});

describe('createHostedApi machine commands', () => {
	it('bounds an offline enqueue and does not subscribe after its delayed response', async () => {
		vi.useFakeTimers();
		const delayed = Promise.withResolvers<string>();
		const mutation = vi.fn(() => delayed.promise);
		const onUpdate = vi.fn(() => () => {});
		const { client } = mockClient({ mutation, onUpdate });
		const expiresAt = Date.now() + MACHINE_REQUEST_TTL_MS;
		const pending = createHostedApi(client, () => 'machine-a').runAgent(runRequest());
		const failed = expect(pending).rejects.toThrow(MACHINE_REQUEST_TIMEOUT);
		await vi.advanceTimersByTimeAsync(MACHINE_REQUEST_TTL_MS);
		await failed;
		expect(mutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ expiresAt })
		);
		delayed.resolve('mreq-delayed');
		await vi.advanceTimersByTimeAsync(0);
		expect(onUpdate).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('sends runAgent with the stable submissionId and waits for the result', async () => {
		const mutation = vi.fn(async () => 'mreq-1');
		const onUpdate = vi.fn((_query, _args, callback: (row: MachineRequestGet) => void) => {
			callback(completedMachineRequest());
			return () => {};
		});
		const { client } = mockClient({ mutation, onUpdate });
		let machineId: string | null = 'machine-a';
		const apiClient = createHostedApi(client, () => machineId);
		await expect(apiClient.runAgent(runRequest())).resolves.toEqual({
			runId: 'run-1',
			threadId: 'thread-1'
		});
		expect(mutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				machineId: 'machine-a',
				requestId: 'sub-1',
				command: expect.objectContaining({ kind: 'runAgent', submissionId: 'sub-1' })
			})
		);

		machineId = 'machine-b';
		await expect(apiClient.runAgent(runRequest())).rejects.toThrow(
			'This run was already sent to another machine.'
		);
		expect(mutation).toHaveBeenCalledTimes(1);
	});

	it('joins an in-flight run instead of enqueueing twice', async () => {
		const mutation = vi.fn(async () => 'mreq-1');
		const onUpdate = vi.fn((_query, _args, callback: (row: MachineRequestGet) => void) => {
			callback(completedMachineRequest());
			return () => {};
		});
		const { client } = mockClient({ mutation, onUpdate });
		const apiClient = createHostedApi(client, () => 'machine-a');
		const first = apiClient.runAgent(runRequest());
		const second = apiClient.runAgent(runRequest());
		await expect(Promise.all([first, second])).resolves.toEqual([
			{ runId: 'run-1', threadId: 'thread-1' },
			{ runId: 'run-1', threadId: 'thread-1' }
		]);
		expect(mutation).toHaveBeenCalledTimes(1);
	});

	it('times out a disconnected wait and retries the original machine and submission', async () => {
		vi.useFakeTimers();
		const unsubscribed = vi.fn();
		const unsubConnection = vi.fn();
		let onDisconnect:
			((state: { isWebSocketConnected: boolean; hasEverConnected?: boolean }) => void) | undefined;
		const mutation = vi.fn(async () => 'mreq-1');
		let completeOnSubscribe = false;
		const onUpdate = vi.fn(
			(
				_query: typeof api.machineRequests.get,
				_args: FunctionArgs<typeof api.machineRequests.get>,
				callback: (row: MachineRequestGet) => void
			) => {
				if (completeOnSubscribe) callback(completedMachineRequest());
				return unsubscribed;
			}
		);
		const { client } = mockClient({
			mutation,
			onUpdate,
			subscribeToConnectionState: (callback) => {
				onDisconnect = callback;
				return unsubConnection;
			}
		});
		const apiClient = createHostedApi(client, () => 'machine-a');
		const pending = apiClient.runAgent(runRequest());
		const failed = expect(pending).rejects.toThrow(MACHINE_REQUEST_TIMEOUT);
		await vi.advanceTimersByTimeAsync(0);
		expect(onDisconnect).toBeDefined();
		onDisconnect?.({ isWebSocketConnected: false, hasEverConnected: true });
		await vi.advanceTimersByTimeAsync(MACHINE_REQUEST_DISCONNECT_MS);
		await failed;
		expect(unsubscribed).toHaveBeenCalled();
		expect(unsubConnection).toHaveBeenCalled();

		completeOnSubscribe = true;
		await expect(apiClient.runAgent(runRequest())).resolves.toEqual({
			runId: 'run-1',
			threadId: 'thread-1'
		});
		expect(mutation).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			expect.objectContaining({ machineId: 'machine-a', requestId: 'sub-1' })
		);
	});

	it('cleans timers and subscriptions when the wait hits the bounded lifetime', async () => {
		vi.useFakeTimers();
		const unsubscribed = vi.fn();
		const { client } = mockClient({
			mutation: vi.fn(async () => 'mreq-1'),
			onUpdate: vi.fn(() => unsubscribed)
		});
		const pending = createHostedApi(client, () => 'machine-a').runAgent(runRequest());
		const failed = expect(pending).rejects.toThrow(MACHINE_REQUEST_TIMEOUT);
		await vi.advanceTimersByTimeAsync(MACHINE_REQUEST_WAIT_MS);
		await failed;
		expect(unsubscribed).toHaveBeenCalled();
	});
});

describe('createHostedApi subscriptions', () => {
	it('unsubscribes watchLiveCompletion on abort and maps hostedLive.get', async () => {
		let emit: ((value: HostedLiveGet) => void) | undefined;
		const unsubscribed = vi.fn();
		const onUpdate = vi.fn((_query, _args, callback: (value: HostedLiveGet) => void) => {
			emit = callback;
			return unsubscribed;
		});
		const { client } = mockClient({ onUpdate });
		const apiClient = createHostedApi(client, () => null);
		const ac = new AbortController();
		const events: unknown[] = [];
		const watching = apiClient.watchLiveCompletion(
			{ userId: 'user_alice', threadId: threadId('thread-1') },
			{
				signal: ac.signal,
				onEvent: (event) => {
					events.push(event);
				}
			}
		);
		emit?.(overlay());
		emit?.(null);
		ac.abort();
		await watching;
		expect(events).toEqual([{ eventType: 'updated', live: overlay() }, { eventType: 'cleared' }]);
		expect(unsubscribed).toHaveBeenCalledTimes(1);
	});

	it('unsubscribes transcript and thread watches on abort', async () => {
		const unsubscribed = vi.fn();
		const { client } = mockClient({
			onUpdate: vi.fn(() => unsubscribed)
		});
		const apiClient = createHostedApi(client, () => null);
		const transcriptAbort = new AbortController();
		const threadAbort = new AbortController();
		const transcriptWatch = apiClient.watchTranscript(
			{ userId: 'user_alice', threadId: threadId('thread-1') },
			{ signal: transcriptAbort.signal, onEvent: () => {} }
		);
		const threadWatch = apiClient.watchThreadCache(
			{ userId: 'user_alice' },
			{ signal: threadAbort.signal, onEvent: () => {} }
		);
		transcriptAbort.abort();
		threadAbort.abort();
		await Promise.all([transcriptWatch, threadWatch]);
		expect(unsubscribed).toHaveBeenCalledTimes(2);
	});

	it('watches each loaded listPage cursor and unsubscribes the range on abort', async () => {
		const unsubscribed = vi.fn();
		const events: Array<{ status: string }> = [];
		const onUpdate = vi.fn(
			(_query, args: ListPageArgs, callback: (page: ThreadListPage) => void) => {
				if (args.paginationOpts.cursor === null) {
					callback(
						threadListPageResult({
							page: [{ _id: threadId('t0'), userId: 'user_alice' }],
							isDone: false,
							continueCursor: 'page-2'
						})
					);
				} else {
					callback(
						threadListPageResult({
							page: [{ _id: threadId('t40'), userId: 'user_alice' }],
							isDone: true,
							continueCursor: ''
						})
					);
				}
				return unsubscribed;
			}
		);
		const { client } = mockClient({ onUpdate });
		const ac = new AbortController();
		const watching = createHostedApi(client, () => null).watchThreadCache(
			{ userId: 'user_alice' },
			{
				signal: ac.signal,
				onEvent: (event) => {
					events.push(event);
				}
			}
		);
		expect(onUpdate).toHaveBeenCalledTimes(2);
		expect(onUpdate.mock.calls[0]?.[1]).toMatchObject({
			paginationOpts: { numItems: 40, cursor: null }
		});
		expect(onUpdate.mock.calls[1]?.[1]).toMatchObject({
			paginationOpts: { numItems: 40, cursor: 'page-2' }
		});
		expect(events.every((event) => event.status === 'live')).toBe(true);
		expect(events).toHaveLength(1);
		ac.abort();
		await watching;
		expect(unsubscribed).toHaveBeenCalledTimes(2);
	});

	it('stops transcript updates after an account switch', async () => {
		const unsubscribed = vi.fn();
		const onUpdate = vi.fn((_query, _args, callback: (value: TranscriptWatch) => void) => {
			callback(transcriptWatchResult({ userId: 'user_bob', totalParts: 1, latestPartNumber: 0 }));
			return unsubscribed;
		});
		const { client } = mockClient({ onUpdate });
		const events: unknown[] = [];
		await createHostedApi(client, () => null).watchTranscript(
			{ userId: 'user_alice', threadId: threadId('thread-1') },
			{
				signal: new AbortController().signal,
				onEvent: (event) => {
					events.push(event);
				}
			}
		);
		expect(events).toEqual([]);
		expect(unsubscribed).toHaveBeenCalledTimes(1);
	});
});

describe('createHostedApi transcript details', () => {
	it('loads numbered details in bounded chunks for the shared transcript assembler', async () => {
		const numbers = Array.from({ length: 250 }, (_, index) => index);
		const query = vi.fn(async (_query, args: TranscriptDetailsArgs) =>
			args.numbers.map((number) => ({
				number,
				kind: 'completion' as const,
				message: detailsMessage([number])
			}))
		);
		const { client } = mockClient({ query });
		const details = await createHostedApi(client, () => null).fetchTranscriptDetails({
			userId: 'user_alice',
			threadId: threadId('thread-1'),
			numbers
		});
		expect(query).toHaveBeenCalledTimes(32);
		expect(query.mock.calls.every(([, args]) => args.numbers.length <= 8)).toBe(true);
		expect(details.map((part) => part.number)).toEqual(numbers);
		const [message] = assembleTranscriptParts(details);
		expect(message?._id).toBe('response:run-1');
		expect(message?.sourceNumbers).toEqual(numbers);
		expect(message?.parts).toHaveLength(250);
		expect(message?.detailsLoaded).toBe(true);
	});

	it('stops loading subsequent detail chunks when the transcript is abandoned', async () => {
		const controller = new AbortController();
		const query = vi.fn(async () => {
			controller.abort();
			return [];
		});
		const { client } = mockClient({ query });
		await expect(
			createHostedApi(client, () => null).fetchTranscriptDetails(
				{
					userId: 'user_alice',
					threadId: threadId('thread-1'),
					numbers: Array.from({ length: 20 }, (_, index) => index)
				},
				controller.signal
			)
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(query).toHaveBeenCalledTimes(1);
	});
});
