/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentRuntime from '../agentRuntime.js';
import type * as auth from '../auth.js';
import type * as authBootstrap from '../authBootstrap.js';
import type * as chat from '../chat.js';
import type * as completion from '../completion.js';
import type * as executor from '../executor.js';
import type * as executorNode from '../executorNode.js';
import type * as http from '../http.js';
import type * as lib_access from '../lib/access.js';
import type * as lib_agentHistory from '../lib/agentHistory.js';
import type * as lib_auth from '../lib/auth.js';
import type * as lib_modelRegistry from '../lib/modelRegistry.js';
import type * as lib_rateLimits from '../lib/rateLimits.js';
import type * as lib_runs from '../lib/runs.js';
import type * as lib_state from '../lib/state.js';
import type * as lib_threadMessages from '../lib/threadMessages.js';
import type * as lib_validators from '../lib/validators.js';
import type * as lib_workspaceConnection from '../lib/workspaceConnection.js';
import type * as lib_workspacePrompt from '../lib/workspacePrompt.js';
import type * as messages from '../messages.js';
import type * as threads from '../threads.js';
import type * as uiPreferences from '../uiPreferences.js';
import type * as workspaceSessions from '../workspaceSessions.js';

import type { ApiFromModules, FilterApi, FunctionReference } from 'convex/server';

declare const fullApi: ApiFromModules<{
	agentRuntime: typeof agentRuntime;
	auth: typeof auth;
	authBootstrap: typeof authBootstrap;
	chat: typeof chat;
	completion: typeof completion;
	executor: typeof executor;
	executorNode: typeof executorNode;
	http: typeof http;
	'lib/access': typeof lib_access;
	'lib/agentHistory': typeof lib_agentHistory;
	'lib/auth': typeof lib_auth;
	'lib/modelRegistry': typeof lib_modelRegistry;
	'lib/rateLimits': typeof lib_rateLimits;
	'lib/runs': typeof lib_runs;
	'lib/state': typeof lib_state;
	'lib/threadMessages': typeof lib_threadMessages;
	'lib/validators': typeof lib_validators;
	'lib/workspaceConnection': typeof lib_workspaceConnection;
	'lib/workspacePrompt': typeof lib_workspacePrompt;
	messages: typeof messages;
	threads: typeof threads;
	uiPreferences: typeof uiPreferences;
	workspaceSessions: typeof workspaceSessions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, 'public'>>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, 'internal'>>;

export declare const components: {
	rateLimiter: import('@convex-dev/rate-limiter/_generated/component.js').ComponentApi<'rateLimiter'>;
	workOSAuthKit: import('@convex-dev/workos-authkit/_generated/component.js').ComponentApi<'workOSAuthKit'>;
};
