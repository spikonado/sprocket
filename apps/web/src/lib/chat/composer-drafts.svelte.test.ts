import { afterEach, expect, it, vi } from 'vitest';
import {
	composerDraftKey,
	completeComposerDraft,
	loadComposerDraft,
	saveComposerDraft,
	updateDraftAttachment,
	type ComposerDraft
} from './composer-drafts';

afterEach(() => {
	localStorage.clear();
	vi.useRealTimers();
});

function draft(prompt: string): ComposerDraft {
	return {
		prompt,
		repositoryKey: 'repo',
		selectedModel: 'model',
		reasoningEffort: 'high',
		fastMode: false,
		attachments: []
	};
}

it('keeps create and reply drafts isolated across accounts', () => {
	const create = composerDraftKey('alice', null);
	const reply = composerDraftKey('alice', 'thread');
	saveComposerDraft(create, draft('New work'));
	saveComposerDraft(reply, draft('A reply'));
	saveComposerDraft(reply, { ...draft(''), repositoryKey: 'different' });
	expect(loadComposerDraft(create)?.prompt).toBe('New work');
	expect(loadComposerDraft(composerDraftKey('bob', null))).toBeNull();
});

it('keeps edits and new files made while a submission was in flight', () => {
	const file = {
		localId: 'sent',
		name: 'plan.txt',
		mediaType: 'text/plain',
		size: 12,
		fileSaved: true,
		status: 'ready' as const
	};
	const submitted = { ...draft('Send me'), attachments: [file] };
	const edited = {
		...submitted,
		prompt: 'Next task',
		attachments: [file, { ...file, localId: 'new' }]
	};
	expect(completeComposerDraft(edited, submitted)).toMatchObject({
		prompt: 'Next task',
		attachments: [{ localId: 'new' }]
	});
	expect(completeComposerDraft(submitted, submitted)).toMatchObject({
		prompt: '',
		attachments: []
	});
});

it('keeps the prompt and local files if the create draft moved to another project', () => {
	const submitted = {
		...draft('Send me'),
		attachments: [
			{
				localId: 'sent',
				name: 'plan.txt',
				mediaType: 'text/plain',
				size: 12,
				fileSaved: true,
				status: 'ready' as const
			}
		]
	};
	const moved = { ...submitted, repositoryKey: 'another-project' };
	expect(completeComposerDraft(moved, submitted)).toMatchObject({
		repositoryKey: 'another-project',
		prompt: 'Send me',
		attachments: [{ localId: 'sent', status: 'uploading', fileSaved: true, storageId: undefined }]
	});
});

it('restores draft metadata after restart and reuploads expired attachments from local files', () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
	const key = composerDraftKey('restart', null);
	localStorage.setItem(
		key,
		JSON.stringify({
			...draft('Keep me'),
			attachments: [
				{
					localId: 'file',
					name: 'plan.txt',
					mediaType: 'text/plain',
					size: 12,
					storageId: 'old-upload',
					uploadedAt: Date.now() - 24 * 3_600_000,
					fileSaved: true
				}
			]
		})
	);
	expect(loadComposerDraft(key)).toMatchObject({
		prompt: 'Keep me',
		attachments: [{ status: 'uploading', storageId: undefined, fileSaved: true }]
	});
});

it('routes a late upload to its original draft without reviving removed attachments', () => {
	const key = composerDraftKey('uploads', 'first');
	saveComposerDraft(key, {
		...draft(''),
		attachments: [
			{ localId: 'file', name: 'plan.txt', mediaType: 'text/plain', size: 12, status: 'uploading' }
		]
	});
	expect(updateDraftAttachment(key, 'file', { fileSaved: true })).toBe(true);
	expect(loadComposerDraft(key)?.attachments[0]?.fileSaved).toBe(true);
	saveComposerDraft(key, draft('Cleared'));
	expect(updateDraftAttachment(key, 'file', { status: 'ready' })).toBe(false);
	expect(loadComposerDraft(key)?.attachments).toEqual([]);
});
