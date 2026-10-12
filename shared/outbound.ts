import { WorkerEntrypoint } from "cloudflare:workers";

import type { CodingAgentEnv } from "./sandbox";

const OLLAMA_HOST = "ollama.com";
const TYPESAFE_HOST = "api.typesafe.ai";
const GITHUB_HOST = "github.com";
// Public PyPI package hosts (pip/pipx/uv). No credentials apply — package installs fetch public
// packages, and the container must never see a key.
const PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"];

// Guest HTTP on port 80 and HTTPS on port 443 reach this entrypoint; other ports have no route.
// Credentials stay in the Worker.
export class Outbound extends WorkerEntrypoint<CodingAgentEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The Worker fetches with the guest's scheme, so a credential added to plain HTTP would cross
    // the Internet unencrypted.
    if (url.protocol !== "https:") {
      return new Response(`${url.hostname} is reachable only over HTTPS\n`, { status: 403 });
    }
    if (url.hostname === OLLAMA_HOST) {
      const headers = new Headers(request.headers);
      // The agent needs a key to reach its provider; the placeholder would be rejected here.
      headers.set("authorization", `Bearer ${this.env.OLLAMA_API_KEY}`);
      return fetch(new Request(request, { headers }));
    }
    if (url.hostname === TYPESAFE_HOST) {
      const headers = new Headers(request.headers);
      // Both spellings: the classifier path reads one of them, and the placeholder is not a key.
      headers.set("authorization", `Bearer ${this.env.TYPESAFE_API_KEY}`);
      headers.set("x-api-key", this.env.TYPESAFE_API_KEY);
      return fetch(new Request(request, { headers }));
    }
    if (PYPI_HOSTS.includes(url.hostname)) return fetch(request);
    if (url.hostname === GITHUB_HOST) {
      if (this.env.GITHUB_TOKEN === undefined) return fetch(request);
      const headers = new Headers(request.headers);
      headers.set("authorization", `Basic ${btoa(`x-access-token:${this.env.GITHUB_TOKEN}`)}`);
      return fetch(new Request(request, { headers }));
    }
    if (PYPI_HOSTS.includes(url.hostname)) return fetch(request);
    return new Response(`${url.hostname} is not reachable from this sandbox\n`, { status: 403 });
  }
}
