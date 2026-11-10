# TRACE-Agent development standards

TRACE-Agent extends OpenWork on `feat/*` branches. Integrate completed features into `dev`. Promote a verified version to `main` and mark it with a `trace-v*` tag. The initial OpenWork baseline is `098675d3c656abcc6ea314a011538a330d97c887`. It pins OpenCode v2.2.6. V0.1 uses Ensemble `0.20.0`.

## Code and ownership

- Follow the repository [agent instructions](../../AGENTS.md) and [design rules](../../DESIGN.md). Use pnpm, the existing TypeScript boundaries, shared components, and the repository's existing runners.
- Keep product rules and workspace authorization in OpenWork Server. Use existing Session and permission interfaces to communicate with OpenCode. Ensemble owns teams, member coordination, and shared task state. Keep execution evidence in its source system and expose a scoped projection to the renderer.
- Parse external inputs and engine responses at their boundaries. Check both the acting identity and workspace scope before side effects. Keep errors actionable and free of secrets or prompt content. Preserve upstream copyright and license notices when adapting code.
- Register new user-facing features with the OpenWork feature registry, default off. Verify both states and preserve readable history when a feature is disabled. Prefer one vertical change that can be demonstrated and reviewed on its own.

## Tests and evidence

| Layer | What to prove |
| --- | --- |
| Unit and contract | Input validation, access scope, state transitions, and rejection cases. Add failing regression cases for critical behavior before changing it. |
| Integration | Exercise the real OpenWork and OpenCode interfaces using isolated state and a scripted local model. Assert tool effects, distinct session identities, and overlapping execution intervals for a parallelism claim. |
| Desktop | Check the feature through the ordinary entry point, using the renderer and the shipping shell where the behavior depends on it. Verify keyboard operation, error and blocked states, and a narrow window. |
| Real-model smoke | Record model and runtime versions, prompts used, observable outcomes, and any failures. Keep it separate from deterministic regression tests. |
| Reliability | As durable dispatch lands, inject crashes before send and after admission, replay duplicate events, and assert that ambiguous outcomes wait for reconciliation. |

Run the relevant checks again after changing the candidate commit. Record the command, versions, exit status, and failed or skipped cases. A green scripted-model test proves the exercised execution path. Real-model behavior and desktop interaction have separate acceptance checks.

### Ensemble integration smoke

Use Git, the Node version required by the workspace, Bun, pnpm, and the OpenCode v2 executable pinned in `constants.json`. Set `OPENWORK_TEST_OPENCODE2` to the executable's absolute path and run from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm --filter openwork-server build
pnpm --filter openwork-server exec node --test test/trace-ensemble-native.test.ts
```

The test creates a disposable workspace and a local scripted model. The engine installs the pinned Ensemble package, which requires registry access on a cold cache. The test passes when both Worker requests reach a rendezvous before either may read its file, each file read succeeds, and both Workers complete the Ensemble report call. It skips explicitly when the engine binary is unspecified. Use a disposable profile and separate native engines for manual retests.

On Windows, the workspace install may need access to Node headers and the native build toolchain. For this server-only check, an install with `pnpm install --frozen-lockfile --ignore-scripts --filter openwork-server...` can be used when the server build and test both pass afterward. Desktop and packaging checks use the normal install and their own build prerequisites.

## Documentation and visuals

- Keep one reproducible quickstart with prerequisites, feature enablement, a disposable fixture, expected results, and troubleshooting. Each version records what is implemented and what has been verified.
- Keep architecture diagrams aligned with the code. Distinguish intent, dispatch, and execution ownership. Include the recovery boundary in a sequence diagram when that feature lands.
- Use real screenshots for visible behavior changes and cite relevant OpenWork design rules in the PR. Keep secrets, private workspace names, and local paths out of public evidence. Update the README and demo with the verified release.

The external references inform verification and React review. OpenWork defines the repository conventions. [Codex workflow reference](https://github.com/openai/openai-cookbook/blob/main/examples/codex/iterating-development-workflows-with-codex.md) · [Superpowers verification](https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md) · [Vercel React guidance](https://vercel.com/blog/introducing-react-best-practices)
