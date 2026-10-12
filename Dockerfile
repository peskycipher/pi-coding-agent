# The donor image ships the helper that Files uses. Keep its tag equal to the
# installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:26-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git nano pipx python3 python3-pip python3-venv ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.1.0

# uv (static binaries, no installer script in the final image). Keep the tag equal to the
# uv in production use; it was the newest 0.9.x when pinned.
COPY --from=ghcr.io/astral-sh/uv:0.9.30 /uv /uvx /usr/local/bin/

# Registers the ollama-cloud provider with the model catalog the host Pi uses.
#
# shortcut: follow-through hard-skips JSON mode (its only safe context is an interactive
# session), so a harness task can never fire a continuation run. This harness is one-shot
# JSON, so the pin + sed below patch the mode gate to accept json; the grep fails the build
# if the extension ever changes shape. Upgrade: drop both when follow-through ships a modes
# setting upstream.
RUN pi install npm:pi-ollama-cloud-link \
  && pi install npm:pi-jev-lens \
  && pi install npm:@juicesharp/rpiv-todo \
  && pi install npm:pi-jev-anti-slop \
  && pi install npm:pi-jev-compaction \
  && pi install npm:pi-follow-through@0.1.4 \
  && pi install npm:@mjasnikovs/pi-task \
  && sed -i 's/ctx.mode !== "tui" && ctx.mode !== "rpc")/ctx.mode !== "tui" \&\& ctx.mode !== "rpc" \&\& ctx.mode !== "json")/' /root/.pi/agent/npm/node_modules/pi-follow-through/extensions/follow-through.ts \
  && grep -q 'ctx.mode !== "json") ||' /root/.pi/agent/npm/node_modules/pi-follow-through/extensions/follow-through.ts
# Classifiers are reachable only through codemode, which pi registers inactive by default.
# defaultProvider/defaultModel give NESTED pi invocations (pi-task's pi-worker spawns `pi --print`
# without --provider/--model) a working model; the harness argv overrides these for the main run.
RUN node -e "const fs=require('fs');const p='/root/.pi/agent/settings.json';const s=JSON.parse(fs.readFileSync(p,'utf8'));s.defaultTools=['+codemode'];s.defaultProvider='ollama-cloud';s.defaultModel='deepseek-v4.1-flash';fs.writeFileSync(p,JSON.stringify(s,null,2)+'\n')"
# specCheck crashes the process when another extension invalidates the runner mid-run
# (checkSpecFreshness → stale ctx → unhandled rejection); the harness never needs the probe.
COPY ollama_cloud.json /root/.pi/agent/ollama_cloud.json
# pi-task's worker children run `pi --no-extensions`; without the ollama-cloud provider they
# resolve no model credential and exit "No API key found". Whitelist the provider extension
# for children — pi-task's designed mechanism (config `extensionWhitelist`, `-e <path>`).
RUN mkdir -p /root/.config/pi-task \
  && printf '{"extensionWhitelist": ["/root/.pi/agent/npm/node_modules/pi-ollama-cloud-link/index.ts"]}\n' \
    > /root/.config/pi-task/config.json
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# Post-send pruning, matching the operator's host setup. The other JEV_LENS_* values the host sets
# are already the library defaults, so only the mode is mirrored.
ENV JEV_LENS_MODE=budget
WORKDIR /workspace
CMD ["sleep", "infinity"]
