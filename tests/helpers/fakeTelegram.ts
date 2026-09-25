// A local stand-in for api.telegram.org, used to test the webhook route and
// the setWebhook script WITHOUT ever touching the real bot or its token.
// It records every call (with the token segment masked, so a test failure
// can print it safely) and can be told to fail.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedCall {
  method: string;            // e.g. "sendMessage"
  tokenSeen: string;         // what was in the /bot<token>/ segment (tests assert it equals the fake token)
  body: Record<string, unknown>;
}

export interface FakeTelegram {
  url: string;               // http://127.0.0.1:<port>
  calls: RecordedCall[];
  /** make every call to this API method fail with the given HTTP status (null = stop failing) */
  failMethod(method: string, status: number | null): void;
  /** value returned by getWebhookInfo */
  webhookInfo: Record<string, unknown>;
  close(): Promise<void>;
}

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const calls: RecordedCall[] = [];
  const failing = new Map<string, number>();
  const state = { webhookInfo: { url: "", pending_update_count: 0 } as Record<string, unknown> };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? "");
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* ignore */ }
      if (!m) { res.writeHead(404).end("{}"); return; }
      const [, tokenSeen, method] = m;
      calls.push({ method, tokenSeen, body });
      const status = failing.get(method);
      if (status) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error_code: status, description: `Simulated failure of ${method}` }));
        return;
      }
      let result: unknown = true;
      if (method === "getWebhookInfo") result = state.webhookInfo;
      if (method === "setWebhook") {
        state.webhookInfo = { url: body.url, pending_update_count: 0, allowed_updates: body.allowed_updates, max_connections: body.max_connections };
      }
      if (method === "deleteWebhook") state.webhookInfo = { url: "", pending_update_count: 0 };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    failMethod: (method, status) => { if (status === null) failing.delete(method); else failing.set(method, status); },
    get webhookInfo() { return state.webhookInfo; },
    set webhookInfo(v) { state.webhookInfo = v; },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
