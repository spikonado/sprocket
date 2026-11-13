import { useEffect, useMemo } from 'react';
import {
	usePaginatedQuery_experimental as usePaginatedQueryResult,
	useQueries
} from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { artifactPreviewType } from '$lib/chat/artifact-preview';
import type { ArtifactContent, ArtifactEntry } from '$lib/chat/artifacts';
import { convexId } from '$lib/convex-id';

const ARTIFACT_PAGE_SIZE = 50;

export type ArtifactList = {
	artifacts: ArtifactEntry[];
	loading: boolean;
	error: string | null;
};

/** Loads every page, so artifact cards in the transcript resolve against the full list. */
export function useArtifactList(repositoryKey: string | null): ArtifactList {
	const query = usePaginatedQueryResult({
		query: api.artifacts.listArtifactMetadata,
		args: repositoryKey === null ? 'skip' : { repositoryKey },
		initialNumItems: ARTIFACT_PAGE_SIZE
	});

	const { data, canLoadMore, loadMore } = query;

	useEffect(() => {
		if (canLoadMore) loadMore(ARTIFACT_PAGE_SIZE);
	}, [canLoadMore, loadMore]);

	const artifacts = useMemo(
		() =>
			(data ?? []).map(({ _id, title }) => ({
				key: _id,
				title,
				artifactType: artifactPreviewType(title)
			})),
		[data]
	);

	if (repositoryKey === null) return { artifacts: [], loading: false, error: null };

	return {
		artifacts,
		loading: query.isLoading || canLoadMore,
		error: query.error?.message ?? null
	};
}

export function useArtifactContents(
	repositoryKey: string | null,
	keys: readonly string[]
): ReadonlyMap<string, ArtifactContent> {
	const keysKey = keys.join('\0');

	const queries = useMemo(
		() =>
			repositoryKey === null || keysKey === ''
				? {}
				: Object.fromEntries(
						keysKey.split('\0').map((key) => [
							key,
							{
								query: api.artifacts.getArtifact,
								args: { artifactId: convexId<'artifacts'>().parse(key), repositoryKey }
							}
						])
					),
		[repositoryKey, keysKey]
	);

	const raw = useQueries(queries);

	return new Map(
		keys.map((key): [string, ArtifactContent] => {
			const result: FunctionReturnType<typeof api.artifacts.getArtifact> | Error | undefined =
				raw[key];

			if (result instanceof Error) return [key, { status: 'error', error: result.message }];

			if (!result) return [key, { status: 'loading' }];

			return [key, { status: 'ready', content: result.content, sourcePath: result.sourcePath }];
		})
	);
}
