import { ConvexError } from "convex/values";

const DEFAULT_API_BASE_URL = "https://api.pipes.bot";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConvexError(`${name} is not set`);
  return value;
}

export function apiBaseUrl(): string {
  return process.env.PIPES_API_BASE_URL || DEFAULT_API_BASE_URL;
}
