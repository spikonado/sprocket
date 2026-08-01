/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentQuestions from "../agentQuestions.js";
import type * as agentRuntime from "../agentRuntime.js";
import type * as artifacts from "../artifacts.js";
import type * as authBootstrap from "../authBootstrap.js";
import type * as billing from "../billing.js";
import type * as browserSessions from "../browserSessions.js";
import type * as chat from "../chat.js";
import type * as completion from "../completion.js";
import type * as crons from "../crons.js";
import type * as executor from "../executor.js";
import type * as http from "../http.js";
import type * as imageUploads from "../imageUploads.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_agentErrors from "../lib/agentErrors.js";
import type * as lib_agentHistory from "../lib/agentHistory.js";
import type * as lib_agentQuestions from "../lib/agentQuestions.js";
import type * as lib_assistantParts from "../lib/assistantParts.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_completionStream from "../lib/completionStream.js";
import type * as lib_contextCompaction from "../lib/contextCompaction.js";
import type * as lib_docs from "../lib/docs.js";
import type * as lib_imageUploads from "../lib/imageUploads.js";
import type * as lib_json from "../lib/json.js";
import type * as lib_modelRegistry from "../lib/modelRegistry.js";
import type * as lib_models from "../lib/models.js";
import type * as lib_projectConnection from "../lib/projectConnection.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_runLease from "../lib/runLease.js";
import type * as lib_runs from "../lib/runs.js";
import type * as lib_threadMessages from "../lib/threadMessages.js";
import type * as lib_threadTranscript from "../lib/threadTranscript.js";
import type * as lib_tiers from "../lib/tiers.js";
import type * as lib_uiModelCatalog from "../lib/uiModelCatalog.js";
import type * as lib_usageMeters from "../lib/usageMeters.js";
import type * as lib_validators from "../lib/validators.js";
import type * as messages from "../messages.js";
import type * as modelCatalog from "../modelCatalog.js";
import type * as payments from "../payments.js";
import type * as projects from "../projects.js";
import type * as threads from "../threads.js";
import type * as uiPreferences from "../uiPreferences.js";
import type * as usage from "../usage.js";
import type * as webTools from "../webTools.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentQuestions: typeof agentQuestions;
  agentRuntime: typeof agentRuntime;
  artifacts: typeof artifacts;
  authBootstrap: typeof authBootstrap;
  billing: typeof billing;
  browserSessions: typeof browserSessions;
  chat: typeof chat;
  completion: typeof completion;
  crons: typeof crons;
  executor: typeof executor;
  http: typeof http;
  imageUploads: typeof imageUploads;
  "lib/access": typeof lib_access;
  "lib/agentErrors": typeof lib_agentErrors;
  "lib/agentHistory": typeof lib_agentHistory;
  "lib/agentQuestions": typeof lib_agentQuestions;
  "lib/assistantParts": typeof lib_assistantParts;
  "lib/auth": typeof lib_auth;
  "lib/completionStream": typeof lib_completionStream;
  "lib/contextCompaction": typeof lib_contextCompaction;
  "lib/docs": typeof lib_docs;
  "lib/imageUploads": typeof lib_imageUploads;
  "lib/json": typeof lib_json;
  "lib/modelRegistry": typeof lib_modelRegistry;
  "lib/models": typeof lib_models;
  "lib/projectConnection": typeof lib_projectConnection;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/runLease": typeof lib_runLease;
  "lib/runs": typeof lib_runs;
  "lib/threadMessages": typeof lib_threadMessages;
  "lib/threadTranscript": typeof lib_threadTranscript;
  "lib/tiers": typeof lib_tiers;
  "lib/uiModelCatalog": typeof lib_uiModelCatalog;
  "lib/usageMeters": typeof lib_usageMeters;
  "lib/validators": typeof lib_validators;
  messages: typeof messages;
  modelCatalog: typeof modelCatalog;
  payments: typeof payments;
  projects: typeof projects;
  threads: typeof threads;
  uiPreferences: typeof uiPreferences;
  usage: typeof usage;
  webTools: typeof webTools;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  contextDev: import("@context-dot-dev/convex/_generated/component.js").ComponentApi<"contextDev">;
  exa: import("@exalabs/convex-exa/_generated/component.js").ComponentApi<"exa">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  dodopayments: import("@dodopayments/convex/_generated/component.js").ComponentApi<"dodopayments">;
};
