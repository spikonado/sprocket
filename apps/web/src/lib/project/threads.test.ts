import { describe, expect, it } from 'vitest';
import {
	beginPendingAgentLaunch,
	clearPendingAgentLaunch,
	dataForThread,
	findProjectByRepositoryKey,
	getProjectThreadGroups,
	isActiveThread,
	isAgentLaunchPending,
	isLatestRunReadyForThread,
	makeUnconfirmedCreatedThread,
	mergeUnconfirmedCreatedThread,
	mergeUnconfirmedCreatedThreads,
	pickThreadToRestore,
	overrideThreadActiveRun,
	resolveExpiredAgentLaunch,
	resolvePendingAgentLaunch,
	resolvePendingAgentLaunchesFromThreads,
	resolvePendingCreatedThreadId,
	resolveProjectThreadSelection,
	retainUnconfirmedCreatedThreads,
	shouldDropUnconfirmedCreatedThread,
	toThreadSummary,
	type PendingAgentLaunch,
	type PendingAgentLaunches
} from '$lib/project/threads';
import { defaultModelId, defaultReasoningEffort, defaultServiceTier } from '$convex/lib/models';
import type { ThreadSummary, Project } from '$lib/types/sprocket';

type RunId = NonNullable<ThreadSummary['latestRunId']>;

function threadId(value: string): ThreadSummary['threadId'] {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as ThreadSummary['threadId'];
}

function runId(value: string): RunId {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as RunId;
}

const threadA = threadId('thread-record-a');
const threadB = threadId('thread-record-b');
const runA1 = runId('run-a-1');
const runA2 = runId('run-a-2');
const runB1 = runId('run-b-1');
const runB2 = runId('run-b-2');

function makeProject(overrides: Partial<Project> = {}): Project {
	const repositoryKey = overrides.repositoryKey ?? overrides.displayName ?? 'ws-1';
	return {
		repositoryKey,
		displayName: 'Project',
		workspacePath: `/workspaces/${repositoryKey}`,
		...overrides
	};
}

function makeThreadSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
	return {
		threadId: overrides.threadId ?? threadId('thread-record-1'),
		repositoryKey: overrides.repositoryKey ?? 'ws-1',
		title: 'Thread',
		selectedModel: overrides.selectedModel ?? defaultModelId,
		reasoningEffort: overrides.reasoningEffort ?? defaultReasoningEffort,
		serviceTier: overrides.serviceTier ?? defaultServiceTier,
		lastMessageAt: 0,
		threadStatus: 'active',
		latestRunStatus: null,
		latestRunId: null,
		latestRunStartedAt: undefined,
		latestRunClaimExpiresAt: undefined,
		hasActiveRun: false,
		...overrides
	};
}

function beginLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: ThreadSummary['threadId'],
	launchId: number,
	previousRunId: RunId | null = null,
	extras: Partial<PendingAgentLaunch> = {}
): PendingAgentLaunches {
	return beginPendingAgentLaunch(pendingLaunches, threadId, {
		expiresAt: 100,
		launchId,
		previousRunId,
		...extras
	});
}

