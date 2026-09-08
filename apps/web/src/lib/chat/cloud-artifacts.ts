import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '$convex/_generated/api';
import type { LocalArtifact } from '$lib/types/sprocket';
import type { ArtifactWatchState } from './artifacts';

type ArtifactPage = FunctionReturnType<typeof api.artifacts.listArtifacts>;
export type CloudArtifactScope = FunctionArgs<typeof api.artifacts.getArtifactState> & {
	userId: string;
};
type CloudArtifactClient = {
	query: (
		query: typeof api.artifacts.listArtifacts,
		args: FunctionArgs<typeof api.artifacts.listArtifacts>
	) => Promise<ArtifactPage>;
	onUpdate: (
		query: typeof api.artifacts.getArtifactState,
		args: FunctionArgs<typeof api.artifacts.getArtifactState>,
		onUpdate: (revision: number) => void,
		onError: (error: Error) => void
	) => () => void;
};

export function watchCloudArtifacts(
	client: CloudArtifactClient,
	scope: CloudArtifactScope,
	onSnapshot: (state: ArtifactWatchState) => void
): () => void {
	const { userId, ...queryScope } = scope;
	let stopped = false;
	let generation = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let latest: LocalArtifact[] = [];
	async function refresh(version: number) {
		try {
			const artifacts: LocalArtifact[] = [];
			let cursor: string | null = null;
			let revision: number | undefined;
			for (;;) {
				const page: ArtifactPage = await client.query(api.artifacts.listArtifacts, {
					...queryScope,
					cursor
				});
				if (stopped || generation !== version) return;
				if (revision !== undefined && revision !== page.revision)
					throw new Error('Artifact registry changed during loading; retrying.');
				revision = page.revision;
				artifacts.push(...page.page.filter((artifact) => artifact.userId === userId));
				if (page.isDone) break;
				if (cursor === page.continueCursor)
					throw new Error('Artifact page cursor did not advance.');
				cursor = page.continueCursor;
			}
			latest = artifacts;
			onSnapshot({ artifacts, stale: false, error: null });
		} catch (error) {
			if (stopped || generation !== version) return;
			onSnapshot({
				artifacts: latest,
				stale: true,
				error: error instanceof Error ? error.message : 'Unable to load artifacts.'
			});
			retry = setTimeout(() => {
				void refresh(version);
			}, 2_000);
		}
	}
	const unsubscribe = client.onUpdate(
		api.artifacts.getArtifactState,
		queryScope,
		() => {
			clearTimeout(retry);
			void refresh(++generation);
		},
		(error) => {
			generation++;
			clearTimeout(retry);
			latest = [];
			onSnapshot({ artifacts: [], stale: true, error: error.message });
		}
	);
	return () => {
		stopped = true;
		clearTimeout(retry);
		unsubscribe();
	};
}
