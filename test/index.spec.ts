import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../src/index";
import * as probeModule from "../src/probe";

describe("Koton Worker", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Clear KV keys before each test
    const listing = await env.KOTON.list();
    for (const key of listing.keys) {
      await env.KOTON.delete(key.name);
    }
  });

  async function dispatchRequest(request: Request, customEnv = env) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, customEnv);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("returns 404 for non-/check endpoints or non-GET methods", async () => {
    const getRoot = await dispatchRequest(new Request("http://example.com/"));
    expect(getRoot.status).toBe(404);

    const postCheck = await dispatchRequest(
      new Request("http://example.com/check", { method: "POST" })
    );
    expect(postCheck.status).toBe(404);
  });

  it("enforces authentication when AUTH_TOKEN is configured", async () => {
    const authEnv = { ...env, AUTH_TOKEN: "secret-token-123" };

    // Request with missing header
    const unauthorizedReq = new Request("http://example.com/check");
    const unauthorizedRes = await dispatchRequest(unauthorizedReq, authEnv);
    expect(unauthorizedRes.status).toBe(401);

    // Request with invalid token
    const badTokenReq = new Request("http://example.com/check", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    const badTokenRes = await dispatchRequest(badTokenReq, authEnv);
    expect(badTokenRes.status).toBe(401);

    // Request with valid token
    const validTokenReq = new Request("http://example.com/check", {
      headers: { Authorization: "Bearer secret-token-123" },
    });
    const validTokenRes = await dispatchRequest(validTokenReq, authEnv);
    expect(validTokenRes.status).toBe(540); // 540 because KV targets are empty
  });

  it("returns status 540 when no targets exist in KV", async () => {
    const req = new Request("http://example.com/check");
    const res = await dispatchRequest(req);

    expect(res.status).toBe(540);
    const body = (await res.json()) as {
      ok: boolean;
      ipsLastPushed: Record<string, string>;
      open: unknown[];
      results: unknown[];
    };
    expect(body.ok).toBe(false);
    expect(body.ipsLastPushed).toEqual({});
    expect(body.open).toEqual([]);
    expect(body.results).toEqual([]);
  });

  it("probes all configured ports and returns 200 when all ports are closed/timeout", async () => {
    // Put target data in KV
    const targetData = {
      addresses: ["2001:db8::1", "2001:db8::2"],
      pushed_at: "2026-08-31T12:00:00Z",
    };
    await env.KOTON.put("targets/server-01", JSON.stringify(targetData));

    // Mock probe to return closed / timeout
    const probeSpy = vi.spyOn(probeModule, "probe").mockImplementation(async (host, port) => {
      return { host, port, state: port === 22 ? "closed" : "timeout" };
    });

    const req = new Request("http://example.com/check");
    const res = await dispatchRequest(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      ipsLastPushed: Record<string, string>;
      open: unknown[];
      errors: unknown[];
      results: Array<{ host: string; port: number; state: string }>;
    };

    expect(body.ok).toBe(true);
    expect(body.ipsLastPushed).toEqual({ "server-01": "2026-08-31T12:00:00Z" });
    expect(body.open).toHaveLength(0);
    expect(body.errors).toHaveLength(0);

    // 2 addresses * 3 ports (22, 80, 443 from wrangler.toml) = 6 probes
    expect(body.results).toHaveLength(6);
    expect(probeSpy).toHaveBeenCalledTimes(6);
    expect(probeSpy).toHaveBeenCalledWith("2001:db8::1", 22, 3000);
    expect(probeSpy).toHaveBeenCalledWith("2001:db8::2", 443, 3000);
  });

  it("returns status 541 when any probe finds an open port", async () => {
    await env.KOTON.put(
      "targets/server-02",
      JSON.stringify({
        addresses: ["2001:db8::2"],
        pushed_at: "2026-08-31T12:05:00Z",
      })
    );

    vi.spyOn(probeModule, "probe").mockImplementation(async (host, port) => {
      if (port === 80) {
        return { host, port, state: "open" };
      }
      return { host, port, state: "closed" };
    });

    const req = new Request("http://example.com/check");
    const res = await dispatchRequest(req);

    expect(res.status).toBe(541);
    const body = (await res.json()) as {
      ok: boolean;
      ipsLastPushed: Record<string, string>;
      open: Array<{ host: string; port: number; state: string }>;
    };

    expect(body.ok).toBe(false);
    expect(body.open).toEqual([{ host: "2001:db8::2", port: 80, state: "open" }]);
  });

  it("captures probe errors into errors array without marking open", async () => {
    await env.KOTON.put(
      "targets/server-03",
      JSON.stringify({
        addresses: ["2001:db8::3"],
      })
    );

    vi.spyOn(probeModule, "probe").mockImplementation(async (host, port) => {
      return { host, port, state: "error", error: "network unreachable" };
    });

    const req = new Request("http://example.com/check");
    const res = await dispatchRequest(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      errors: Array<{ host: string; port: number; state: string; error?: string }>;
      open: unknown[];
    };

    expect(body.ok).toBe(true);
    expect(body.errors).toHaveLength(3);
    expect(body.errors[0]).toEqual({
      host: "2001:db8::3",
      port: 22,
      state: "error",
      error: "network unreachable",
    });
    expect(body.open).toHaveLength(0);
  });
});
