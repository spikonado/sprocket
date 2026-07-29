import { describe, expect, it } from 'vitest';
import {
	RUN_CLAIM_LEASE_DURATION_MS,
	canRegisterCompletionAttempt,
	ownsActiveRunClaim,
	canStartRunWithClaim,
	claimExpiresAt,
	isCurrentCompletionAttempt,
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

	it('only reports an unexpired active-state lease as active', () => {
		expect(isRunClaimLeaseActive({ status: 'running', claimExpiresAt: 101 }, 100)).toBe(true);
		expect(isRunClaimLeaseActive({ status: 'running', claimExpiresAt: 100 }, 100)).toBe(false);
		expect(isRunClaimLeaseActive({ status: 'completed', claimExpiresAt: 200 }, 100)).toBe(false);
	});

	it('treats a claimed run without claimExpiresAt as inactive and startable', () => {
		const run = { status: 'running', claimId: 'claim-a' };
		expect(isRunClaimLeaseActive(run, 100)).toBe(false);
		expect(canStartRunWithClaim(run, 'claim-b', 100)).toBe(true);
	});

	it('only treats a matching unexpired claim as active ownership', () => {
		const active = { status: 'running', claimId: 'claim-a', claimExpiresAt: 200 };
		expect(ownsActiveRunClaim({ status: 'queued' }, 'claim-a', 100)).toBe(false);
		expect(ownsActiveRunClaim(active, 'claim-a', 100)).toBe(true);
		expect(ownsActiveRunClaim(active, 'claim-b', 100)).toBe(false);
		expect(
			ownsActiveRunClaim(
				{ status: 'running', claimId: 'claim-a', claimExpiresAt: 100 },
				'claim-a',
				100
			)
		).toBe(false);
		expect(
			ownsActiveRunClaim(
				{ status: 'failed', claimId: 'claim-a', claimExpiresAt: 200 },
				'claim-a',
				100
			)
		).toBe(false);
	});

	it('only lets strictly newer completion attempts of the current claim take the stream', () => {
		const run = { claimId: 'claim-a', completionAttemptSeq: 2 };
		expect(canRegisterCompletionAttempt(run, 'claim-a', 3)).toBe(true);
		expect(canRegisterCompletionAttempt(run, 'claim-a', 2)).toBe(false);
		expect(canRegisterCompletionAttempt(run, 'claim-b', 3)).toBe(false);
		expect(
			canRegisterCompletionAttempt({ claimId: 'claim-a', completionAttemptSeq: 0 }, 'claim-a', 1)
		).toBe(true);
		expect(isCurrentCompletionAttempt(run, 'claim-a', 2)).toBe(true);
		expect(isCurrentCompletionAttempt(run, 'claim-a', 3)).toBe(false);
		expect(isCurrentCompletionAttempt(run, 'claim-b', 2)).toBe(false);
	});
});
