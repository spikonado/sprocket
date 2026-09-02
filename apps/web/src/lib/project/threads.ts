import type { Id } from '$convex/_generated/dataModel';
import { coercePersistedModelId } from '$convex/lib/models';
import type { Project, ThreadSummary, ProjectThreadGroup } from '$lib/types/sprocket';

export type ThreadSummaryRow = {
	threadId: ThreadSummary['threadId'];
	repositoryKey: ThreadSummary['repositoryKey'];
	title: string;
	selectedModel: string;
	reasoningEffort: ThreadSummary['reasoningEffort'];
	serviceTier: ThreadSummary['serviceTier'];
	lastMessageAt: number;
	threadStatus: ThreadSummary['threadStatus'];
	latestRunStatus: ThreadSummary['latestRunStatus'];
	latestRunId: ThreadSummary['latestRunId'];
	latestRunStartedAt?: number;
	latestRunClaimExpiresAt?: number;
	hasActiveRun: boolean;
};

export function toThreadSummary(row: ThreadSummaryRow): ThreadSummary {
	return {
		threadId: row.threadId,
		repositoryKey: row.repositoryKey ?? '',
		title: row.title,
		selectedModel: coercePersistedModelId(row.selectedModel),
		reasoningEffort: row.reasoningEffort,
		serviceTier: row.serviceTier,
		lastMessageAt: row.lastMessageAt,
		threadStatus: row.threadStatus,
		latestRunStatus: row.latestRunStatus,
		latestRunId: row.latestRunId,
		latestRunStartedAt: row.latestRunStartedAt,
		latestRunClaimExpiresAt: row.latestRunClaimExpiresAt,
		hasActiveRun: row.hasActiveRun
	};
}

export function findProjectByRepositoryKey<T extends Pick<Project, 'repositoryKey'>>(
	projects: T[],
	repositoryKey: string | null | undefined
): T | null {
	if (!repositoryKey) {
		return null;
	}
	return projects.find((project) => project.repositoryKey === repositoryKey) ?? null;
}

export function findProjectByWorkspacePath<T extends Pick<Project, 'workspacePath'>>(
	projects: T[],
	workspacePath: string | null | undefined
): T | null {
	if (!workspacePath) {
		return null;
	}
	return projects.find((project) => project.workspacePath === workspacePath) ?? null;
}

export function isActiveThread(thread: Pick<ThreadSummary, 'threadStatus'>) {
	return thread.threadStatus !== 'archived';
}

function buildProjectThreadGroup(project: Project, threads: ThreadSummary[]): ProjectThreadGroup {
	const sortedThreads = sortThreadsRunningFirst(threads);
	return {
		project,
		threads: sortedThreads,
		activeThreadCount: countActiveThreads(sortedThreads)
	};
}

export function getProjectThreadGroups(projects: Project[], threads: ThreadSummary[]) {
	const threadsByRepositoryKey = new Map<string, ThreadSummary[]>();

	for (const thread of threads.filter(isActiveThread)) {
		const existing = threadsByRepositoryKey.get(thread.repositoryKey);
		if (existing) {
			existing.push(thread);
			continue;
		}
		threadsByRepositoryKey.set(thread.repositoryKey, [thread]);
	}

	return projects.map((project) =>
		buildProjectThreadGroup(project, threadsByRepositoryKey.get(project.repositoryKey) ?? [])
	);
}

function sortThreadsRunningFirst(threads: ThreadSummary[]) {
	return [...threads].sort((left, right) => {
		if (left.hasActiveRun !== right.hasActiveRun) {
			return Number(right.hasActiveRun) - Number(left.hasActiveRun);
		}

		return right.lastMessageAt - left.lastMessageAt;
	});
}

function countActiveThreads(threads: ThreadSummary[]) {
	return threads.filter((thread) => thread.hasActiveRun).length;
}

export function findThreadById(
	threads: ThreadSummary[],
	threadId: Id<'threadRecords'> | null
): ThreadSummary | null {
	if (!threadId) {
		return null;
	}

	return threads.find((thread) => thread.threadId === threadId) ?? null;
}

/**
 * Session-restore target: the non-archived thread the user most recently
 * prompted or got a response in. Deliberately ignores run state. A
 * background run in another project should not hijack the session on load.
 */
export function pickThreadToRestore(threads: ThreadSummary[]): ThreadSummary | null {
	let latest: ThreadSummary | null = null;
	for (const thread of threads) {
		if (!isActiveThread(thread)) {
			continue;
		}
		if (!latest || thread.lastMessageAt > latest.lastMessageAt) {
			latest = thread;
		}
	}
	return latest;
}

export function dataForThread<
	T extends { threadId?: Id<'threadRecords'>; _id?: Id<'threadRecords'> }
>(data: T | null | undefined, threadId: Id<'threadRecords'> | null): T | null {
	return threadId && (data?.threadId ?? data?._id) === threadId ? data! : null;
}

