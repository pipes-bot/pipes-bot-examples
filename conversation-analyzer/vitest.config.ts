import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["convex/**/*.test.ts"],
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
