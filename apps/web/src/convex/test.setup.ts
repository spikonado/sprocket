/// <reference types="vite/client" />

import contextDevTest from '@context-dot-dev/convex/test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import exaTest from '@exalabs/convex-exa/test';
import { convexTest, type TestConvex } from 'convex-test';
import type { GenericSchema, SchemaDefinition } from 'convex/server';
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

export type ConvexTestInstance = TestConvex<SchemaDefinition<GenericSchema, boolean>>;

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
	workspaceSessionId: Id<'workspaceSessions'>;
	threadId: Id<'threadRecords'>;
}> {
	const asUser = t.withIdentity({ subject });
	const workspaceSession = await asUser.mutation(api.workspaceSessions.upsertSelected, {
		workspaceName: 'alpha',
		connectedClientId: 'client-1'
	});
	if (!workspaceSession) {
		throw new Error('Expected workspace session');
	}
	const created = await asUser.mutation(api.threads.create, {
		submissionId: `thread-${subject}-${Date.now()}-${Math.random()}`,
		workspaceSessionId: workspaceSession._id,
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard'
	});
	return {
		asUser,
		subject,
		workspaceSessionId: workspaceSession._id,
		threadId: created.threadId
	};
}
