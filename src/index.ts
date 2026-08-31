import { connect } from "cloudflare:sockets";

export interface Env {
  KOTON: KVNamespace;
  PORT_LIST: string;
  PROBE_TIMEOUT_MS?: string;
  AUTH_TOKEN?: string;
}

interface Target {
  host: string;
  ports: number[];
}

interface ProbeResult {
  host: string;
  port: number;
  state: "open" | "closed" | "error";
  error?: string;
}

interface GeneralErrorResult {
  error: string;
}

type ErrorResult = ProbeResult | GeneralErrorResult;

type Outcome = { state: "open" | "closed" | "error"; error?: string };

const parsePorts = (raw?: string): number[] =>
  (raw || "")
    .split(",")
    .map((p) => parseInt(p.trim(), 10))
    .filter((p) => Number.isInteger(p) && p > 0);

function sleep(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

async function probe(host: string, port: number, timeoutMs: number): Promise<Outcome> {
  // connect() requires IPv6 literals to be wrapped in brackets [::1]
  const target = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  let socket;
  try {
    socket = connect({ hostname: target, port });
  } catch (error) {
    return { state: "error", error: String(error) };
  }

  const outcome = await Promise.race([
    socket.opened.then(
      () => "open" as const,
      (error) => ({ state: "error" as const, error: String(error) }),
    ),
    sleep(timeoutMs),
  ]);

  try {
    await socket.close();
  } catch {
    /* socket already closed */
  }

  if (outcome === "open") return { state: "open" };
  if (outcome === "timeout") return { state: "closed" };
  return outcome;
}

async function loadTargets(env: Env): Promise<{
  targets: Target[];
  ipsLastPushed: Record<string, string>;
  configError?: string;
}> {
  const configuredPorts = parsePorts(env.PORT_LIST);
  if (configuredPorts.length === 0) {
    return {
      targets: [],
      ipsLastPushed: {},
      configError: "PORT_LIST environment variable is required and must contain at least one valid port number",
    };
  }

  const listing = await env.KOTON.list({ prefix: "targets/" });
  const targets: Target[] = [];
  const ipsLastPushed: Record<string, string> = {};

  for (const key of listing.keys) {
    const raw = await env.KOTON.get(key.name);
    if (!raw) continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }

    const hostLabel = key.name.replace(/^targets\//, "");

    // Format 1: Object with addresses and timestamp { addresses: [...], pushed_at: "..." }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      if (typeof obj.pushed_at === "string") {
        ipsLastPushed[hostLabel] = obj.pushed_at;
      }
      const addrs = obj.addresses ?? obj.addrs;
      if (Array.isArray(addrs)) {
        for (const entry of addrs) {
          if (typeof entry === "string") {
            targets.push({ host: entry, ports: configuredPorts });
          }
        }
      }
      continue;
    }

    // Format 2: Single string IP/hostname
    if (typeof data === "string") {
      targets.push({ host: data, ports: configuredPorts });
      continue;
    }

    // Format 3: Array of IP strings or target objects [{ host, ports }]
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (typeof entry === "string") {
          targets.push({ host: entry, ports: configuredPorts });
        } else {
          const obj = entry as Record<string, unknown>;
          const host = (obj.host ?? obj.ip ?? "") as string;
          const explicit = obj.ports as number[] | undefined;
          targets.push({
            host,
            ports: Array.isArray(explicit) && explicit.length ? explicit : configuredPorts,
          });
        }
      }
    }
  }

  return { targets, ipsLastPushed };
}

async function runProbe(env: Env): Promise<{
  results: ProbeResult[];
  open: ProbeResult[];
  errors: ErrorResult[];
  ipsLastPushed: Record<string, string>;
  configError?: string;
}> {
  const { targets, ipsLastPushed, configError } = await loadTargets(env);
  if (configError) {
    return { results: [], open: [], errors: [{ error: configError }], ipsLastPushed, configError };
  }

  const timeoutMs = parseInt(env.PROBE_TIMEOUT_MS || "5000", 10);
  const tasks: Promise<ProbeResult>[] = [];

  for (const target of targets) {
    for (const port of target.ports) {
      tasks.push(
        probe(target.host, port, timeoutMs).then((outcome) => ({
          host: target.host,
          port,
          ...outcome,
        }))
      );
    }
  }

  const results = await Promise.all(tasks);
  const open = results.filter((r) => r.state === "open");
  const errors: ErrorResult[] = results.filter((r) => r.state === "error");
  return { results, open, errors, ipsLastPushed };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }

    if (env.AUTH_TOKEN) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const { results, open, errors, ipsLastPushed, configError } = await runProbe(env);

    if (configError) {
      return new Response(JSON.stringify({ ok: false, error: configError }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        },
      });
    }

    let status: number;
    let ok: boolean;
    if (results.length === 0) {
      status = 540;
      ok = false;
    } else {
      ok = open.length === 0;
      status = ok ? 200 : 541;
    }

    const body = { ok, ipsLastPushed, open, errors, results };
    if (status === 540) {
      errors.push({ error: "No targets to check" });
    }

    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Expires": "0",
      },
    });
  },
};
