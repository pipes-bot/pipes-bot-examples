/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as analysis from "../analysis.js";
import type * as auth from "../auth.js";
import type * as authz from "../authz.js";
import type * as contactLookup from "../contactLookup.js";
import type * as contactsSync from "../contactsSync.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as demo from "../demo.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as lib_evaluation from "../lib/evaluation.js";
import type * as lib_history from "../lib/history.js";
import type * as lib_methodology from "../lib/methodology.js";
import type * as lib_metrics from "../lib/metrics.js";
import type * as lib_model from "../lib/model.js";
import type * as lib_payload from "../lib/payload.js";
import type * as lib_signature from "../lib/signature.js";
import type * as lib_stats from "../lib/stats.js";
import type * as lib_transcript from "../lib/transcript.js";
import type * as numbers from "../numbers.js";
import type * as webhook from "../webhook.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  analysis: typeof analysis;
  auth: typeof auth;
  authz: typeof authz;
  contactLookup: typeof contactLookup;
  contactsSync: typeof contactsSync;
  conversations: typeof conversations;
  crons: typeof crons;
  dashboard: typeof dashboard;
  demo: typeof demo;
  http: typeof http;
  ingest: typeof ingest;
  "lib/evaluation": typeof lib_evaluation;
  "lib/history": typeof lib_history;
  "lib/methodology": typeof lib_methodology;
  "lib/metrics": typeof lib_metrics;
  "lib/model": typeof lib_model;
  "lib/payload": typeof lib_payload;
  "lib/signature": typeof lib_signature;
  "lib/stats": typeof lib_stats;
  "lib/transcript": typeof lib_transcript;
  numbers: typeof numbers;
  webhook: typeof webhook;
  workspaces: typeof workspaces;
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
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
