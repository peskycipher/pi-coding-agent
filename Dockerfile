# The donor image ships the helper that Files uses. Keep its tag equal to the
# installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.1.0
# Registers the ollama-cloud provider with the model catalog the host Pi uses.
RUN pi install npm:pi-ollama-cloud-link \
  && pi install npm:pi-jev-lens
# Classifiers are reachable only through codemode, which pi registers inactive by default.
RUN node -e "const fs=require('fs');const p='/root/.pi/agent/settings.json';const s=JSON.parse(fs.readFileSync(p,'utf8'));s.defaultTools=['+codemode'];fs.writeFileSync(p,JSON.stringify(s,null,2)+'\n')"
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace
CMD ["sleep", "infinity"]
