export const RUN_CLAIM_LEASE_DURATION_MS = 60_000;

type ClaimableRun = {
	status: string;
	claimId?: string;
	claimExpiresAt?: number;
};

type CompletionAttemptRun = {
	claimId?: string;
	completionAttemptSeq: number;
};

export function isClaimedRunStatus(status: string): boolean {
	return status === 'running' || status === 'awaiting_executor';
}

export function isRunClaimLeaseActive(run: ClaimableRun, now: number): boolean {
	if (!isClaimedRunStatus(run.status)) return false;
	return run.claimExpiresAt !== undefined && run.claimExpiresAt > now;
}

export function canStartRunWithClaim(run: ClaimableRun, claimId: string, now: number): boolean {
	if (run.status === 'queued') return true;
	if (!isClaimedRunStatus(run.status)) return false;
	if (run.claimId === claimId) return true;
	return !isRunClaimLeaseActive(run, now);
}

export function ownsActiveRunClaim(run: ClaimableRun, claimId: string, now: number): boolean {
	return run.claimId === claimId && isRunClaimLeaseActive(run, now);
}

export function canFinalizeAfterClaimFailure(
	run: ClaimableRun,
	claimId: string,
	now: number
): boolean {
	return ownsActiveRunClaim(run, claimId, now);
}

export function claimExpiresAt(now: number): number {
	return now + RUN_CLAIM_LEASE_DURATION_MS;
}

// Registering a completion attempt requires a strictly newer sequence than the
// current one; ownership checks afterwards require exactly the current one.
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
