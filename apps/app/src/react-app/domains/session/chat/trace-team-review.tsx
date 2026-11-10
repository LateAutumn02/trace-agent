import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, GitFork, Lock } from "lucide-react";
import { TRACE_TASK_LIMIT, traceTasksSchema } from "@/app/lib/trace-team";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { ModelRef } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

const reviews = [
  { key: "review-a", label: "Review A", placeholder: "Check the login rules and report the lockout threshold." },
  { key: "review-b", label: "Review B", placeholder: "Check the database notes and report the pool limit." },
];

export function TraceTeamReview({ client, workspaceId, model, modelUnavailable, onOpenSession }: {
  client: OpenworkServerClient;
  workspaceId: string;
  model: ModelRef;
  modelUnavailable: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [leadId, setLeadId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [launchError, setLaunchError] = useState(false);
  const launching = useRef(false);
  const tasks = traceTasksSchema.safeParse([first, second]);
  const readiness = useQuery({
    queryKey: ["trace-team-readiness", client.baseUrl, workspaceId],
    enabled: open && !leadId,
    queryFn: async ({ signal }) => {
      const status = await client.getEngineV2PreviewStatus();
      if (!status.running || !status.chatRouting) return "engine";
      return await client.traceTeam.ready(workspaceId, signal) ? "ready" : "plugin";
    },
    refetchInterval: (query) => query.state.data === "ready" ? false : 4_000,
    retry: false,
  });
  const snapshot = useQuery({
    queryKey: ["trace-team-run", client.baseUrl, workspaceId, leadId],
    enabled: open && Boolean(leadId) && !sending,
    queryFn: ({ signal }) => {
      if (!leadId) throw new Error("The lead session is unavailable.");
      return client.traceTeam.snapshot(workspaceId, leadId, signal);
    },
    refetchInterval: (query) => {
      const run = query.state.data;
      return run?.lead.outcome && run.workers.length >= 2 && run.workers.every((worker) => worker.outcome && !worker.running) ? false : 2_000;
    },
    retry: false,
  });

  async function launch() {
    if (!tasks.success || modelUnavailable || readiness.data !== "ready" || readiness.isError || leadId || launching.current) return;
    launching.current = true;
    setSending(true);
    setLaunchError(false);
    try {
      const sessionId = await client.traceTeam.create(workspaceId, model);
      setLeadId(sessionId);
      await client.traceTeam.start(workspaceId, sessionId, tasks.data, model);
    } catch {
      setLaunchError(true);
    } finally {
      launching.current = false;
      setSending(false);
    }
  }

  const blocked = readiness.isError ? "Couldn’t check the workspace. Reconnect or check again."
    : readiness.data === "engine" ? "Switch this workspace to OpenCode v2 to start a review."
      : readiness.data === "plugin" ? "Ensemble is not active. Check the workspace plugin and reload OpenCode."
        : modelUnavailable ? "Choose an available model in the composer." : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="self-center" />}>
        <GitFork aria-hidden="true" /> Run a team review
      </DialogTrigger>
      <DialogContent className="max-h-[min(90dvh,640px)] overflow-y-auto lg:max-w-xl" showCloseButton>
        <DialogHeader>
          <DialogTitle>TRACE-Agent team review</DialogTitle>
          <DialogDescription>Two workspace reviews run in parallel.</DialogDescription>
        </DialogHeader>
        {leadId ? (
          <div className="divide-y divide-border" aria-live="polite">
            {reviews.map((review) => {
              const worker = snapshot.data?.workers.find((row) => row.title.split(" ")[0] === review.key);
              const state = worker?.running ? "Running" : worker?.outcome === "succeeded" ? "Finished"
                : worker?.outcome === "failed" ? "Failed" : worker?.outcome === "interrupted" ? "Interrupted"
                  : snapshot.data?.lead.outcome && !worker ? "Not started" : "Waiting for worker";
              return (
                <section key={review.key} className="py-3 first:pt-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">{review.label}</h3>
                    <span className={worker?.outcome === "failed" ? "text-destructive" : "text-muted-foreground"}>{state}</span>
                  </div>
                  {worker?.summary ? <p className="mt-1 break-words text-muted-foreground">{worker.summary}</p> : null}
                  {worker ? <Button variant="link" className="px-0" onClick={() => onOpenSession(worker.id)}>Open worker <ArrowUpRight /></Button> : null}
                </section>
              );
            })}
            {snapshot.isError ? <p role="status" className="pt-3 text-muted-foreground">Couldn’t refresh the worker status. Open the lead session for details.</p> : null}
          </div>
        ) : (
          <form id={`${id}-form`} className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void launch(); }}>
            {reviews.map((review, index) => (
              <div className="grid min-w-0 gap-2" key={review.key}>
                <label htmlFor={`${id}-${review.key}`} className="font-medium">{review.label}</label>
                <Textarea id={`${id}-${review.key}`} placeholder={review.placeholder} value={index === 0 ? first : second}
                  onChange={(event) => (index === 0 ? setFirst : setSecond)(event.target.value)} maxLength={TRACE_TASK_LIMIT} required disabled={sending} />
              </div>
            ))}
            {blocked ? <p role="status" className="flex items-start gap-2 text-muted-foreground sm:col-span-2"><Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{blocked}</p> : null}
          </form>
        )}
        {launchError ? <p role="alert" className="text-destructive">{leadId ? "The launch couldn’t be confirmed. Check the lead session before starting again." : "Couldn’t create the lead session. Check the connection and try again."}</p> : null}
        <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
          {leadId ? (
            <>
              <Button variant="outline" disabled={sending} onClick={() => { setLeadId(undefined); setLaunchError(false); }}>Start another review</Button>
              <Button onClick={() => onOpenSession(leadId)}>Open lead session <ArrowUpRight /></Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={sending} onClick={() => { setFirst(reviews[0].placeholder); setSecond(reviews[1].placeholder); }}>Use sample tasks</Button>
              <Button type="submit" form={`${id}-form`} disabled={sending || !tasks.success || Boolean(blocked) || readiness.data !== "ready"}>Start review</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
