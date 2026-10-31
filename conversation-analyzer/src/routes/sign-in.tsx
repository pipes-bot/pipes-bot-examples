import { createFileRoute } from "@tanstack/react-router";
import { AuthForm } from "@/components/AuthForm";

export const Route = createFileRoute("/sign-in")({
  component: () => <AuthForm mode="sign-in" />,
});
