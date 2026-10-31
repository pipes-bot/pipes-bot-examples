import { useQuery } from "convex/react";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDuration, formatPercent } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Days = 7 | 30;

function Stat({ label, value }: { label: string; value: string | undefined }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums">{value ?? "…"}</p>
      </CardContent>
    </Card>
  );
}

export function StatCards({ numberId }: { numberId?: Id<"numbers"> }) {
  const [days, setDays] = useState<Days>(7);
  const overview = useQuery(api.dashboard.overview, { days, numberId });

  return (
    <section className="space-y-3">
      <Tabs value={String(days)} onValueChange={(value) => setDays(value === "30" ? 30 : 7)}>
        <TabsList>
          <TabsTrigger value="7">Last 7 days</TabsTrigger>
          <TabsTrigger value="30">Last 30 days</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Conversations" value={overview && String(overview.total)} />
        <Stat
          label="Median first response"
          value={overview && formatDuration(overview.medianFirstResponseSeconds)}
        />
        <Stat label="Answered" value={overview && formatPercent(overview.answeredRate)} />
        <Stat
          label="Avg methodology score"
          value={overview && (overview.avgScore === undefined ? "—" : String(overview.avgScore))}
        />
      </div>
    </section>
  );
}
