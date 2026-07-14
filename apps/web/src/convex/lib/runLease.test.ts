import { describe, expect, it } from 'vitest';
import {
	RUN_CLAIM_LEASE_DURATION_MS,
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

	it('recovers legacy active rows without lease metadata', () => {
		expect(canStartRunWithClaim({ status: 'running', claimId: 'old-claim' }, 'claim-b', 100)).toBe(
			true
		);
		expect(
			canStartRunWithClaim({ status: 'awaiting_executor', claimId: 'old-claim' }, 'claim-b', 100)
		).toBe(true);
	});

	it('only reports an unexpired active-state lease as active', () => {
		expect(isRunClaimLeaseActive({ status: 'running', claimExpiresAt: 101 }, 100)).toBe(true);
		expect(isRunClaimLeaseActive({ status: 'running', claimExpiresAt: 100 }, 100)).toBe(false);
		expect(isRunClaimLeaseActive({ status: 'completed', claimExpiresAt: 200 }, 100)).toBe(false);
	});
});
