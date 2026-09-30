import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import ChatMarkdown from './chat-markdown';

const artifact: ArtifactEntry = {
	key: 'ks73zzsnfj2najtd871p43f45s8ec23d',
	title: 'About Me.md',
	artifactType: 'markdown',
	content: '# About me',
	scope: 'thread'
};

function renderChatMarkdown(props: {
	content: string;
	artifacts?: ArtifactEntry[];
	onOpenArtifact?: (artifactId: string) => void;
	openLinksInNewTab?: boolean;
}) {
	render(<ChatMarkdown {...props} />);
}

describe('links', () => {
	it('opens links in a new tab when requested', () => {
		renderChatMarkdown({
			content: '[Sprocket](https://sprocket.dev)',
			openLinksInNewTab: true
		});

		const link = document.querySelector('a');
		expect(link?.target).toBe('_blank');
		expect(link?.rel).toBe('noopener noreferrer');
	});
});

describe('artifact references', () => {
	it('shows the artifact title and opens it from the view button', () => {
		const onOpenArtifact = vi.fn();
		renderChatMarkdown({
			content: `Here it is.\n\nartifact:${artifact.key}`,
			artifacts: [artifact],
			onOpenArtifact
		});

		const reference = document.querySelector(`[data-artifact-reference="${artifact.key}"]`);
		expect(reference?.textContent).toContain('About Me.md');
		expect(reference?.textContent).toContain('Artifact · Thread');

		fireEvent.click(reference!.querySelector<HTMLButtonElement>('button')!);
		expect(onOpenArtifact).toHaveBeenCalledOnce();
		expect(onOpenArtifact).toHaveBeenCalledWith(artifact.key);
	});

	it('keeps an unavailable artifact reference as text', () => {
		renderChatMarkdown({
			content: 'artifact:missing',
			artifacts: [artifact],
			onOpenArtifact: vi.fn()
		});

		expect(document.querySelector('[data-artifact-reference]')).toBeNull();
		expect(document.body.textContent).toContain('artifact:missing');
	});
});
