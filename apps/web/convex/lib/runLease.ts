import { agentError, assertRunAcceptsModelCompletion } from '@convex/lib/agentErrors';
import type { vRunStatus } from '@convex/lib/validators';
import type { Infer } from 'convex/values';

export const RUN_CLAIM_LEASE_DURATION_MS = 120_000;

export const RUN_QUEUED_STARTUP_DEADLINE_MS = 45_000;

type ClaimableRun = {
	status: string;
	claimId?: string;
	claimExpiresAt?: number;
	cancellationRequestedAt?: number;
};

type CompletionAttemptRun = {
	claimId?: string;
	completionAttemptSeq: number;
};

export function isClaimedRunStatus(status: string): boolean {
	return status === 'running';
}

export function isRunClaimLeaseActive(run: ClaimableRun, now: number): boolean {
	if (!isClaimedRunStatus(run.status)) return false;

	return run.claimExpiresAt !== undefined && run.claimExpiresAt > now;
}

export function canStartRunWithClaim(run: ClaimableRun, claimId: string, now: number): boolean {
	if (run.cancellationRequestedAt !== undefined) return false;

	if (run.status === 'queued') return true;

	return (
		isClaimedRunStatus(run.status) && run.claimId === claimId && isRunClaimLeaseActive(run, now)
	);
}

export function ownsActiveRunClaim(run: ClaimableRun, claimId: string, now: number): boolean {
	return run.claimId === claimId && isRunClaimLeaseActive(run, now);
}

/** Wind-down calls such as lease renewal and tool results use `ownsActiveRunClaim` instead. */
export function runAcceptsNewWork(run: ClaimableRun, claimId: string, now: number): boolean {
	return run.cancellationRequestedAt === undefined && ownsActiveRunClaim(run, claimId, now);
}

export function assertRunAcceptsWork(
	run: ClaimableRun & { status: Infer<typeof vRunStatus> },
	claimId: string,
	now: number
): void {
	assertRunAcceptsModelCompletion(run);

	if (!ownsActiveRunClaim(run, claimId, now)) {
		throw agentError('RUN_NO_LONGER_ACTIVE');
	}
}

export function canFinalizeAfterClaimFailure(run: ClaimableRun, claimId: string): boolean {
	// Requiring an active lease here would strand runs whose executor only
	// reports the failure after expiry. No other executor can claim the run
	// meanwhile; an expired claim can only be abandoned.
	return isClaimedRunStatus(run.status) && run.claimId === claimId;
}

export function claimExpiresAt(now: number): number {
	return now + RUN_CLAIM_LEASE_DURATION_MS;
}

export function canRegisterCompletionAttempt(
	run: CompletionAttemptRun,
	claimId: string,
	attemptSeq: number
): boolean {
	return run.claimId === claimId && attemptSeq > run.completionAttemptSeq;
}

export function isCurrentCompletionAttempt(
	run: CompletionAttemptRun,
	claimId: string,
	attemptSeq: number
): boolean {
	return run.claimId === claimId && run.completionAttemptSeq === attemptSeq;
}
