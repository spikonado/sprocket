import { describe, expect, it } from 'vitest';
import {
	RUN_CLAIM_LEASE_DURATION_MS,
	canFinalizeAfterClaimFailure,
	canStartRunWithClaim,
	claimExpiresAt,
	isRunClaimLeaseActive
} from '@convex/lib/runLease';

describe('run claim leases', () => {
	it('claims queued runs and renews the current claim', () => {
		expect(canStartRunWithClaim({ status: 'queued' }, 'claim-a', 100)).toBe(true);
		expect(
			canStartRunWithClaim(
				{ status: 'running', claimId: 'claim-a', claimExpiresAt: 200 },
				'claim-a',
				200
			)
		).toBe(true);
		expect(claimExpiresAt(100)).toBe(100 + RUN_CLAIM_LEASE_DURATION_MS);
	});

	it('excludes a different claim until the lease expires', () => {
		const run = { status: 'running', claimId: 'claim-a', claimExpiresAt: 200 };
		expect(canStartRunWithClaim(run, 'claim-b', 199)).toBe(false);
		expect(canStartRunWithClaim(run, 'claim-b', 200)).toBe(true);
	});

	it.each(['running', 'awaiting_executor'] as const)(
		'recovers legacy %s rows without lease metadata',
		(status) => {
			expect(canStartRunWithClaim({ status, claimId: 'old-claim' }, 'claim-b', 100)).toBe(true);
		}
	);

	it('only reports an unexpired active-state lease as active', () => {
		expect(isRunClaimLeaseActive({ status: 'running', claimExpiresAt: 101 }, 100)).toBe(true);
		expect(isRunClaimLeaseActive({ status: 'running', claimExpiresAt: 100 }, 100)).toBe(false);
		expect(isRunClaimLeaseActive({ status: 'completed', claimExpiresAt: 200 }, 100)).toBe(false);
	});

	it('only terminalizes queued or same-claim state after claim uncertainty', () => {
		expect(canFinalizeAfterClaimFailure({ status: 'queued' }, 'claim-a')).toBe(true);
		expect(
			canFinalizeAfterClaimFailure(
				{ status: 'running', claimId: 'claim-a', claimExpiresAt: 200 },
				'claim-a'
			)
		).toBe(true);
		expect(
			canFinalizeAfterClaimFailure(
				{ status: 'awaiting_executor', claimId: 'claim-b', claimExpiresAt: 200 },
				'claim-a'
			)
		).toBe(false);
		expect(canFinalizeAfterClaimFailure({ status: 'failed', claimId: 'claim-a' }, 'claim-a')).toBe(
			false
		);
	});
});
