import { act, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import ArtifactDisplay from './artifact-display';
import { ConvexTestClient, ConvexTestProvider, fixtureId } from '$lib/convex-test-client';
import { useArtifactContents } from '$lib/home/artifact-queries';

it('uses the live cloud source path for relative images in the artifact panel', () => {
	const artifact = {
		_id: fixtureId<'artifacts'>('notes'),
		_creationTime: 1,
		userId: 'user',
		scope: 'project',
		repositoryKey: 'project',
		registrationId: 'registration',
		type: 'markdown',
		title: 'notes.md',
		content: '![Board](./board.png)',
		sourcePath: 'docs/notes.md',
		revision: 1,
		updatedAt: 1
	} as const;

	const client = new ConvexTestClient();
	client.registerQuery(api.artifacts.getArtifact, artifact);

	function Panel() {
		const contents = useArtifactContents('project', [artifact._id]);

		return (
			<ArtifactDisplay
				title={artifact.title}
				artifactType="markdown"
				content={contents.get(artifact._id) ?? { status: 'loading' }}
				workspacePath="/tmp/project"
			/>
		);
	}

	render(
		<ConvexTestProvider client={client}>
			<Panel />
		</ConvexTestProvider>
	);

	const imageUrl = () =>
		new URL(
			screen.getByRole('button', { name: 'View Board' }).getAttribute('src') ?? '',
			'http://localhost'
		);

	expect(imageUrl().searchParams.get('workspacePath')).toBe('/tmp/project');
	expect(imageUrl().searchParams.get('path')).toBe('docs/./board.png');

	act(() => {
		client.registerQuery(api.artifacts.getArtifact, {
			...artifact,
			sourcePath: 'hardware/notes.md',
			revision: 2
		});
	});
	expect(imageUrl().searchParams.get('path')).toBe('hardware/./board.png');
});
