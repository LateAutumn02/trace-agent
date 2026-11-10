# TRACE-Agent team runs

Feature key `traceTeamRuns` · self-hosted · default off · owner `LateAutumn02`.

TRACE-Agent asks an OpenCode v2 lead to start two Ensemble `explore` workers with the workspace's selected model. OpenWork's authenticated engine proxy exposes the lead and worker sessions. Open a session to inspect the original conversation and tool results.

Use a disposable workspace for the preview. The lead prompt asks both workers to use the existing workspace and avoid network tools. Ensemble chooses the worker permissions from the configured agent. The default `explore` profile can expose tools such as web search, so use the deterministic smoke test for an isolated example.

## Enable and try it

1. Use a local workspace on a managed OpenCode v2 host. Enable `traceTeamRuns` in the self-hosted deployment feature settings.
2. Add the pinned plugin to `.opencode/opencode.json` in that workspace. Merge the entry into any existing `plugins` list.

   ```json
   { "plugins": ["@hueyexe/opencode-ensemble@0.20.0"] }
   ```

3. Set `.opencode/ensemble.json` to `{ "dashboardPort": 0 }` for this integration. Reload the engine and choose a model that can invoke Code Mode tools.
4. Open a fresh chat in the workspace, select **Run a team review**, and enter two independent review prompts. Both worker rows should receive a session link. Open the lead session to see their reports.

For a manual fixture, create a disposable Git workspace with `login.txt` containing `Account locks after five failures.` and `database.txt` containing `Connection pool limit is eight.`. **Use sample tasks** fills the two prompts. Expect **Finished** and the corresponding fact in each row. **Open worker** opens the original session with the file-read steps.

The first run may wait for the engine to install the plugin. If the launcher reports that Ensemble is unavailable, verify the workspace configuration and retry the availability check. If launch admission is uncertain, inspect the lead session before starting another run.

Turning off the feature removes the launcher. Existing sessions stay in OpenWork history and retain their normal controls.

The [development standards](../../trace-agent/development.md) describe the deterministic integration test and its acceptance criteria.

## Preview verification

The Windows browser preview used OpenCode 2.2.6, Ensemble 0.20.0, and a scripted local provider. The two workers read separate fixture files and reported through Ensemble. The results view showed both findings, and the worker link opened the original session. Packaged Electron and external-model smoke checks are separate release gates.
