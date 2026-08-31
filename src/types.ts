export interface Env {
  KOTON: KVNamespace;
  PORT_LIST: string;
  PROBE_TIMEOUT_MS?: string;
  AUTH_TOKEN?: string;
}

export interface ProbeResult {
  host: string;
  port: number;
  state: "open" | "closed" | "timeout" | "error";
  error?: string;
}