describe('project thread helpers', () => {
	it('groups threads by repository key and hides keys that are not local', () => {
		const groups = getProjectThreadGroups(
			[
				makeProject({
					repositoryKey: 'github.com/spikonado/sprocket',
					displayName: 'sprocket',
					workspacePath: '/workspaces/sprocket'
				}),
				makeProject({
					repositoryKey: 'local-sprocket',
					displayName: 'sprocket',
					workspacePath: '/workspaces/local'
				})
			],
			[
				makeThreadSummary({
					repositoryKey: 'github.com/spikonado/sprocket',
					lastMessageAt: 10
				}),
				makeThreadSummary({
					threadId: threadId('thread-record-2'),
					repositoryKey: 'stale',
					lastMessageAt: 20
				}),
				makeThreadSummary({
					threadId: threadId('thread-record-3'),
					repositoryKey: 'local-sprocket',
					lastMessageAt: 30
				})
			]
		);

		expect(groups).toHaveLength(2);
		expect(
			groups.find((group) => group.project.workspacePath === '/workspaces/sprocket')?.threads
		).toHaveLength(1);
		expect(
			groups.find((group) => group.project.workspacePath === '/workspaces/local')?.threads
		).toHaveLength(1);
	});

	it('overrides cached run activity for the selected thread only', () => {
		const selected = makeThreadSummary({ threadId: threadA, hasActiveRun: false });
		const other = makeThreadSummary({ threadId: threadB, hasActiveRun: true });

		expect(overrideThreadActiveRun([selected, other], threadA, true)).toEqual([
			{ ...selected, hasActiveRun: true },
			other
		]);
		expect(overrideThreadActiveRun([selected, other], threadB, false)).toEqual([
			selected,
			{ ...other, hasActiveRun: false }
		]);
	});

	it('keeps projects in their given order regardless of thread activity', () => {
		const groups = getProjectThreadGroups(
			[
				makeProject({ repositoryKey: 'ws-older', displayName: 'older' }),
				makeProject({ repositoryKey: 'ws-newer', displayName: 'newer' })
			],
			[
				makeThreadSummary({
					repositoryKey: 'ws-older',
					lastMessageAt: 100
				}),
				makeThreadSummary({
					repositoryKey: 'ws-newer',
					lastMessageAt: 1
				})
			]
		);

		expect(groups.map((group) => group.project.repositoryKey)).toEqual(['ws-older', 'ws-newer']);
	});

	it('restores the most recently active thread, ignoring run state', () => {
		const runningOlder = makeThreadSummary({
			threadId: threadId('thread-record-running'),
			lastMessageAt: 10,
			hasActiveRun: true
		});
		const idleNewer = makeThreadSummary({
			threadId: threadId('thread-record-idle'),
			lastMessageAt: 20
		});
		const archivedNewest = makeThreadSummary({
			threadId: threadId('thread-record-archived'),
			lastMessageAt: 30,
			threadStatus: 'archived'
		});

		// Running-first sidebar order must not leak into session restore.
		expect(pickThreadToRestore([runningOlder, idleNewer, archivedNewest])?.threadId).toBe(
			'thread-record-idle'
		);
		expect(pickThreadToRestore([archivedNewest])).toBeNull();
		expect(pickThreadToRestore([])).toBeNull();
	});

	it('excludes archived threads from project groups', () => {
		const active = makeThreadSummary({
			repositoryKey: 'sprocket',
			lastMessageAt: 10
		});
		const archived = makeThreadSummary({
			threadId: threadId('thread-record-2'),
			repositoryKey: 'sprocket',
			lastMessageAt: 20,
			threadStatus: 'archived'
		});

		expect(isActiveThread(active)).toBe(true);
		expect(isActiveThread(archived)).toBe(false);

		const groups = getProjectThreadGroups(
			[
				makeProject({
					repositoryKey: 'sprocket',
					displayName: 'sprocket'
				})
			],
			[active, archived]
		);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.threads).toHaveLength(1);
		expect(groups[0]?.threads[0]?.threadId).toBe('thread-record-1');
	});

	it('lists running threads before newer completed threads in each project', () => {
		const groups = getProjectThreadGroups(
			[makeProject({ repositoryKey: 'ws-1' })],
			[
				makeThreadSummary({
					threadId: threadId('thread-record-completed-newer'),
					lastMessageAt: 30
				}),
				makeThreadSummary({
					threadId: threadId('thread-record-running-older'),
					lastMessageAt: 10,
					hasActiveRun: true
				}),
				makeThreadSummary({
					threadId: threadId('thread-record-running-newer'),
					lastMessageAt: 20,
					hasActiveRun: true
				})
			]
		);

		expect(groups[0]?.threads.map((thread) => thread.threadId)).toEqual([
			'thread-record-running-newer',
			'thread-record-running-older',
			'thread-record-completed-newer'
		]);
	});

	it('finds a project by repository key', () => {
		const match = makeProject({
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket'
		});
		const projects = [
			match,
			makeProject({
				repositoryKey: 'local-sprocket',
				displayName: 'sprocket'
			})
		];

		expect(findProjectByRepositoryKey(projects, 'github.com/spikonado/sprocket')).toBe(match);
		expect(findProjectByRepositoryKey(projects, 'sprocket')).toBeNull();
	});

	it('maps a persisted thread row onto ThreadSummary fields', () => {
		const row = {
			threadId: threadA,
			repositoryKey: 'ws-1',
			title: 'Checkout',
			selectedModel: 'gpt-5.6-luna',
			reasoningEffort: defaultReasoningEffort,
			serviceTier: defaultServiceTier,
			lastMessageAt: 42,
			threadStatus: 'active' as const,
			latestRunStatus: null,
			latestRunId: runA1,
			latestRunStartedAt: 10,
			latestRunClaimExpiresAt: 20,
			hasActiveRun: true
		};

		expect(toThreadSummary(row)).toEqual({
			threadId: threadA,
			repositoryKey: 'ws-1',
			title: 'Checkout',
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: defaultReasoningEffort,
			serviceTier: defaultServiceTier,
			lastMessageAt: 42,
			threadStatus: 'active',
			latestRunStatus: null,
			latestRunId: runA1,
			latestRunStartedAt: 10,
			latestRunClaimExpiresAt: 20,
			hasActiveRun: true
		});
	});

	it('keeps project fields on the group rather than copying them', () => {
		const project = makeProject({
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket-checkout'
		});
		const groups = getProjectThreadGroups(
			[project],
			[
				makeThreadSummary({
					repositoryKey: 'github.com/spikonado/sprocket',
					lastMessageAt: 10
				})
			]
		);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.project).toBe(project);
		expect(groups[0]?.project.displayName).toBe('sprocket-checkout');
	});

	it('preserves a blank draft selection for the current repository', () => {
		expect(
			resolveProjectThreadSelection({
				threads: [makeThreadSummary()],
				currentThreadId: null,
				currentWorkspacePath: '/workspaces/ws-1',
				draftWorkspacePath: '/workspaces/ws-1'
			})
		).toBeNull();
	});

	it('preserves a newly created thread id before the reactive list includes it', () => {
		const existing = makeThreadSummary({
			threadId: threadId('thread-record-old'),
			lastMessageAt: 20
		});
		const pendingThreadId = threadId('thread-record-new');

		expect(
			resolveProjectThreadSelection({
				threads: [existing],
				currentThreadId: pendingThreadId,
				currentWorkspacePath: '/workspaces/ws-1',
				draftWorkspacePath: null,
				pendingCreatedThreadId: pendingThreadId
			})
		).toBe(pendingThreadId);
	});

	it('falls back when an established thread disappears from the list', () => {
		const newest = makeThreadSummary({
			threadId: threadId('thread-record-newest'),
			lastMessageAt: 30
		});

		expect(
			resolveProjectThreadSelection({
				threads: [newest],
				currentThreadId: threadId('thread-record-vanished'),
				currentWorkspacePath: '/workspaces/ws-1',
				draftWorkspacePath: null,
				pendingCreatedThreadId: null
			})
		).toBe(newest.threadId);
	});

	it('falls back to the newest thread only after the current id is cleared', () => {
		const newest = makeThreadSummary({
			threadId: threadId('thread-record-newest'),
			lastMessageAt: 30
		});

		expect(
			resolveProjectThreadSelection({
				threads: [newest],
				currentThreadId: null,
				currentWorkspacePath: '/workspaces/ws-1',
				draftWorkspacePath: null
			})
		).toBe(newest.threadId);
	});

	it('keeps a created id pinned through unrelated list updates until the thread appears', () => {
		const existing = makeThreadSummary({
			threadId: threadId('thread-record-old')
		});
		const pendingThreadId = threadId('thread-record-new');
		const created = makeThreadSummary({
			threadId: pendingThreadId
		});
		const unrelated = makeThreadSummary({
			threadId: threadId('thread-record-unrelated'),
			lastMessageAt: 10
		});

		expect(
			resolvePendingCreatedThreadId({
				pendingCreatedThreadId: pendingThreadId,
				threads: [existing]
			})
		).toBe(pendingThreadId);
		expect(
			resolvePendingCreatedThreadId({
				pendingCreatedThreadId: pendingThreadId,
				threads: [unrelated, existing]
			})
		).toBe(pendingThreadId);
		expect(
			resolvePendingCreatedThreadId({
				pendingCreatedThreadId: pendingThreadId,
				threads: [created, existing]
			})
		).toBeNull();
	});

	it('prepends an unconfirmed thread and overlays placeholder titles until confirmed', () => {
		const unconfirmed = makeUnconfirmedCreatedThread({
			threadId: threadId('thread-record-new'),
			repositoryKey: 'ws-1',
			selectedModel: defaultModelId,
			reasoningEffort: defaultReasoningEffort,
			serviceTier: defaultServiceTier,
			title: '  Hello from the first prompt  ',
			lastMessageAt: 50
		});
		const existing = makeThreadSummary({
			threadId: threadId('thread-record-old')
		});
		const placeholder = makeThreadSummary({
			threadId: unconfirmed.threadId,
			title: 'New thread'
		});
		const confirmed = makeThreadSummary({
			threadId: unconfirmed.threadId,
			title: 'Hello from the first prompt'
		});

		expect(unconfirmed.title).toBe('Hello from the first prompt');
		expect(mergeUnconfirmedCreatedThread([existing], null)).toEqual([existing]);
		expect(mergeUnconfirmedCreatedThread([existing], unconfirmed)).toEqual([unconfirmed, existing]);
		expect(mergeUnconfirmedCreatedThread([placeholder, existing], unconfirmed)).toEqual([
			{ ...placeholder, title: unconfirmed.title },
			existing
		]);
		expect(mergeUnconfirmedCreatedThread([confirmed, existing], unconfirmed)).toEqual([
			confirmed,
			existing
		]);
		expect(shouldDropUnconfirmedCreatedThread([existing], unconfirmed)).toBe(false);
		expect(shouldDropUnconfirmedCreatedThread([placeholder], unconfirmed)).toBe(false);
		expect(shouldDropUnconfirmedCreatedThread([confirmed], unconfirmed)).toBe(true);
		expect(mergeUnconfirmedCreatedThreads([existing], [unconfirmed, existing])).toEqual([
			unconfirmed,
			existing
		]);
		expect(retainUnconfirmedCreatedThreads([confirmed, existing], [unconfirmed])).toEqual([]);
	});

	it('tracks pending launches independently by thread and clears only progressed ones', () => {
		let pendingLaunches = beginLaunch({}, threadA, 1, runA1);
		pendingLaunches = beginLaunch(pendingLaunches, threadB, 2, runB1);

		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(true);
		expect(isAgentLaunchPending(pendingLaunches, threadB)).toBe(true);
		expect(
			isAgentLaunchPending(resolvePendingAgentLaunch(pendingLaunches, threadA, runA1), threadA)
		).toBe(true);

		pendingLaunches = resolvePendingAgentLaunchesFromThreads(pendingLaunches, [
			makeThreadSummary({ threadId: threadA, latestRunId: runA1, latestRunStartedAt: 10 }),
			makeThreadSummary({ threadId: threadB, latestRunId: runB2, latestRunStartedAt: 10 })
		]);
		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(true);
		expect(isAgentLaunchPending(pendingLaunches, threadB)).toBe(false);

		pendingLaunches = resolvePendingAgentLaunch(pendingLaunches, threadA, runA2);
		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(false);
	});

	it('expires only the matching pending launch and recovers only when the run is unchanged', () => {
		let pendingLaunches = beginLaunch({}, threadA, 1);
		pendingLaunches = beginLaunch(pendingLaunches, threadB, 2);

		expect(resolveExpiredAgentLaunch(pendingLaunches, threadA, 1, 99, null)).toEqual({
			pendingLaunches,
			shouldRecover: false
		});
		expect(resolveExpiredAgentLaunch(pendingLaunches, threadA, 3, 100, null)).toEqual({
			pendingLaunches,
			shouldRecover: false
		});

		const expired = resolveExpiredAgentLaunch(pendingLaunches, threadA, 1, 100, null);
		expect(expired.shouldRecover).toBe(true);
		expect(isAgentLaunchPending(expired.pendingLaunches, threadA)).toBe(false);
		expect(isAgentLaunchPending(expired.pendingLaunches, threadB)).toBe(true);

		const visibleRun = resolveExpiredAgentLaunch(
			beginLaunch({}, threadA, 1, runA1),
			threadA,
			1,
			100,
			runA2
		);
		expect(isAgentLaunchPending(visibleRun.pendingLaunches, threadA)).toBe(false);
		expect(visibleRun.shouldRecover).toBe(false);
	});

	it('reconciles a retry when the existing run receives a new claim lease', () => {
		const pendingLaunches = beginLaunch({}, threadA, 1, runA1, {
			previousClaimExpiresAt: 50
		});

		expect(resolvePendingAgentLaunch(pendingLaunches, threadA, runA1, 50)).toBe(pendingLaunches);
		expect(resolvePendingAgentLaunch(pendingLaunches, threadA, runA1)).toBe(pendingLaunches);
		expect(
			isAgentLaunchPending(resolvePendingAgentLaunch(pendingLaunches, threadA, runA1, 150), threadA)
		).toBe(false);
	});

	it('waits for an established thread latest-run query but permits a newly created thread', () => {
		expect(
			isLatestRunReadyForThread({
				threadId: threadA,
				pendingCreatedThreadId: null,
				hasLatestRunData: false
			})
		).toBe(false);
		expect(
			isLatestRunReadyForThread({
				threadId: threadA,
				pendingCreatedThreadId: threadA,
				hasLatestRunData: false
			})
		).toBe(true);
		expect(
			isLatestRunReadyForThread({
				threadId: threadA,
				pendingCreatedThreadId: null,
				hasLatestRunData: true
			})
		).toBe(true);
	});

	it('scopes error cleanup to the matching thread and launch', () => {
		let pendingLaunches = beginLaunch({}, threadA, 1);
		pendingLaunches = beginLaunch(pendingLaunches, threadA, 2, runA1);
		pendingLaunches = beginLaunch(pendingLaunches, threadB, 3);

		expect(clearPendingAgentLaunch(pendingLaunches, threadA, 1)).toBe(pendingLaunches);

		const afterThreadAError = clearPendingAgentLaunch(pendingLaunches, threadA, 2);
		expect(isAgentLaunchPending(afterThreadAError, threadA)).toBe(false);
		expect(isAgentLaunchPending(afterThreadAError, threadB)).toBe(true);
	});

	it('rejects stale thread-scoped query data', () => {
		const thread = makeThreadSummary();
		const activeThreadRecord = {
			_id: thread.threadId,
			title: thread.title
		};

		expect(dataForThread(thread, thread.threadId)).toBe(thread);
		expect(dataForThread(activeThreadRecord, thread.threadId)).toBe(activeThreadRecord);
		expect(dataForThread(thread, threadId('thread-record-2'))).toBeNull();
		expect(dataForThread(undefined, thread.threadId)).toBeNull();
	});
});
