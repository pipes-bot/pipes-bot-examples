import { createFileRoute } from "@tanstack/react-router";
import { PipelineBoard } from "@/components/PipelineBoard";

export const Route = createFileRoute("/_app/")({
  component: PipelineBoard,
});