export function resolvePendingCreatedThreadId(args: {
	pendingCreatedThreadId: Id<'threadRecords'> | null;
	threads: ThreadSummary[];
}): Id<'threadRecords'> | null {
	const { pendingCreatedThreadId, threads } = args;
	if (!pendingCreatedThreadId) {
		return null;
	}

	if (threads.some((thread) => thread.threadId === pendingCreatedThreadId)) {
		return null;
	}

	return pendingCreatedThreadId;
}

export function isLatestRunReadyForThread(args: {
	threadId: Id<'threadRecords'> | null;
	pendingCreatedThreadId: Id<'threadRecords'> | null;
	hasLatestRunData: boolean;
}): boolean {
	return !args.threadId || args.threadId === args.pendingCreatedThreadId || args.hasLatestRunData;
}

export type PendingAgentLaunch = {
	expiresAt: number;
	launchId: number;
	previousClaimExpiresAt?: number;
	previousStartedAt?: number;
	previousRunId: Id<'runs'> | null;
};

export type PendingAgentLaunches = Readonly<Partial<Record<string, PendingAgentLaunch>>>;

export function isAgentLaunchPending(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'> | null
): boolean {
	return Boolean(threadId && pendingLaunches[threadId]);
}

export function beginPendingAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	launch: PendingAgentLaunch
) {
	return { ...pendingLaunches, [threadId]: launch } satisfies PendingAgentLaunches;
}

export function clearPendingAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	launchId?: number
) {
	const pendingLaunch = pendingLaunches[threadId];
	if (!pendingLaunch || (launchId !== undefined && pendingLaunch.launchId !== launchId)) {
		return pendingLaunches;
	}

	const nextPendingLaunches = { ...pendingLaunches };
	delete nextPendingLaunches[threadId];
	return nextPendingLaunches satisfies PendingAgentLaunches;
}

function hasAgentLaunchProgressed(
	pendingLaunch: PendingAgentLaunch,
	observedRunId: Id<'runs'> | null,
	observedClaimExpiresAt?: number,
	observedStartedAt?: number
): boolean {
	return Boolean(
		observedRunId &&
		(observedRunId !== pendingLaunch.previousRunId ||
			(observedClaimExpiresAt != null &&
				observedClaimExpiresAt !== pendingLaunch.previousClaimExpiresAt) ||
			(observedStartedAt != null && observedStartedAt !== pendingLaunch.previousStartedAt))
	);
}

export function resolvePendingAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	observedRunId: Id<'runs'> | null,
	observedClaimExpiresAt?: number,
	observedStartedAt?: number
): PendingAgentLaunches {
	const pendingLaunch = pendingLaunches[threadId];
	if (
		!pendingLaunch ||
		!hasAgentLaunchProgressed(
			pendingLaunch,
			observedRunId,
			observedClaimExpiresAt,
			observedStartedAt
		)
	) {
		return pendingLaunches;
	}

	return clearPendingAgentLaunch(pendingLaunches, threadId, pendingLaunch.launchId);
}

export function resolvePendingAgentLaunchesFromThreads(
	pendingLaunches: PendingAgentLaunches,
	threads: ThreadSummary[]
): PendingAgentLaunches {
	let nextPendingLaunches = pendingLaunches;

	for (const thread of threads) {
		nextPendingLaunches = resolvePendingAgentLaunch(
			nextPendingLaunches,
			thread.threadId,
			thread.latestRunId,
			thread.latestRunClaimExpiresAt
		);
	}

	return nextPendingLaunches;
}

export type ExpiredAgentLaunchResolution = {
	pendingLaunches: PendingAgentLaunches;
	shouldRecover: boolean;
};

export function resolveExpiredAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	launchId: number,
	now: number,
	latestRunId: Id<'runs'> | null,
	latestClaimExpiresAt?: number,
	latestStartedAt?: number
): ExpiredAgentLaunchResolution {
	const pendingLaunch = pendingLaunches[threadId];
	if (!pendingLaunch || pendingLaunch.launchId !== launchId || pendingLaunch.expiresAt > now) {
		return { pendingLaunches, shouldRecover: false };
	}

	return {
		pendingLaunches: clearPendingAgentLaunch(pendingLaunches, threadId, launchId),
		shouldRecover: !hasAgentLaunchProgressed(
			pendingLaunch,
			latestRunId,
			latestClaimExpiresAt,
			latestStartedAt
		)
	};
}

export function resolveProjectThreadSelection(args: {
	threads: ThreadSummary[];
	currentThreadId: Id<'threadRecords'> | null;
	currentWorkspacePath: string | null;
	draftWorkspacePath: string | null;
	pendingCreatedThreadId?: Id<'threadRecords'> | null;
}) {
	const {
		threads,
		currentThreadId,
		currentWorkspacePath,
		draftWorkspacePath,
		pendingCreatedThreadId = null
	} = args;

	if (currentWorkspacePath && draftWorkspacePath === currentWorkspacePath) {
		return null;
	}

	if (currentThreadId) {
		if (threads.some((thread) => thread.threadId === currentThreadId)) {
			return currentThreadId;
		}

		// Preserve an unknown ID only during the create → list catch-up window.
		if (pendingCreatedThreadId && currentThreadId === pendingCreatedThreadId) {
			return currentThreadId;
		}
	}

	return threads[0]?.threadId ?? null;
}
