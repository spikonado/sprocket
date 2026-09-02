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
import type * as browserAgent from "../browserAgent.js";
import type * as browserSessions from "../browserSessions.js";
import type * as chat from "../chat.js";
import type * as completion from "../completion.js";
import type * as crons from "../crons.js";
import type * as executor from "../executor.js";
import type * as gateway from "../gateway.js";
import type * as http from "../http.js";
import type * as imageUploads from "../imageUploads.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_agentErrors from "../lib/agentErrors.js";
import type * as lib_agentQuestions from "../lib/agentQuestions.js";
import type * as lib_assistantParts from "../lib/assistantParts.js";
import type * as lib_assistantStreamWrites from "../lib/assistantStreamWrites.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_commandResults from "../lib/commandResults.js";
import type * as lib_completionStream from "../lib/completionStream.js";
import type * as lib_contextCompaction from "../lib/contextCompaction.js";
import type * as lib_docs from "../lib/docs.js";
import type * as lib_executorJobs from "../lib/executorJobs.js";
import type * as lib_gatewayFetch from "../lib/gatewayFetch.js";
import type * as lib_gatewayProtocol from "../lib/gatewayProtocol.js";
import type * as lib_gatewayToken from "../lib/gatewayToken.js";
import type * as lib_imageUploads from "../lib/imageUploads.js";
import type * as lib_json from "../lib/json.js";
import type * as lib_machineRuns from "../lib/machineRuns.js";
import type * as lib_models from "../lib/models.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_runCancellation from "../lib/runCancellation.js";
import type * as lib_runFinalize from "../lib/runFinalize.js";
import type * as lib_runLease from "../lib/runLease.js";
import type * as lib_runResume from "../lib/runResume.js";
import type * as lib_runTerminal from "../lib/runTerminal.js";
import type * as lib_runs from "../lib/runs.js";
import type * as lib_threadMessages from "../lib/threadMessages.js";
import type * as lib_threadSnapshots from "../lib/threadSnapshots.js";
import type * as lib_threadUsage from "../lib/threadUsage.js";
import type * as lib_tiers from "../lib/tiers.js";
import type * as lib_transcriptParts from "../lib/transcriptParts.js";
import type * as lib_transcriptWrites from "../lib/transcriptWrites.js";
import type * as lib_uiModelCatalog from "../lib/uiModelCatalog.js";
import type * as lib_unsupportedClient from "../lib/unsupportedClient.js";
import type * as lib_usageMeters from "../lib/usageMeters.js";
import type * as lib_validators from "../lib/validators.js";
import type * as machineSessions from "../machineSessions.js";
import type * as machines from "../machines.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as modelCatalog from "../modelCatalog.js";
import type * as payments from "../payments.js";
import type * as projects from "../projects.js";
import type * as runLifecycle from "../runLifecycle.js";
import type * as threads from "../threads.js";
import type * as transcript from "../transcript.js";
import type * as uiPreferences from "../uiPreferences.js";
import type * as usage from "../usage.js";
import type * as webToolPool from "../webToolPool.js";
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
  browserAgent: typeof browserAgent;
  browserSessions: typeof browserSessions;
  chat: typeof chat;
  completion: typeof completion;
  crons: typeof crons;
  executor: typeof executor;
  gateway: typeof gateway;
  http: typeof http;
  imageUploads: typeof imageUploads;
  "lib/access": typeof lib_access;
  "lib/agentErrors": typeof lib_agentErrors;
  "lib/agentQuestions": typeof lib_agentQuestions;
  "lib/assistantParts": typeof lib_assistantParts;
  "lib/assistantStreamWrites": typeof lib_assistantStreamWrites;
  "lib/auth": typeof lib_auth;
  "lib/commandResults": typeof lib_commandResults;
  "lib/completionStream": typeof lib_completionStream;
  "lib/contextCompaction": typeof lib_contextCompaction;
  "lib/docs": typeof lib_docs;
  "lib/executorJobs": typeof lib_executorJobs;
  "lib/gatewayFetch": typeof lib_gatewayFetch;
  "lib/gatewayProtocol": typeof lib_gatewayProtocol;
  "lib/gatewayToken": typeof lib_gatewayToken;
  "lib/imageUploads": typeof lib_imageUploads;
  "lib/json": typeof lib_json;
  "lib/machineRuns": typeof lib_machineRuns;
  "lib/models": typeof lib_models;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/runCancellation": typeof lib_runCancellation;
  "lib/runFinalize": typeof lib_runFinalize;
  "lib/runLease": typeof lib_runLease;
  "lib/runResume": typeof lib_runResume;
  "lib/runTerminal": typeof lib_runTerminal;
  "lib/runs": typeof lib_runs;
  "lib/threadMessages": typeof lib_threadMessages;
  "lib/threadSnapshots": typeof lib_threadSnapshots;
  "lib/threadUsage": typeof lib_threadUsage;
  "lib/tiers": typeof lib_tiers;
  "lib/transcriptParts": typeof lib_transcriptParts;
  "lib/transcriptWrites": typeof lib_transcriptWrites;
  "lib/uiModelCatalog": typeof lib_uiModelCatalog;
  "lib/unsupportedClient": typeof lib_unsupportedClient;
  "lib/usageMeters": typeof lib_usageMeters;
  "lib/validators": typeof lib_validators;
  machineSessions: typeof machineSessions;
  machines: typeof machines;
  messages: typeof messages;
  migrations: typeof migrations;
  modelCatalog: typeof modelCatalog;
  payments: typeof payments;
  projects: typeof projects;
  runLifecycle: typeof runLifecycle;
  threads: typeof threads;
  transcript: typeof transcript;
  uiPreferences: typeof uiPreferences;
  usage: typeof usage;
  webToolPool: typeof webToolPool;
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
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  aggregate: import("@convex-dev/aggregate/_generated/component.js").ComponentApi<"aggregate">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
  actionRetrier: import("@convex-dev/action-retrier/_generated/component.js").ComponentApi<"actionRetrier">;
  webToolWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"webToolWorkpool">;
};
