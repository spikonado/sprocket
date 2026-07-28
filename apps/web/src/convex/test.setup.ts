/// <reference types="vite/client" />

import contextDevTest from '@context-dot-dev/convex/test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import exaTest from '@exalabs/convex-exa/test';
import { convexTest, type TestConvex } from 'convex-test';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import schema from './schema';

/**
 * Convex function modules for `convex-test`.
 * `_generated` must be included; tests/configs/declarations stay out.
 */
export const modules = import.meta.glob([
	'./**/*.ts',
	'./**/*.js',
	'!./**/*.test.ts',
	'!./**/*.config.ts',
	'!./**/*.d.ts',
	'!./**/test.setup.ts'
]);

export type ConvexTestInstance = TestConvex<typeof schema>;

type AuthenticatedTest = ReturnType<ConvexTestInstance['withIdentity']>;

/** Fresh mock backend with our schema, functions, and registered components. */
export function initConvexTest(): ConvexTestInstance {
	const t = convexTest(schema, modules);
	// Component `/test` helpers disagree on `registerComponent` parameter variance.
	const backend = t as never;
	rateLimiterTest.register(backend);
	contextDevTest.register(backend);
	exaTest.register(backend);
	return t;
}

export async function seedOwnedThread(
	t: ConvexTestInstance,
	subject = 'user_alice'
): Promise<{
	asUser: AuthenticatedTest;
	subject: string;
	projectId: Id<'projects'>;
	threadId: Id<'threadRecords'>;
}> {
	const asUser = t.withIdentity({ subject });
	// Integration fixtures exercise every model; grant admin so free-tier allowlists do not block them.
	await t.run(async (ctx) => {
		await ctx.db.insert('subscriptions', {
			userId: subject,
			tier: 'admin',
			status: 'active',
			eventAt: 1
		});
	});
	const project = await asUser.mutation(api.projects.upsertSelected, {
		repositoryKey: 'alpha',
		displayName: 'alpha',
		connectedClientId: 'client-1'
	});
	if (!project) {
		throw new Error('Expected project');
	}
	const created = await asUser.mutation(api.threads.create, {
		submissionId: `thread-${subject}-${Date.now()}-${Math.random()}`,
		projectId: project._id,
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard'
	});
	return {
		asUser,
		subject,
		projectId: project._id,
		threadId: created.threadId
	};
}
