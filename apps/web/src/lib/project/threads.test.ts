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
	pickThreadToRestore,
	resolveExpiredAgentLaunch,
	resolvePendingAgentLaunch,
	resolvePendingAgentLaunchesFromThreads,
	resolvePendingCreatedThreadId,
	resolveProjectThreadSelection,
	shouldForkProjectForRemoteChange,
	type PendingAgentLaunch,
	type PendingAgentLaunches
} from '$lib/project/threads';
import { defaultModelId, defaultReasoningEffort, defaultServiceTier } from '$convex/lib/models';
import type { ThreadSummary, Project } from '$lib/types/sprocket';

type RunId = NonNullable<ThreadSummary['latestRunId']>;

const threadA = 'thread-record-a' as ThreadSummary['threadId'];
const threadB = 'thread-record-b' as ThreadSummary['threadId'];
const runA1 = 'run-a-1' as RunId;
const runA2 = 'run-a-2' as RunId;
const runB1 = 'run-b-1' as RunId;
const runB2 = 'run-b-2' as RunId;

function makeProject(overrides: Partial<Project> = {}): Project {
	return {
		_id: (overrides._id ?? 'ws-1') as Project['_id'],
		userId: 'user-1',
		repositoryKey: overrides.repositoryKey ?? overrides.displayName ?? 'Project',
		displayName: 'Project',
		...overrides
	};
}

function makeThreadSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
	return {
		threadId: (overrides.threadId ?? 'thread-record-1') as ThreadSummary['threadId'],
		projectId: (overrides.projectId ?? 'ws-1') as ThreadSummary['projectId'],
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
	it('groups threads by project id', () => {
		const groups = getProjectThreadGroups(
			[
				makeProject({
					_id: 'ws-current' as Project['_id'],
					repositoryKey: 'github.com/spikonado/sprocket',
					displayName: 'sprocket'
				}),
				makeProject({
					_id: 'ws-other' as Project['_id'],
					repositoryKey: 'local-sprocket',
					displayName: 'sprocket'
				})
			],
			[
				makeThreadSummary({
					projectId: 'ws-current' as ThreadSummary['projectId'],
					lastMessageAt: 10
				}),
				makeThreadSummary({
					threadId: 'thread-record-2' as ThreadSummary['threadId'],
					projectId: 'ws-stale' as ThreadSummary['projectId'],
					lastMessageAt: 20
				}),
				makeThreadSummary({
					threadId: 'thread-record-3' as ThreadSummary['threadId'],
					projectId: 'ws-other' as ThreadSummary['projectId'],
					lastMessageAt: 30
				})
			]
		);

		expect(groups).toHaveLength(3);
		expect(groups.find((group) => group.project._id === 'ws-current')?.threads).toHaveLength(1);
		expect(groups.find((group) => group.project._id === 'ws-other')?.threads).toHaveLength(1);
		expect(groups.find((group) => group.project._id === 'ws-stale')?.project.displayName).toBe(
			'Unknown project'
		);
	});

	it('keeps projects in their given order regardless of thread activity', () => {
		const groups = getProjectThreadGroups(
			[
				makeProject({ _id: 'ws-older' as Project['_id'], displayName: 'older' }),
				makeProject({ _id: 'ws-newer' as Project['_id'], displayName: 'newer' })
			],
			[
				// Heavy recent activity on the older project must not reorder it.
				makeThreadSummary({
					projectId: 'ws-older' as ThreadSummary['projectId'],
					lastMessageAt: 100
				}),
				makeThreadSummary({
					projectId: 'ws-newer' as ThreadSummary['projectId'],
					lastMessageAt: 1
				})
			]
		);

		expect(groups.map((group) => group.project._id)).toEqual(['ws-older', 'ws-newer']);
	});

	it('restores the most recently active thread, ignoring run state', () => {
		const runningOlder = makeThreadSummary({
			threadId: 'thread-record-running' as ThreadSummary['threadId'],
			lastMessageAt: 10,
			hasActiveRun: true
		});
		const idleNewer = makeThreadSummary({
			threadId: 'thread-record-idle' as ThreadSummary['threadId'],
			lastMessageAt: 20
		});
		const archivedNewest = makeThreadSummary({
			threadId: 'thread-record-archived' as ThreadSummary['threadId'],
			lastMessageAt: 30,
			threadStatus: 'archived'
		});

		// Running-first listMine order must not leak into session restore.
		expect(pickThreadToRestore([runningOlder, idleNewer, archivedNewest])?.threadId).toBe(
			'thread-record-idle'
		);
		expect(pickThreadToRestore([archivedNewest])).toBeNull();
		expect(pickThreadToRestore([])).toBeNull();
	});

	it('excludes archived threads from project groups', () => {
		const active = makeThreadSummary({
			projectId: 'ws-current' as ThreadSummary['projectId'],
			lastMessageAt: 10
		});
		const archived = makeThreadSummary({
			threadId: 'thread-record-2' as ThreadSummary['threadId'],
			projectId: 'ws-current' as ThreadSummary['projectId'],
			lastMessageAt: 20,
			threadStatus: 'archived'
		});

		expect(isActiveThread(active)).toBe(true);
		expect(isActiveThread(archived)).toBe(false);

		const groups = getProjectThreadGroups(
			[
				makeProject({
					_id: 'ws-current' as Project['_id'],
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
			[],
			[
				makeThreadSummary({
					threadId: 'thread-record-completed-newer' as ThreadSummary['threadId'],
					lastMessageAt: 30
				}),
				makeThreadSummary({
					threadId: 'thread-record-running-older' as ThreadSummary['threadId'],
					lastMessageAt: 10,
					hasActiveRun: true
				}),
				makeThreadSummary({
					threadId: 'thread-record-running-newer' as ThreadSummary['threadId'],
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
			_id: 'ws-1' as Project['_id'],
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket'
		});
		const projects = [
			match,
			makeProject({
				_id: 'ws-2' as Project['_id'],
				repositoryKey: 'local-sprocket',
				displayName: 'sprocket'
			})
		];

		expect(findProjectByRepositoryKey(projects, 'github.com/spikonado/sprocket')).toBe(match);
		expect(findProjectByRepositoryKey(projects, 'sprocket')).toBeNull();
	});

	it('keeps project fields on the group rather than copying them', () => {
		const project = makeProject({
			_id: 'ws-current' as Project['_id'],
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket-checkout'
		});
		const groups = getProjectThreadGroups(
			[project],
			[
				makeThreadSummary({
					projectId: 'ws-current' as ThreadSummary['projectId'],
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
				currentRepositoryKey: 'Project',
				draftRepositoryKey: 'Project'
			})
		).toBeNull();
	});

	it('preserves a newly created thread id before the reactive list includes it', () => {
		const existing = makeThreadSummary({
			threadId: 'thread-record-old' as ThreadSummary['threadId'],
			lastMessageAt: 20
		});
		const pendingThreadId = 'thread-record-new' as ThreadSummary['threadId'];

		expect(
			resolveProjectThreadSelection({
				threads: [existing],
				currentThreadId: pendingThreadId,
				currentRepositoryKey: 'Project',
				draftRepositoryKey: null,
				pendingCreatedThreadId: pendingThreadId
			})
		).toBe(pendingThreadId);
	});

	it('falls back when an established thread disappears from the list', () => {
		const newest = makeThreadSummary({
			threadId: 'thread-record-newest' as ThreadSummary['threadId'],
			lastMessageAt: 30
		});

		expect(
			resolveProjectThreadSelection({
				threads: [newest],
				currentThreadId: 'thread-record-vanished' as ThreadSummary['threadId'],
				currentRepositoryKey: 'Project',
				draftRepositoryKey: null,
				pendingCreatedThreadId: null
			})
		).toBe(newest.threadId);
	});

	it('falls back to the newest thread only after the current id is cleared', () => {
		const newest = makeThreadSummary({
			threadId: 'thread-record-newest' as ThreadSummary['threadId'],
			lastMessageAt: 30
		});

		expect(
			resolveProjectThreadSelection({
				threads: [newest],
				currentThreadId: null,
				currentRepositoryKey: 'Project',
				draftRepositoryKey: null
			})
		).toBe(newest.threadId);
	});

	it('keeps a created id pinned through unrelated list updates until the thread appears', () => {
		const existing = makeThreadSummary({
			threadId: 'thread-record-old' as ThreadSummary['threadId']
		});
		const pendingThreadId = 'thread-record-new' as ThreadSummary['threadId'];
		const created = makeThreadSummary({
			threadId: pendingThreadId
		});
		const unrelated = makeThreadSummary({
			threadId: 'thread-record-unrelated' as ThreadSummary['threadId'],
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
		expect(dataForThread(thread, 'thread-record-2' as ThreadSummary['threadId'])).toBeNull();
		expect(dataForThread(undefined, thread.threadId)).toBeNull();
	});

	it('forks when selected and resolved repository keys differ', () => {
		expect(
			shouldForkProjectForRemoteChange('github.com/spikonado/old', 'github.com/spikonado/sprocket')
		).toBe(true);
		expect(
			shouldForkProjectForRemoteChange(
				'github.com/spikonado/sprocket',
				'github.com/spikonado/sprocket'
			)
		).toBe(false);
		expect(shouldForkProjectForRemoteChange('', 'github.com/spikonado/sprocket')).toBe(false);
		expect(shouldForkProjectForRemoteChange('github.com/spikonado/sprocket', '')).toBe(false);
	});
});
