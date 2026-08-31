import { Env, ProbeResult } from "./types";
import { probe } from "./probe";

export function statusCode(results: ProbeResult[], open: ProbeResult[]): number {
  if (results.length === 0) return 540;
  if (open.length > 0) return 541;
  return 200;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }

    if (env.AUTH_TOKEN && request.headers.get("Authorization") !== `Bearer ${env.AUTH_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const ports = env.PORT_LIST.split(",").map(Number);
    const timeoutMs = parseInt(env.PROBE_TIMEOUT_MS || "3000");

    const listing = await env.KOTON.list({ prefix: "targets/" });
    const ipsLastPushed: Record<string, string> = {};
    const probes: Promise<ProbeResult>[] = [];

    for (const key of listing.keys) {
      const raw = await env.KOTON.get(key.name);
      if (!raw) continue;

      const hostLabel = key.name.replace(/^targets\//, "");
      const data = JSON.parse(raw) as { addresses: string[]; pushed_at?: string };
      if (data.pushed_at) ipsLastPushed[hostLabel] = data.pushed_at;

      for (const host of data.addresses) {
        for (const port of ports) {
          probes.push(probe(host, port, timeoutMs));
        }
      }
    }

    const results = await Promise.all(probes);
    const open = results.filter((r) => r.state === "open");
    const errors = results.filter((r) => r.state === "error");
    const status = statusCode(results, open);

    return new Response(JSON.stringify({ ok: status === 200, ipsLastPushed, open, errors, results }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  },
};
