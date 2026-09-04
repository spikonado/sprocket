import type { Doc, Id } from '$convex/_generated/dataModel';
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
	status: ThreadSummary['status'];
};

export function toThreadSummary(row: ThreadSummaryRow): ThreadSummary {
	return {
		threadId: row.threadId,
		repositoryKey: row.repositoryKey ?? '',
		title: row.title,
		selectedModel: row.selectedModel,
		reasoningEffort: row.reasoningEffort,
		serviceTier: row.serviceTier,
		lastMessageAt: row.lastMessageAt,
		threadStatus: row.threadStatus,
		status: row.status
	};
}

export function threadRecordToSummary(record: Doc<'threadRecords'>): ThreadSummary {
	return toThreadSummary({
		threadId: record._id,
		repositoryKey: record.repositoryKey ?? '',
		title: record.title ?? 'New thread',
		selectedModel: record.selectedModel,
		reasoningEffort: record.reasoningEffort,
		serviceTier: record.serviceTier,
		lastMessageAt: record.lastMessageAt,
		threadStatus: record.archivedAt === undefined ? 'active' : 'archived',
		status: record.status ?? 'completed'
	});
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

export function hasActiveRun(thread: Pick<ThreadSummary, 'status'>) {
	return (
		thread.status === 'queued' ||
		thread.status === 'running' ||
		thread.status === 'awaiting_executor'
	);
}

function sortThreadsRunningFirst(threads: ThreadSummary[]) {
	return [...threads].sort((left, right) => {
		if (hasActiveRun(left) !== hasActiveRun(right)) {
			return Number(hasActiveRun(right)) - Number(hasActiveRun(left));
		}

		return right.lastMessageAt - left.lastMessageAt;
	});
}

function countActiveThreads(threads: ThreadSummary[]) {
	return threads.filter(hasActiveRun).length;
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
	if (!pendingCreatedThreadId || findThreadById(threads, pendingCreatedThreadId)) {
		return null;
	}

	return pendingCreatedThreadId;
}

const PLACEHOLDER_THREAD_TITLE = 'New thread';
const MAX_THREAD_TITLE_LENGTH = 72;

export function threadTitleFromPrompt(prompt: string) {
	return prompt.trim().slice(0, MAX_THREAD_TITLE_LENGTH) || PLACEHOLDER_THREAD_TITLE;
}

export function isPlaceholderThreadTitle(title: string) {
	const trimmed = title.trim();
	return trimmed === '' || trimmed === PLACEHOLDER_THREAD_TITLE;
}

export function makeUnconfirmedCreatedThread(args: {
	threadId: ThreadSummary['threadId'];
	repositoryKey: string;
	selectedModel: ThreadSummary['selectedModel'];
	reasoningEffort: ThreadSummary['reasoningEffort'];
	serviceTier: ThreadSummary['serviceTier'];
	title?: string;
	lastMessageAt?: number;
}): ThreadSummary {
	return toThreadSummary({
		threadId: args.threadId,
		repositoryKey: args.repositoryKey,
		title: threadTitleFromPrompt(args.title ?? ''),
		selectedModel: args.selectedModel,
		reasoningEffort: args.reasoningEffort,
		serviceTier: args.serviceTier,
		lastMessageAt: args.lastMessageAt ?? Date.now(),
		threadStatus: 'active',
		status: 'queued'
	});
}

function needsUnconfirmedTitleOverlay(existing: ThreadSummary, unconfirmed: ThreadSummary) {
	return isPlaceholderThreadTitle(existing.title) && !isPlaceholderThreadTitle(unconfirmed.title);
}

export function mergeUnconfirmedCreatedThread(
	threads: ThreadSummary[],
	unconfirmed: ThreadSummary | null
): ThreadSummary[] {
	if (!unconfirmed) {
		return threads;
	}
	const existing = findThreadById(threads, unconfirmed.threadId);
	if (!existing) {
		return [unconfirmed, ...threads];
	}
	if (needsUnconfirmedTitleOverlay(existing, unconfirmed)) {
		return threads.map((thread) =>
			thread.threadId === existing.threadId ? { ...thread, title: unconfirmed.title } : thread
		);
	}
	return threads;
}

export function shouldDropUnconfirmedCreatedThread(
	threads: ThreadSummary[],
	unconfirmed: ThreadSummary | null
) {
	if (!unconfirmed) {
		return false;
	}
	const existing = findThreadById(threads, unconfirmed.threadId);
	if (!existing) {
		return false;
	}
	return !needsUnconfirmedTitleOverlay(existing, unconfirmed);
}

export function retainUnconfirmedCreatedThreads(
	threads: ThreadSummary[],
	unconfirmed: ThreadSummary[]
) {
	return unconfirmed.filter((row) => !shouldDropUnconfirmedCreatedThread(threads, row));
}

export function mergeUnconfirmedCreatedThreads(
	threads: ThreadSummary[],
	unconfirmed: ThreadSummary[]
) {
	return unconfirmed.reduce((list, row) => mergeUnconfirmedCreatedThread(list, row), threads);
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
	const { threads, currentThreadId, currentWorkspacePath, draftWorkspacePath } = args;

	if (currentWorkspacePath && draftWorkspacePath === currentWorkspacePath) {
		return null;
	}

	if (currentThreadId) {
		return currentThreadId;
	}

	return threads[0]?.threadId ?? null;
}
