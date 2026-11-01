import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("check number health", { hours: 1 }, internal.numbers.checkHealth);

export default crons;
