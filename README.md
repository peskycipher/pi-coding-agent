# pi-coding-agent

Runs [Pi](https://github.com/earendil-works/pi) on a GitHub repository inside a Cloudflare
Container, one task at a time, and reports the agent's changes as a diff. Served at
`https://code.proxyagent.rent` behind Cloudflare Access.

Ported from `cloudflare/sandbox-sdk` `examples/coding-agents/pi`, with two changes:

- the model provider is **Ollama Cloud** (`ollama-cloud`) instead of Cloudflare AI Gateway;
- the worker has a custom domain and is protected by Access.

## Routes

| Method   | Path                              | Purpose                          |
| -------- | --------------------------------- | -------------------------------- |
| `POST`   | `/sandboxes/{name}/repository`    | Clone a GitHub repository        |
| `POST`   | `/sandboxes/{name}/task`          | Start a task; body is the prompt |
| `GET`    | `/sandboxes/{name}/task`          | Poll: `running`/`succeeded`/`failed`/`lost`/`none` |
| `GET`    | `/sandboxes/{name}/events`        | Stream the agent's JSONL events  |
| `GET`    | `/sandboxes/{name}/diff`          | The change the agent made        |
| `DELETE` | `/sandboxes/{name}/execution`     | Reset the container to a fresh disk |

## Network access

The container has no internet access. An `Outbound` entrypoint in the Worker receives every HTTP
and HTTPS request from it and allows exactly three hosts:

- `ollama.com` — the Worker adds `OLLAMA_API_KEY` (a Worker secret), so the container never holds
  the account key.
- `api.typesafe.ai` — the Worker adds `TYPESAFE_API_KEY`, for TypeSafe's Jev classifier.
- `github.com` — the Worker adds `GITHUB_TOKEN` when it is set.

Every other host gets `403`.

## Classifiers

The image enables `codemode` in `/root/.pi/agent/settings.json`, because classifier models are
reachable only through it — they never appear in `/model`. The agent gets TypeSafe's `jev-latest`
with:

```js
const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");
const result = await models.classify(jev, {
  state: { message: "The change works, thanks." },
  questions: {
    approved: {
      type: "bool",
      instructions: "Does the user approve of the result?",
      criteria: { true: "Approval", false: "No approval" },
    },
  },
});
return result.answers;
```

## Deploy

```sh
npm install
npx wrangler secret put OLLAMA_API_KEY     # the Ollama Cloud account key
npx wrangler secret put TYPESAFE_API_KEY   # the TypeSafe account key
npm run deploy
```

`npm run deploy` regenerates `worker-configuration.d.ts`, then builds the container image and
deploys. The image is `node:24-bookworm-slim` plus Pi and seven packages:

- `pi-ollama-cloud-link` — registers the `ollama-cloud` provider, discovers its model catalog at
  runtime. The image ships an `ollama_cloud.json` that turns off `specCheck` (its probe crashes the
  process when another extension invalidates the runner mid-run) and the embeddings probe.
- `pi-jev-lens` — compresses large tool results before they reach the model; shares the TypeSafe
  key. The image mirrors the host's `JEV_LENS_MODE=budget`, and a fresh clone excludes its
  decision log `.pi/jev-lens.log` from the returned diff.
- `@juicesharp/rpiv-todo` — the `todo` tool for task tracking; state lives in the conversation,
  so `--no-session` sessions keep it.
- `pi-jev-anti-slop` — the `jev_review` tool (TypeSafe code review across
  quality/correctness/security/… scopes).
- `pi-jev-compaction` — JEV-driven compaction. Needs `TYPESAFE_API_KEY` (already wired) and
  otherwise runs at its defaults.
- `pi-follow-through` — Jev checks whether useful work remains after a run. Its README states it
  skips JSON and print modes, so in this harness it is installed but inert; it activates only if
  the invocation ever moves to RPC mode.
- `@mjasnikovs/pi-task` — the four `pi-worker*` tools. `pi-worker` spawns an isolated read-only
  child Pi; children run `--no-extensions`, so the image bakes a pi-task
  `extensionWhitelist` naming the ollama-cloud provider extension and a
  `defaultProvider`/`defaultModel` — without both, every child exits "No API key found".
  `pi-worker-search`/`-fetch`/`-docs` still depend on hosts the egress policy does not allow,
  so the agent will see fetch errors from them.

Deliberately out: `pi-jev-context-curator` (its decisions are unobservable in `--mode json`) and
`pi-goal-x` (its goal continuation needs an interactive session; in one-shot JSON mode
`create_goal` stops the run and the task reports an empty success). Re-add either if the harness
moves to RPC mode, where both behave.

Change the model with the `MODEL` variable in `wrangler.jsonc` — it is an Ollama Cloud model ID
such as `deepseek-v4.1-flash`, `kimi-k3`, or `glm-5.3`.

## Run a task

```sh
curl --request POST "https://code.proxyagent.rent/sandboxes/agent-1/repository" \
  --header "content-type: application/json" \
  --data '{"url": "https://github.com/OWNER/REPOSITORY"}'

curl --request POST "https://code.proxyagent.rent/sandboxes/agent-1/task" \
  --data 'Add a test for the parser.'

curl "https://code.proxyagent.rent/sandboxes/agent-1/task"
curl "https://code.proxyagent.rent/sandboxes/agent-1/diff"
```

`202` means the task started; a second task while one runs returns `409`. The prompt is one argument
of the agent's command, so a prompt of 128 KiB or more returns `413`.

The agent runs without permission prompts. The container is the sandbox: it can run any command in
it, but it reaches only the two hosts above.
