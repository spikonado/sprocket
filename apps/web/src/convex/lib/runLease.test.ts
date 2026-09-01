import { describe, expect, it } from 'vitest';
import {
	canFinalizeAfterClaimFailure,
	canRegisterCompletionAttempt,
	ownsActiveRunClaim,
	canStartRunWithClaim,
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
				199
			)
		).toBe(true);
	});

	it('does not claim a run after cancellation is requested', () => {
		expect(
			canStartRunWithClaim(
				{ status: 'queued', cancellationRequestedAt: 100 },
				'claim-a',
				101
			)
		).toBe(false);
	});

	it('never transfers a claimed run to a different claim', () => {
		const run = { status: 'running', claimId: 'claim-a', claimExpiresAt: 200 };
		expect(canStartRunWithClaim(run, 'claim-b', 199)).toBe(false);
		expect(canStartRunWithClaim(run, 'claim-b', 200)).toBe(false);
	});

	it('only reports an unexpired active-state lease as active', () => {
		expect(isRunClaimLeaseActive({ status: 'running', claimExpiresAt: 101 }, 100)).toBe(true);
		expect(isRunClaimLeaseActive({ status: 'running', claimExpiresAt: 100 }, 100)).toBe(false);
		expect(isRunClaimLeaseActive({ status: 'completed', claimExpiresAt: 200 }, 100)).toBe(false);
	});

	it('does not restart a claimed run whose lease is missing', () => {
		const run = { status: 'running', claimId: 'claim-a' };
		expect(isRunClaimLeaseActive(run, 100)).toBe(false);
		expect(canStartRunWithClaim(run, 'claim-a', 100)).toBe(false);
		expect(canStartRunWithClaim(run, 'claim-b', 100)).toBe(false);
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

	it('lets the current claim owner terminalize its run even after the lease lapses', () => {
		const expired = { status: 'awaiting_executor', claimId: 'claim-a', claimExpiresAt: 100 };
		expect(canFinalizeAfterClaimFailure(expired, 'claim-a')).toBe(true);
		expect(canFinalizeAfterClaimFailure(expired, 'claim-b')).toBe(false);
		expect(canFinalizeAfterClaimFailure({ status: 'failed', claimId: 'claim-a' }, 'claim-a')).toBe(
			false
		);
		expect(canFinalizeAfterClaimFailure({ status: 'queued' }, 'claim-a')).toBe(false);
	});
});
