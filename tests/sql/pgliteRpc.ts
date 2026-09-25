import type { RpcClient } from "../../lib/telegram/store";
import type { Db } from "./harness";

// Runs the bot's `tg_*` functions in real Postgres (PGlite) with the same
// call shape and result shape PostgREST gives the production adapter:
//   table-returning functions -> array of rows
//   scalar / jsonb functions  -> the bare value (void -> null)
//   timestamptz               -> ISO string (PostgREST), not a JS Date (pglite)
const SET_RETURNING = new Set(["tg_rate_consume", "tg_recent_campaigns", "tg_my_links", "tg_pending_counts"]);

function normalise(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalise(x)]));
  return v;
}

export function pgliteRpc(db: Db, hooks?: { onCall?: (fn: string) => void; failOn?: (fn: string) => Error | null }): RpcClient {
  return {
    async rpc(fn, args) {
      hooks?.onCall?.(fn);
      const injected = hooks?.failOn?.(fn);
      if (injected) throw injected;
      const keys = Object.keys(args);
      const params = keys.map((k) => {
        const v = args[k];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
      if (SET_RETURNING.has(fn)) {
        const r = await db.query(`SELECT * FROM public.${fn}(${named})`, params);
        return normalise(r.rows);
      }
      const r = await db.query<{ r: unknown }>(`SELECT public.${fn}(${named}) AS r`, params);
      return normalise(r.rows[0]?.r ?? null);
    },
  };
}
