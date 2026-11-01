import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["convex/**/*.test.ts"],
          // Convex provides CONVEX_SITE_URL in every deployment; Better Auth needs both at init.
          env: { CONVEX_SITE_URL: "https://crm.test.convex.site", SITE_URL: "http://localhost:5173" },
        },
      },
      {
        test: {
          name: "src",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
    ],
  },
});
