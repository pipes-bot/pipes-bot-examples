import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

export function makeT() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t, "betterAuth");
  return t;
}
