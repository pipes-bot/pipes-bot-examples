import { httpRouter } from "convex/server";
import { mcpEndpoint, mcpMethodNotAllowed } from "./mcp/http";

const http = httpRouter();

http.route({ path: "/mcp", method: "POST", handler: mcpEndpoint });
http.route({ path: "/mcp", method: "GET", handler: mcpMethodNotAllowed });
http.route({ path: "/mcp", method: "DELETE", handler: mcpMethodNotAllowed });

export default http;
