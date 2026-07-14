export const RUN_CLAIM_LEASE_DURATION_MS = 60_000;
export const RUN_CLAIM_RENEW_INTERVAL_MS = 20_000;

type ClaimableRun = {
	status: string;
	claimId?: string;
	claimExpiresAt?: number;
};

export function isClaimedRunStatus(status: string): boolean {
	return status === 'running' || status === 'awaiting_executor';
}

export function isRunClaimLeaseActive(run: ClaimableRun, now: number): boolean {
	return (
		isClaimedRunStatus(run.status) && run.claimExpiresAt !== undefined && run.claimExpiresAt > now
	);
}

export function canStartRunWithClaim(run: ClaimableRun, claimId: string, now: number): boolean {
	if (run.status === 'queued') return true;
	if (!isClaimedRunStatus(run.status)) return false;
	if (run.claimId === claimId) return true;
	return !isRunClaimLeaseActive(run, now);
}

export function claimExpiresAt(now: number): number {
	return now + RUN_CLAIM_LEASE_DURATION_MS;
}
