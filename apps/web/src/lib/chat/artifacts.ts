import type { ArtifactPreviewType } from './artifact-preview';
import type { ArtifactsWatchRequest } from '$lib/types/sprocket';

export type ArtifactEntry = {
	key: string;
	title: string;
	artifactType: ArtifactPreviewType;
};

export type ArtifactContent =
	| { status: 'loading' }
	| { status: 'ready'; content: string; sourcePath?: string }
	| { status: 'error'; error: string };

export function artifactWatchScopeKey(scope: ArtifactsWatchRequest): string {
	return [scope.userId, scope.repositoryKey, scope.workspacePath].join('\0');
}
