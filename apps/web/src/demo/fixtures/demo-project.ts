import type { ArtifactContent, ArtifactEntry } from '$lib/chat/artifacts';
import { artifactPreviewType } from '$lib/chat/artifact-preview';
import type { Project } from '$lib/types/sprocket';
import type { DemoWorkspace, WorkspaceFiles } from '../workspace-api';
import type { DemoThread } from './types';

export type DemoProject = {
	project: Project;
	workspace: DemoWorkspace;
	artifacts: ArtifactEntry[];
	artifactContents: Map<string, ArtifactContent>;
	threads: DemoThread[];
};

type ProjectSpec = {
	name: string;
	files: Record<string, string>;
	/** Files too large to bundle up front, loaded when opened. */
	lazyFiles?: WorkspaceFiles;
	boards?: DemoWorkspace['boards'];
	gitStatus?: DemoWorkspace['gitStatus'];
	/** Workspace files the threads bound as artifacts. */
	artifacts?: { key: string; title: string; path: string }[];
	threads: DemoThread[];
};

export function demoProject({
	name,
	files,
	lazyFiles = {},
	boards = {},
	gitStatus = [],
	artifacts = [],
	threads
}: ProjectSpec): DemoProject {
	return {
		project: {
			repositoryKey: `github.com/maker/${name}`,
			displayName: name,
			workspacePath: `/home/maker/${name}`,
			localAttachmentAvailability: 'available'
		},
		workspace: {
			files: {
				...Object.fromEntries(
					Object.entries(files).map(([path, text]) => [path, async () => text])
				),
				...lazyFiles
			},
			boards,
			gitStatus
		},
		artifacts: artifacts.map(({ key, title }) => ({
			key,
			title,
			artifactType: artifactPreviewType(title)
		})),
		artifactContents: new Map(
			artifacts.map(({ key, path }) => {
				const content = files[path];

				if (content === undefined) throw new Error(`Artifact ${key} has no file at ${path}.`);

				return [key, { status: 'ready', content, sourcePath: path }];
			})
		),
		threads
	};
}
