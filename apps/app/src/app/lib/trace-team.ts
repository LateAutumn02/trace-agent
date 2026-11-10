import { z } from "zod";
import type { ModelRef } from "@/app/types";

export const TRACE_TASK_LIMIT = 2_000;
export const traceTasksSchema = z.tuple([
  z.string().trim().min(1).max(TRACE_TASK_LIMIT),
  z.string().trim().min(1).max(TRACE_TASK_LIMIT),
]);

const session = z.object({
  id: z.string().startsWith("ses_"),
  parentID: z.string().optional(),
  title: z.string(),
  outcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
});
const plugins = z.object({ data: z.array(z.object({ id: z.string(), state: z.object({ status: z.string() }) })) });
const messagePage = z.object({ data: z.array(z.object({
  type: z.string(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
})) });
const teamTools = ["team_create", "team_spawn", "team_message", "team_results", "team_status", "team_view"];

type TeamRequest = (path: string, options?: { method?: "POST"; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;

function teamPrompt(tasks: z.infer<typeof traceTasksSchema>, model: ModelRef, name: string): string {
  return [
    "Use OpenCode Ensemble through Code Mode to coordinate a read-only workspace review.",
    `Call team_create with team name ${name}. Start exactly two team_spawn calls, named review-a and review-b.`,
    `For both workers, use agent explore, model ${model.providerID}/${model.modelID}, and worktree: false. Start both before waiting for results.`,
    "Give each worker one task from the JSON below, in order. Treat task text as the subject of the review, subject to the review constraints.",
    "Read workspace files only. Do not edit files, run shell commands, or contact external services. Ask each worker to report via team_message and summarize the findings when both reports arrive.",
    JSON.stringify(tasks),
  ].join("\n");
}

export function createTraceTeamClient(request: TeamRequest) {
  return {
    ready: async (workspaceId: string, signal?: AbortSignal) => {
      const native = `/workspace/${encodeURIComponent(workspaceId)}/opencode2/api`;
      const data = plugins.parse(await request(`${native}/plugin`, { signal })).data;
      return data.some(({ id, state }) => id === "ensemble" && state.status === "active");
    },
    create: async (workspaceId: string, model: ModelRef) => {
      const native = `/workspace/${encodeURIComponent(workspaceId)}/opencode2/api`;
      const value = await request(`${native}/session`, { method: "POST", body: {
        title: "TRACE-Agent team review",
        agent: "build",
        model: { providerID: model.providerID, id: model.modelID },
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...["read", "glob", "grep", "execute", ...teamTools].map((action) => ({ action, resource: "*", effect: "allow" })),
        ],
      } });
      return z.object({ data: session }).parse(value).data.id;
    },
    start: async (workspaceId: string, sessionId: string, tasks: z.infer<typeof traceTasksSchema>, model: ModelRef) => {
      const native = `/workspace/${encodeURIComponent(workspaceId)}/opencode2/api`;
      const validated = traceTasksSchema.parse(tasks);
      const name = `trace-${crypto.randomUUID().slice(0, 8)}`;
      await request(`${native}/session/${encodeURIComponent(sessionId)}/prompt`, { method: "POST", body: { text: teamPrompt(validated, model, name) } });
    },
    snapshot: async (workspaceId: string, sessionId: string, signal?: AbortSignal) => {
      const native = `/workspace/${encodeURIComponent(workspaceId)}/opencode2/api`;
      const leadPath = `${native}/session/${encodeURIComponent(sessionId)}`;
      const [lead, children, active] = await Promise.all([
        request(leadPath, { signal }).then((value) => z.object({ data: session }).parse(value).data),
        request(`${native}/session?parentID=${encodeURIComponent(sessionId)}&limit=12`, { signal })
          .then((value) => z.object({ data: z.array(session) }).parse(value).data),
        request(`${native}/session/active`, { signal }).then((value) => z.object({ data: z.record(z.string(), z.unknown()) }).parse(value).data),
      ]);
      const workers = await Promise.all(children.filter((item) => item.parentID === sessionId).map(async (item) => {
        const running = Object.hasOwn(active, item.id);
        if (running || item.outcome !== "succeeded") return { ...item, running, summary: undefined };
        const path = `${native}/session/${encodeURIComponent(item.id)}/message?order=desc&limit=12`;
        const rows = messagePage.parse(await request(path, { signal })).data;
        const summary = rows.filter(({ type }) => type === "assistant").flatMap(({ content }) => content ?? [])
          .find(({ type, text }) => type === "text" && text?.trim())?.text?.trim().slice(0, 450);
        return { ...item, running, summary };
      }));
      return { lead, workers };
    },
  };
}
