import { describe, expect, it } from 'vitest';
import {
	beginPendingAgentLaunch,
	clearPendingAgentLaunch,
	dataForThread,
	isAgentLaunchPending,
	isLatestRunReadyForThread,
	resolveExpiredAgentLaunch,
	resolvePendingAgentLaunch,
	resolvePendingCreatedThreadId,
	type PendingAgentLaunch,
	type PendingAgentLaunches
} from '$lib/project/threads';
import { defaultModelId, defaultReasoningEffort } from '$convex/lib/models';
import type { Id } from '$convex/_generated/dataModel';
import type { ThreadSummary } from '$lib/types/sprocket';

type RunId = Id<'runs'>;

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

function makeThreadSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
	return {
		threadId: overrides.threadId ?? threadId('thread-record-1'),
		repositoryKey: overrides.repositoryKey ?? 'ws-1',
		title: 'Thread',
		selectedModel: overrides.selectedModel ?? defaultModelId,
		reasoningEffort: overrides.reasoningEffort ?? defaultReasoningEffort,
		fastMode: overrides.fastMode ?? false,
		lastMessageAt: 0,
		threadStatus: 'active',
		status: 'completed',
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

	it('tracks pending launches independently by thread and clears only progressed ones', () => {
		let pendingLaunches = beginLaunch({}, threadA, 1, runA1);
		pendingLaunches = beginLaunch(pendingLaunches, threadB, 2, runB1);

		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(true);
		expect(isAgentLaunchPending(pendingLaunches, threadB)).toBe(true);
		expect(
			isAgentLaunchPending(resolvePendingAgentLaunch(pendingLaunches, threadA, runA1), threadA)
		).toBe(true);

		pendingLaunches = resolvePendingAgentLaunch(pendingLaunches, threadB, runB2, undefined, 10);
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
