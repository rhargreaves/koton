import { connect } from "cloudflare:sockets";
import { ProbeResult } from "./types";

export function stateFromError(err: unknown): { state: ProbeResult["state"]; error?: string } {
  const msg = String((err as { message?: string })?.message || err);
  if (msg === "timeout") return { state: "timeout" };
  if (
    msg.includes("refused") ||
    msg.includes("reset") ||
    msg.includes("closed") ||
    msg.includes("cannot connect")
  ) {
    return { state: "closed" };
  }
  return { state: "error", error: msg };
}

export async function probe(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  const target = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  try {
    const socket = connect({ hostname: target, port });
    try {
      await Promise.race([
        socket.opened,
        new Promise((_, reject) => {
          const signal = AbortSignal.timeout(timeoutMs);
          signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
        }),
      ]);
      return { host, port, state: "open" };
    } finally {
      socket.close().catch(() => {});
    }
  } catch (err) {
    return { host, port, ...stateFromError(err) };
  }
}
