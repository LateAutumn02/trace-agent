import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ServerConfig } from "../src/types.js";

const fixtures = [
  { name: "login", filename: "login.txt", fact: "Account locks after five failures." },
  { name: "database", filename: "database.txt", fact: "Connection pool limit is eight." },
];
const model = { id: "fixture", providerID: "trace-smoke" };
const plugin = "@hueyexe/opencode-ensemble@0.20.0";
const completionRequest = z.object({
  messages: z.array(z.object({
    role: z.string(),
    content: z.unknown(),
    tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
  })),
});
const object = z.record(z.string(), z.unknown());
const envelope = z.object({ data: z.unknown() });
const session = z.object({ id: z.string(), parentID: z.string().optional(), outcome: z.string().optional() });
const history = z.array(z.object({ content: z.array(object).optional() }));
const toolResult = z.object({
  name: z.string(),
  type: z.literal("tool"),
  state: z.object({
    status: z.literal("completed"),
    content: z.array(z.object({ text: z.string().optional() })).optional(),
    metadata: z.object({ toolCalls: z.array(z.object({ tool: z.string(), status: z.string() })).optional() }).optional(),
  }),
});

function ensembleCall(tool: string, input: Record<string, unknown>) {
  return { name: "execute", arguments: JSON.stringify({ code: `return await tools.${tool}(${JSON.stringify(input)});` }) };
}

function scriptedModel(directory: string) {
  const waiting = new Set<string>();
  const failures: unknown[] = [];
  let concurrentWorkers = false;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    try {
      const input = completionRequest.parse(await new Response(ReadableStream.from(request)).json());
      const messages = input.messages;
      const latest = JSON.stringify(messages.findLast((message) => message.role === "user")?.content ?? "");
      const calls = messages.flatMap((message) => message.tool_calls?.map((call) => call.function) ?? []);
      const fixture = fixtures.find(({ name }) => latest.includes(`TRACE_FIXTURE_${name}`));
      const outputs = messages.filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content));
      let call: { name: string; arguments: string } | undefined;
      let answer = "Fixture run complete.";
      if (fixture && !calls.some(({ name }) => name === "read")) {
        waiting.add(fixture.name);
        if (waiting.size === fixtures.length) concurrentWorkers = true;
        const deadline = Date.now() + 12_000;
        while (!concurrentWorkers && Date.now() < deadline) await delay(50);
        assert.ok(concurrentWorkers, "both workers must start before either may read its file");
        call = { name: "read", arguments: JSON.stringify({ path: join(directory, fixture.filename) }) };
      } else if (fixture) {
        assert.ok(outputs.some((output) => output.includes(fixture.fact)), `missing file read for ${fixture.name}`);
        answer = fixture.fact;
        if (!calls.some(({ arguments: args }) => args.includes("tools.team_message("))) {
          call = ensembleCall("team_message", { to: "lead", text: `<task-result><status>completed</status><summary>${answer}</summary></task-result>` });
        }
      } else if (!calls.some(({ arguments: args }) => args.includes("tools.team_create("))) {
        call = ensembleCall("team_create", { name: "trace-smoke" });
      } else {
        const index = calls.filter(({ arguments: args }) => args.includes("tools.team_spawn(")).length;
        const next = fixtures[index];
        if (next) call = ensembleCall("team_spawn", {
          name: next.name, agent: "explore", model: `${model.providerID}/${model.id}`, worktree: false,
          prompt: `TRACE_FIXTURE_${next.name} read ${next.filename}`,
        });
      }
      const id = `chatcmpl-${randomUUID()}`;
      const delta = call
        ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: "function", function: call }] }
        : { role: "assistant", content: answer };
      const frame = (part: unknown, finish: string | null) => `data: ${JSON.stringify({
        id, object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta: part, finish_reason: finish }],
      })}\n\n`;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`${frame(delta, null)}${frame({}, call ? "tool_calls" : "stop")}data: [DONE]\n\n`);
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end("Scripted model fixture failed");
    }
  });
  return { server, failures, overlapped: () => concurrentWorkers };
}

