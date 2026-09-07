import { describe, expect, it } from 'vitest';
import { defaultModelId, defaultReasoningEffort, defaultServiceTier } from '$convex/lib/models';
import type { Id } from '$convex/_generated/dataModel';
import type { ProjectState } from '$lib/home/desktop';
import { advanceHostedEpoch, beginHostedOp } from '$lib/home/hosted-machines';
import {
	getHostedProjectThreadGroups,
	hostedExecutionProject,
	hostedInitialSelectionReady,
	hostedLaunchWorkspaceIsSafe,
	hostedThreadWorkspacePath,
	isHostedVirtualWorkspacePath,
	mergeHostedBrowsableProjects,
	shouldVerifyHostedWorkspace,
	virtualWorkspacePath,
	workspaceAfterHostedMachineChange
} from '$lib/home/hosted-projects';
import type { ThreadSummary } from '$lib/types/sprocket';

function threadId(value: string): ThreadSummary['threadId'] {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

function project(
	overrides: Partial<ProjectState> & Pick<ProjectState, 'repositoryKey'>
): ProjectState {
	return {
		displayName: overrides.displayName ?? overrides.repositoryKey,
		workspacePath: overrides.workspacePath ?? `/workspaces/${overrides.repositoryKey}`,
		localAttachmentAvailability: overrides.localAttachmentAvailability ?? 'available',
		...overrides
	};
}

function thread(
	overrides: Partial<ThreadSummary> & Pick<ThreadSummary, 'repositoryKey'>
): ThreadSummary {
	return {
		threadId: overrides.threadId ?? threadId(`thread-${overrides.repositoryKey}`),
		title: 'Thread',
		selectedModel: defaultModelId,
		reasoningEffort: defaultReasoningEffort,
		serviceTier: defaultServiceTier,
		lastMessageAt: 1,
		threadStatus: 'active',
		status: 'completed',
		...overrides
	};
}

describe('hosted browsable projects', () => {
	it('keeps legacy threads without a repository identity readable but not executable', () => {
		const legacy = thread({ repositoryKey: '' });
		const groups = getHostedProjectThreadGroups({
			attachedProjects: [],
			threads: [legacy],
			hasReadyMachine: false
		});
		expect(groups[0]?.project.displayName).toBe('Unassigned threads');
		expect(groups[0]?.threads).toEqual([legacy]);
		expect(hostedExecutionProject({ repositoryKey: '', attachedProjects: [] })).toBeNull();
	});

	it('keeps executable attachments and adds virtual groups for other cloud threads', () => {
		const attached = [
			project({
				repositoryKey: 'alpha',
				workspacePath: '/machines/a/alpha'
			})
		];
		const threads = [
			thread({ repositoryKey: 'alpha' }),
			thread({ repositoryKey: 'beta', lastMessageAt: 4 }),
			thread({
				repositoryKey: 'beta',
				threadId: threadId('thread-beta-2'),
				lastMessageAt: 8
			}),
			thread({
				repositoryKey: 'archived',
				threadStatus: 'archived'
			})
		];

		const merged = mergeHostedBrowsableProjects({
			attachedProjects: attached,
			threads,
			hasReadyMachine: true
		});

		expect(merged.map((entry) => entry.workspacePath)).toEqual([
			'/machines/a/alpha',
			virtualWorkspacePath('beta')
		]);
		expect(merged[1]?.localAttachmentAvailability).toBe('unavailable');
		expect(merged[1]?.localAttachmentError).toMatch(/Attach a folder/);

		const groups = getHostedProjectThreadGroups({
			attachedProjects: attached,
			threads,
			hasReadyMachine: false
		});
		expect(groups).toHaveLength(2);
		expect(groups[0]?.threads).toHaveLength(1);
		expect(groups[1]?.threads.map((entry) => entry.threadId)).toEqual([
			'thread-beta-2',
			'thread-beta'
		]);
		expect(groups[1]?.project.localAttachmentError).toMatch(/Choose a running machine/);
	});

	it('still groups cloud threads when no machine is selected', () => {
		const groups = getHostedProjectThreadGroups({
			attachedProjects: [],
			threads: [thread({ repositoryKey: 'solo' })],
			hasReadyMachine: false
		});

		expect(groups).toHaveLength(1);
		expect(isHostedVirtualWorkspacePath(groups[0]?.project.workspacePath)).toBe(true);
		expect(hostedExecutionProject({ repositoryKey: 'solo', attachedProjects: [] })).toBeNull();
	});
});

describe('hosted execution workspace', () => {
	it('runs an existing thread only on a matching attached workspace', () => {
		const matching = project({
			repositoryKey: 'alpha',
			workspacePath: '/machines/b/alpha'
		});
		const other = project({
			repositoryKey: 'beta',
			workspacePath: '/machines/b/beta'
		});
		const missing = project({
			repositoryKey: 'alpha',
			workspacePath: '/machines/b/stale-alpha',
			localAttachmentAvailability: 'unavailable'
		});

		expect(
			hostedExecutionProject({
				repositoryKey: 'alpha',
				attachedProjects: [other, missing]
			})
		).toBeNull();
		expect(
			hostedExecutionProject({
				repositoryKey: 'alpha',
				attachedProjects: [other, missing, matching]
			})?.workspacePath
		).toBe('/machines/b/alpha');
	});

	it('drops the previous machine path immediately and keeps the open thread', () => {
		const withThread = workspaceAfterHostedMachineChange({
			currentThreadId: 'thread-1',
			currentRepositoryKey: 'alpha'
		});
		expect(withThread.keepThread).toBe(true);
		expect(isHostedVirtualWorkspacePath(withThread.workspacePath)).toBe(true);
		expect(withThread.workspacePath).not.toContain('/machines/');

		expect(
			workspaceAfterHostedMachineChange({
				currentThreadId: null,
				currentRepositoryKey: 'alpha'
			})
		).toEqual({ workspacePath: null, keepThread: false });
	});

	it('prefers the selected machine matching folder over a virtual browse group', () => {
		const attached = [
			project({
				repositoryKey: 'alpha',
				workspacePath: '/machines/b/alpha'
			})
		];
		const browsable = mergeHostedBrowsableProjects({
			attachedProjects: attached,
			threads: [thread({ repositoryKey: 'alpha' }), thread({ repositoryKey: 'beta' })],
			hasReadyMachine: true
		});

		expect(
			hostedThreadWorkspacePath({
				threadRepositoryKey: 'alpha',
				currentWorkspacePath: virtualWorkspacePath('alpha'),
				attachedProjects: attached,
				browsableProjects: browsable
			})
		).toBe('/machines/b/alpha');
		expect(
			hostedThreadWorkspacePath({
				threadRepositoryKey: 'beta',
				currentWorkspacePath: virtualWorkspacePath('beta'),
				attachedProjects: attached,
				browsableProjects: browsable
			})
		).toBe(virtualWorkspacePath('beta'));
	});

	it('refuses a launch whose machine or workspace is no longer current', () => {
		const attached = [
			project({
				repositoryKey: 'alpha',
				workspacePath: '/machines/b/alpha'
			})
		];
		const opB = beginHostedOp(2);

		expect(
			hostedLaunchWorkspaceIsSafe({
				op: beginHostedOp(1),
				currentEpoch: 2,
				machineId: 'b',
				workspacePath: '/machines/b/alpha',
				attachedProjects: attached
			})
		).toBe(false);
		expect(
			hostedLaunchWorkspaceIsSafe({
				op: opB,
				currentEpoch: 2,
				machineId: 'b',
				workspacePath: '/machines/a/alpha',
				attachedProjects: attached
			})
		).toBe(false);
		expect(
			hostedLaunchWorkspaceIsSafe({
				op: opB,
				currentEpoch: 2,
				machineId: 'b',
				workspacePath: virtualWorkspacePath('alpha'),
				attachedProjects: attached
			})
		).toBe(false);
		expect(
			hostedLaunchWorkspaceIsSafe({
				op: opB,
				currentEpoch: 2,
				machineId: 'b',
				workspacePath: '/machines/b/alpha',
				attachedProjects: attached
			})
		).toBe(true);
		expect(
			hostedLaunchWorkspaceIsSafe({
				op: beginHostedOp(1),
				currentEpoch: 2,
				machineId: 'b',
				workspacePath: '/shared/alpha',
				attachedProjects: [
					project({
						repositoryKey: 'alpha',
						workspacePath: '/shared/alpha'
					})
				]
			})
		).toBe(false);
		expect(
			hostedLaunchWorkspaceIsSafe({
				op: opB,
				currentEpoch: 2,
				machineId: null,
				workspacePath: '/machines/b/alpha',
				attachedProjects: attached
			})
		).toBe(false);
	});

	it('drops A→B→A launches even when A is attached again', () => {
		const attachedOnA = [
			project({
				repositoryKey: 'alpha',
				workspacePath: '/machines/a/alpha'
			})
		];
		let epoch = 1;
		const pendingOnA = beginHostedOp(epoch);
		epoch = advanceHostedEpoch(epoch);
		epoch = advanceHostedEpoch(epoch);

		expect(
			hostedLaunchWorkspaceIsSafe({
				op: pendingOnA,
				currentEpoch: epoch,
				machineId: 'a',
				workspacePath: '/machines/a/alpha',
				attachedProjects: attachedOnA
			})
		).toBe(false);
		expect(
			hostedLaunchWorkspaceIsSafe({
				op: beginHostedOp(epoch),
				currentEpoch: epoch,
				machineId: 'a',
				workspacePath: '/machines/a/alpha',
				attachedProjects: attachedOnA
			})
		).toBe(true);
	});

	it('lets thread restore proceed without a machine once snapshots are ready', () => {
		expect(
			hostedInitialSelectionReady({
				threadSnapshotReady: true,
				selectedMachineId: null,
				attachmentsReady: false
			})
		).toBe(true);
		expect(
			hostedInitialSelectionReady({
				threadSnapshotReady: true,
				selectedMachineId: 'laptop',
				attachmentsReady: false
			})
		).toBe(false);
		expect(
			hostedInitialSelectionReady({
				threadSnapshotReady: false,
				selectedMachineId: null,
				attachmentsReady: true
			})
		).toBe(false);
	});

	it('does not verify virtual browse groups', () => {
		expect(
			shouldVerifyHostedWorkspace(
				project({
					repositoryKey: 'alpha',
					workspacePath: '/machines/a/alpha'
				})
			)
		).toBe(true);
		expect(
			shouldVerifyHostedWorkspace(
				project({
					repositoryKey: 'beta',
					workspacePath: virtualWorkspacePath('beta'),
					localAttachmentAvailability: 'unavailable'
				})
			)
		).toBe(false);
	});
});
