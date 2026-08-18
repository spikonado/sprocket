import type { Id } from '$convex/_generated/dataModel';
import type { Project, ThreadSummary, ProjectThreadGroup } from '$lib/types/sprocket';

export function findProjectByRepositoryKey<T extends Pick<Project, 'repositoryKey'>>(
	projects: T[],
	repositoryKey: string
): T | null {
	return projects.find((project) => project.repositoryKey === repositoryKey) ?? null;
}

export function findProjectById<T extends Pick<Project, '_id'>>(
	projects: T[],
	projectId: Id<'projects'> | null | undefined
): T | null {
	if (!projectId) {
		return null;
	}
	return projects.find((project) => project._id === projectId) ?? null;
}

/** True when a draft send should land on a new project because the path's git remote changed. */
export function shouldForkProjectForRemoteChange(
	selectedRepositoryKey: string,
	resolvedRepositoryKey: string
) {
	return (
		selectedRepositoryKey.trim().length > 0 &&
		resolvedRepositoryKey.trim().length > 0 &&
		selectedRepositoryKey !== resolvedRepositoryKey
	);
}

export function isActiveThread(thread: Pick<ThreadSummary, 'threadStatus'>) {
	return thread.threadStatus !== 'archived';
}

function unknownProject(projectId: Id<'projects'>): Project {
	return {
		_id: projectId,
		userId: '',
		repositoryKey: 'unknown',
		displayName: 'Unknown project',
		localAttachmentAvailability: 'unlinked'
	};
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
	const threadsByProjectId = new Map<Id<'projects'>, ThreadSummary[]>();

	for (const thread of threads.filter(isActiveThread)) {
		const existing = threadsByProjectId.get(thread.projectId);
		if (existing) {
			existing.push(thread);
			continue;
		}
		threadsByProjectId.set(thread.projectId, [thread]);
	}

	const groups: ProjectThreadGroup[] = [];

	for (const project of projects) {
		groups.push(buildProjectThreadGroup(project, threadsByProjectId.get(project._id) ?? []));
		threadsByProjectId.delete(project._id);
	}

	for (const [projectId, projectThreads] of threadsByProjectId) {
		groups.push(buildProjectThreadGroup(unknownProject(projectId), projectThreads));
	}

	// Preserve the project order supplied by `projects.listMine` (creation,
	// newest first). Thread activity reorders threads within a project, never
	// the projects themselves.
	return groups;
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
): PendingAgentLaunches {
	return { ...pendingLaunches, [threadId]: launch };
}

export function clearPendingAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	launchId?: number
): PendingAgentLaunches {
	const pendingLaunch = pendingLaunches[threadId];
	if (!pendingLaunch || (launchId !== undefined && pendingLaunch.launchId !== launchId)) {
		return pendingLaunches;
	}

	const nextPendingLaunches = { ...pendingLaunches };
	delete nextPendingLaunches[threadId];
	return nextPendingLaunches;
}

function hasAgentLaunchProgressed(
	pendingLaunch: PendingAgentLaunch,
	observedRunId: Id<'runs'> | null,
	observedClaimExpiresAt?: number
): boolean {
	return Boolean(
		observedRunId &&
		(observedRunId !== pendingLaunch.previousRunId ||
			observedClaimExpiresAt !== pendingLaunch.previousClaimExpiresAt)
	);
}

export function resolvePendingAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	observedRunId: Id<'runs'> | null,
	observedClaimExpiresAt?: number
): PendingAgentLaunches {
	const pendingLaunch = pendingLaunches[threadId];
	if (
		!pendingLaunch ||
		!hasAgentLaunchProgressed(pendingLaunch, observedRunId, observedClaimExpiresAt)
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

export function resolveExpiredAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	launchId: number,
	now: number,
	latestRunId: Id<'runs'> | null,
	latestClaimExpiresAt?: number
): { pendingLaunches: PendingAgentLaunches; shouldRecover: boolean } {
	const pendingLaunch = pendingLaunches[threadId];
	if (!pendingLaunch || pendingLaunch.launchId !== launchId || pendingLaunch.expiresAt > now) {
		return { pendingLaunches, shouldRecover: false };
	}

	return {
		pendingLaunches: clearPendingAgentLaunch(pendingLaunches, threadId, launchId),
		shouldRecover: !hasAgentLaunchProgressed(pendingLaunch, latestRunId, latestClaimExpiresAt)
	};
}

export function resolveProjectThreadSelection(args: {
	threads: ThreadSummary[];
	currentThreadId: Id<'threadRecords'> | null;
	currentRepositoryKey: string | null;
	draftRepositoryKey: string | null;
	pendingCreatedThreadId?: Id<'threadRecords'> | null;
}) {
	const {
		threads,
		currentThreadId,
		currentRepositoryKey,
		draftRepositoryKey,
		pendingCreatedThreadId = null
	} = args;

	if (currentRepositoryKey && draftRepositoryKey === currentRepositoryKey) {
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