test("TRACE loads Ensemble and two native workers read and report in parallel", { timeout: 240_000 }, async (t) => {
  const binary = process.env.OPENWORK_TEST_OPENCODE2;
  if (!binary) {
    t.skip("needs: pinned OpenCode v2 binary; set OPENWORK_TEST_OPENCODE2");
    return;
  }
  const constants = z.object({ opencodeV2Version: z.string() }).parse(JSON.parse(await readFile(new URL("../../../constants.json", import.meta.url), "utf8")));
  assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim(), `opencode v${constants.opencodeV2Version}`);
  const root = await mkdtemp(join(tmpdir(), "trace-ensemble-"));
  const directory = join(root, "project");
  const configDirectory = join(directory, ".opencode");
  const mock = scriptedModel(directory);
  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENWORK_DATA_DIR: join(root, "openwork"), OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    OPENWORK_OPENCODE2_BIN: binary, OPENWORK_ENGINE_V2_PREVIEW: "chat",
    OPENCODE_DB: join(root, "engine.sqlite"), OPENCODE_DISABLE_MODELS_FETCH: "true",
  };
  let stopHost: (() => Promise<void>) | undefined;
  t.after(async () => {
    try {
      await stopHost?.();
    } finally {
      mock.server.closeAllConnections();
      if (mock.server.listening) await new Promise<void>((resolve) => mock.server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const address = mock.server.address();
  assert.ok(address && typeof address !== "string");
  await mkdir(configDirectory, { recursive: true });
  execFileSync("git", ["init", "-q", directory]);
  await Promise.all([
    ...fixtures.map(({ filename, fact }) => writeFile(join(directory, filename), `${fact}\n`)),
    writeFile(join(configDirectory, "ensemble.json"), JSON.stringify({ dashboardPort: 0 })),
    writeFile(join(configDirectory, "opencode.json"), JSON.stringify({
      plugins: [plugin], compaction: { auto: false },
      providers: { [model.providerID]: {
        name: "TRACE smoke model", package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only" },
        models: { [model.id]: { limit: { context: 262_144, output: 8_192 } } },
      } },
    })),
  ]);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: randomUUID(), hostToken: randomUUID(), configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], authorizedRoots: [root], readOnly: false,
    workspaces: [{ id: "ws_trace", name: "TRACE fixture", path: directory, preset: "starter", workspaceType: "local" }],
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  // Use the built Node host. Exiting the process also closes SQLite handles
  // held by module caches before the temporary directory is removed on Windows.
  const host = spawn(process.execPath, ["--input-type=module", "-e", `
    import { startServer } from ${JSON.stringify(new URL("../dist/server.js", import.meta.url).href)};
    const server = await startServer(${JSON.stringify(config)});
    process.stdin.resume();
    process.stdin.once("end", async () => {
      await server.stop();
      process.exit(0);
    });
    console.log("TRACE_SMOKE_PORT=" + server.port);
  `], { cwd: directory, env: environment });
  const closed = once(host, "close");
  stopHost = async () => {
    if (host.exitCode !== null || host.signalCode !== null) return;
    host.stdin.end();
    const kill = setTimeout(() => host.kill(), 10_000);
    try { await closed; } finally { clearTimeout(kill); }
  };
  let hostError = "";
  host.stderr.on("data", (chunk: Buffer) => { hostError = (hostError + chunk.toString()).slice(-2000); });
  const lines = createInterface({ input: host.stdout });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenWork host did not start. ${hostError}`)), 30_000);
    lines.on("line", (line) => {
      if (!line.startsWith("TRACE_SMOKE_PORT=")) return;
      clearTimeout(timer);
      resolve(Number(line.slice("TRACE_SMOKE_PORT=".length)));
    });
    void closed.then(() => {
      clearTimeout(timer);
      reject(new Error(`OpenWork host exited. ${hostError}`));
    }, reject);
  });
  const call = async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      method: body ? "POST" : "GET", body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `${path} returned HTTP ${response.status}`);
    return response.json();
  };
  const native = "/workspace/ws_trace/opencode2/api";
  const deadline = Date.now() + 180_000;
  while (object.parse(await call("/experimental/engine-v2-preview/status")).running !== true) {
    assert.ok(Date.now() < deadline, "native engine did not start");
    await delay(250);
  }
  while (true) {
    const data = z.array(object).parse(envelope.parse(await call(`${native}/plugin`)).data);
    const entry = data.find((row) => row.id === "ensemble" || object.safeParse(row.source).data?.target === plugin);
    const state = object.safeParse(entry?.state).data;
    assert.notEqual(state?.status, "failed", `Ensemble setup failed: ${JSON.stringify(state)}`);
    if (entry?.id === "ensemble" && state?.status === "active") break;
    assert.ok(Date.now() < deadline, "Ensemble did not become active");
    await delay(250);
  }
  const lead = session.parse(envelope.parse(await call(`${native}/session`, { title: "TRACE smoke", agent: "build", model })).data);
  await call(`${native}/session/${lead.id}/prompt`, { text: "Run the TRACE fixture." });
  while (true) {
    assert.deepEqual(mock.failures, []);
    const sessions = z.array(session).parse(envelope.parse(await call(`${native}/session?limit=20`)).data);
    const children = sessions.filter((row) => row.parentID === lead.id);
    if (children.length === fixtures.length && children.every((row) => row.outcome === "succeeded")) {
      const workerResults = await Promise.all(children.map(async ({ id }) => {
        const rows = history.parse(envelope.parse(await call(`${native}/session/${id}/message?limit=20`)).data);
        return rows.flatMap((row) => row.content ?? []).flatMap((part) => {
          const result = toolResult.safeParse(part);
          return result.success ? [result.data] : [];
        });
      }));
      for (const fixture of fixtures) {
        assert.ok(workerResults.some((results) => results.some((result) => result.name === "read"
          && result.state.content?.some(({ text }) => text?.includes(fixture.fact)))), `missing ${fixture.name} file read`);
      }
      assert.ok(workerResults.every((results) => results.some((result) => result.name === "execute"
        && result.state.metadata?.toolCalls?.some(({ tool, status }) => tool === "team_message" && status === "completed"))),
      "both workers must report to the lead");
      assert.ok(mock.overlapped());
      break;
    }
    assert.ok(Date.now() < deadline, `expected two successful children, got ${JSON.stringify(children)}`);
    await delay(200);
  }
});
