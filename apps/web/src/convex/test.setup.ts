/// <reference types="vite/client" />

import contextDevTest from '@context-dot-dev/convex/test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import exaTest from '@exalabs/convex-exa/test';
import migrationsTest from '@convex-dev/migrations/test';
import aggregateTest from '@convex-dev/aggregate/test';
import workflowTest from '@convex-dev/workflow/test';
import actionRetrierTest from '@convex-dev/action-retrier/test';
import workpoolTest from '@convex-dev/workpool/test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '@convex/_generated/api';
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
	// SAFETY: each component test helper types registerComponent against its own
	// TestConvex variance; the convex-test backend object is the same instance.
	const backend = t as never;
	rateLimiterTest.register(backend);
	contextDevTest.register(backend);
	exaTest.register(backend);
	migrationsTest.register(backend);
	aggregateTest.register(backend);
	workflowTest.register(backend);
	actionRetrierTest.register(backend);
	workpoolTest.register(backend, 'webToolWorkpool');
	return t;
}

export async function seedOwnedThread(
	t: ConvexTestInstance,
	subject = 'user_alice'
): Promise<{
	asUser: AuthenticatedTest;
	subject: string;
	repositoryKey: string;
	threadId: Id<'threadRecords'>;
}> {
	const asUser = t.withIdentity({ subject });
	// Integration fixtures exercise every model; grant admin so free-tier allowlists do not block them.
	await t.run(async (ctx) => {
		await ctx.db.insert('subscriptions', {
			userId: subject,
			tier: 'admin',
			dodoSubscriptionId: '',
			dodoProductId: '',
			status: 'active',
			eventAt: 1
		});
	});
	const repositoryKey = 'alpha';
	const created = await asUser.mutation(api.threads.create, {
		submissionId: `thread-${subject}-${Date.now()}-${Math.random()}`,
		repositoryKey,
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard'
	});
	return {
		asUser,
		subject,
		repositoryKey,
		threadId: created.threadId
	};
}

export async function insertQueuedRun(
	t: ConvexTestInstance,
	asUser: AuthenticatedTest,
	args: {
		threadId: Id<'threadRecords'>;
		submissionId: string;
		executionSecret: string;
		prompt: string;
		imageUploadIds?: Id<'imageUploads'>[];
		selectedModel?: string;
		reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
		serviceTier?: 'standard' | 'fast';
	}
) {
	const thread = await asUser.query(api.threads.getByThreadId, { threadId: args.threadId });
	return await t.mutation(internal.agentRuntime.insertGatewayRun, {
		userId: thread.userId,
		submissionId: args.submissionId,
		threadId: args.threadId,
		prompt: args.prompt,
		imageUploadIds: args.imageUploadIds ?? [],
		selectedModel: args.selectedModel ?? 'gpt-5.6-sol',
		reasoningEffort: args.reasoningEffort ?? 'medium',
		serviceTier: args.serviceTier ?? 'standard',
		executionSecret: args.executionSecret,
		protocolVersion: 1
	});
}

export async function createQueuedRun(
	t: ConvexTestInstance,
	asUser: AuthenticatedTest,
	threadId: Id<'threadRecords'>,
	submissionId: string,
	executionSecret: string,
	prompt = 'Do the thing'
) {
	return await insertQueuedRun(t, asUser, {
		threadId,
		submissionId,
		executionSecret,
		prompt
	});
}
