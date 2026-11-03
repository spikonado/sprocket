import type { LinkedPullRequest } from '@convex/lib/validators';

export const allMerged = (pullRequests: LinkedPullRequest[]) =>
	pullRequests.length > 0 && pullRequests.every((pr) => pr.state === 'merged');
