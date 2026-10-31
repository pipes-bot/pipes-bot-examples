import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";
import { pipesWebhook } from "./webhook";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

http.route({ path: "/webhooks/pipes", method: "POST", handler: pipesWebhook });

export default http;
