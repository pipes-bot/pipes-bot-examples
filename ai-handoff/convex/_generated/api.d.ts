/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as authz from "../authz.js";
import type * as handoff from "../handoff.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as lib_env from "../lib/env.js";
import type * as lib_handoff from "../lib/handoff.js";
import type * as lib_model from "../lib/model.js";
import type * as lib_payload from "../lib/payload.js";
import type * as lib_send from "../lib/send.js";
import type * as lib_signature from "../lib/signature.js";
import type * as responder from "../responder.js";
import type * as webhook from "../webhook.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  authz: typeof authz;
  handoff: typeof handoff;
  http: typeof http;
  ingest: typeof ingest;
  "lib/env": typeof lib_env;
  "lib/handoff": typeof lib_handoff;
  "lib/model": typeof lib_model;
  "lib/payload": typeof lib_payload;
  "lib/send": typeof lib_send;
  "lib/signature": typeof lib_signature;
  responder: typeof responder;
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
