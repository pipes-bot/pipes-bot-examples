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
import type * as http from "../http.js";
import type * as lib_crm from "../lib/crm.js";
import type * as lib_payload from "../lib/payload.js";
import type * as lib_send from "../lib/send.js";
import type * as lib_signature from "../lib/signature.js";
import type * as mcp_auth from "../mcp/auth.js";
import type * as mcp_data from "../mcp/data.js";
import type * as mcp_http from "../mcp/http.js";
import type * as mcp_server from "../mcp/server.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  authz: typeof authz;
  http: typeof http;
  "lib/crm": typeof lib_crm;
  "lib/payload": typeof lib_payload;
  "lib/send": typeof lib_send;
  "lib/signature": typeof lib_signature;
  "mcp/auth": typeof mcp_auth;
  "mcp/data": typeof mcp_data;
  "mcp/http": typeof mcp_http;
  "mcp/server": typeof mcp_server;
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
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
};
