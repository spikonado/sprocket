import { describe, expect, it } from 'vitest';
import {
	ATTACHMENT_RETENTION_MS,
	lastActivityAt,
	shouldRetainAttachedStorage
} from './attachmentRetention';

describe('shouldRetainAttachedStorage', () => {
	const now = 10_000_000;

	it('keeps bytes while a run is active even if the thread looks old', () => {
		expect(
			shouldRetainAttachedStorage({
				now,
				updatedAt: 1,
				threadStatus: 'running',
				latestRunStatus: 'completed'
			})
		).toBe('retain');
		expect(
			shouldRetainAttachedStorage({
				now,
				updatedAt: 1,
				threadStatus: 'completed',
				latestRunStatus: 'queued'
			})
		).toBe('retain');
	});

	it('waits when last activity has not been backfilled', () => {
		expect(
			shouldRetainAttachedStorage({
				now,
				updatedAt: undefined,
				threadStatus: 'completed',
				latestRunStatus: 'completed'
			})
		).toBe('wait');
	});

	it('keeps bytes for a week after the last visible activity', () => {
		expect(
			shouldRetainAttachedStorage({
				now,
				updatedAt: now - ATTACHMENT_RETENTION_MS,
				threadStatus: 'completed',
				latestRunStatus: 'completed'
			})
		).toBe('retain');
		expect(
			shouldRetainAttachedStorage({
				now,
				updatedAt: now - ATTACHMENT_RETENTION_MS - 1,
				threadStatus: 'completed',
				latestRunStatus: 'completed'
			})
		).toBe('delete');
	});
});

describe('lastActivityAt', () => {
	it('uses the latest real timestamp instead of a deploy-time grace period', () => {
		expect(
			lastActivityAt({
				lastMessageAt: 100,
				createdAt: 50,
				latestPartCreatedAt: 250,
				latestRunActivityAt: 200
			})
		).toBe(250);
		expect(
			lastActivityAt({
				lastMessageAt: 100,
				createdAt: 50
			})
		).toBe(100);
		expect(lastActivityAt({ lastMessageAt: 100, createdAt: 50 })).not.toBe(
			100 + ATTACHMENT_RETENTION_MS
		);
	});
});
