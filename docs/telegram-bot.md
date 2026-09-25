# Telegram link-intake bot (@PlovikaLinksBot)

Creators post their clips from a phone and send the post URL to the bot. The bot
records each link against the creator (and, when it can, the campaign). **You
submit the collected links to Whop Content Rewards by hand** — Whop has no API
and nothing here automates or scrapes it. The dashboard's job is to make that
manual step fast: filter, copy per campaign, mark as submitted, undo.

```
 phone ──/link CODE, post URLs──▶ Telegram ──POST + secret header──▶ /api/telegram/webhook
                                                                        │ 1. constant-time secret check (else 401, zero DB access)
                                                                        │ 2. body cap, JSON parse, private-text/callback filter
                                                                        │ 3. update_id claim (idempotent)      ── tg_claim_update
                                                                        │ 4. rate limits                        ── tg_rate_consume
                                                                        │ 5. URL hardening → tg_submit_links (dedupe, flags)
                                                                        │ 6. reply via Bot API (never fails the request)
 Dashboard  Users page ── generate one-time code / revoke ──▶ tg_create_link_code / tg_revoke_link_admin
            Submissions ── filters · pagination · copy · CSV · bulk mark/undo ──▶ video_submissions
```

## Founder runbook (in order)

1. **Apply the SQL.** Open `supabase/migrations/041_telegram_link_intake.sql`, paste it into the
   Supabase SQL Editor, run it. It must finish with no error (it ends with a safety block that
   raises if any privilege is not exactly as intended). Re-running it is safe. Then tell me it is applied.
2. **Deploy** (I do this after you confirm): `git push vercel-repo HEAD:main`, then `git push origin master`.
3. **Register the webhook** (you run it, so the token never passes through me). In PowerShell, from the `dashboard` folder:
   ```powershell
   $env:TELEGRAM_BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host "Bot token" -AsSecureString)))
   $env:TELEGRAM_WEBHOOK_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host "Webhook secret" -AsSecureString)))
   $env:TELEGRAM_WEBHOOK_URL = "https://<your-dashboard-domain>/api/telegram/webhook"
   node scripts/set-telegram-webhook.mjs --dry-run     # validates the values, no network
   node scripts/set-telegram-webhook.mjs               # registers it
   node scripts/set-telegram-webhook.mjs --info        # confirm: url, pending updates, last error
   ```
   * Vercel env vars of type *Secret* cannot be read back, so paste the same two values here yourself
     (or put them in the git-ignored `dashboard/.env.local` and use `node --env-file=.env.local scripts/...`).
   * The webhook secret you type here **must equal** the `TELEGRAM_WEBHOOK_SECRET` in Vercel, or every
     update is rejected with 401 (`--info` will show `last error: ... 401`).
   * `--drop-pending` discards updates queued while no webhook was set. `--delete` removes the webhook.
4. **Link yourself.** Dashboard → Users → your row → **Generate code**. Copy the code (it is shown once).
5. **From your phone:** open @PlovikaLinksBot → `/link ABCD-EFGH` → then send a real TikTok/Instagram/Shorts/X link.
   The reply should say ✅ and show your count for the day. (The dialog also gives a `t.me/...?start=CODE`
   link that pre-fills `/start CODE` — one tap.)
6. **Verify** it appears on Dashboard → Submissions (source *via Telegram*).

## Behaviour and decisions

| Topic | Decision |
|---|---|
| Chats | Private chats only. Groups, channels, bots, `edited_message`, stickers/photos without a caption are dropped **before any DB write**. `allowed_updates` = `message`, `callback_query`. |
| Edited messages | **Ignored** (not even requested): an edit could otherwise rewrite an already-recorded link. Send a new message instead. |
| Language | Arabic by default; English only if Telegram's `language_code` is `en*`. `/lang` (toggle, or `/lang ar` / `/lang en`) is stored per user. |
| Linking | Founder generates a code per user (8 chars, 31-symbol unambiguous alphabet ≈ 40 bits, single-use, 7 days, bound to that user's hwid). Only an **HMAC** of the code is stored (key derived from `TELEGRAM_WEBHOOK_SECRET`); the code is shown once. A new code invalidates older unused ones. |
| One-to-one | One Telegram account ↔ one hwid, one hwid ↔ at most one *active* Telegram account (partial unique indexes). **Re-link:** a fresh code for an already-linked hwid *replaces* the old Telegram account (old link revoked with `revoked_by='relink'`, history kept). A linked account must `/unlink` (with a confirmation button) before linking elsewhere. Founder **Revoke** kills the link and any unused code immediately. |
| Brute force | Per account: 5 `/link` attempts / 15 min. Global: 300 / 10 min across all accounts. Attempts count whether or not they succeed; malformed codes never reach the DB; a linked account is refused before it can spend an attempt. Unknown / expired / used / revoked codes get the **same** reply. |
| Rate limits | Per Telegram user: 30 URLs / 10 min and 300 URLs / day (only URLs of a supported shape consume quota; a message that straddles the limit records what fits and reports the rest), 40 messages / min (over that the bot goes silent), max 20 URLs per message (rest reported as ignored). Counters are atomic rows in Postgres (serverless has no shared memory). Constants: `lib/telegram/config.ts`. |
| URLs | Parsed with the WHATWG `URL`; **exact-host** allow-list (`tiktok.com`, `www./m./vm./vt.tiktok.com`, `instagram.com`, `www.instagram.com`, `youtube.com`, `www./m.youtube.com`, `youtu.be`, `x.com`, `twitter.com`, `www.`/`mobile.` variants). Rejected before parsing: userinfo `@`, `%`, non-ASCII/fullwidth/punycode hosts, brackets, backslashes, explicit ports, IP hosts, non-http(s) schemes, >2048 chars. http is upgraded to https. **All query strings and fragments are dropped** (none is needed to identify a post). YouTube accepts Shorts (`/shorts/ID`, `youtu.be/ID`) only. |
| Never fetched | URLs are **never resolved or fetched server-side** (SSRF / latency). Short links (`vm.`/`vt.tiktok.com`, `tiktok.com/t/…`, `instagram.com/share/…`) are stored as sent (cleaned), flagged `short_link`, and are not de-duplicated against the full URL. Your export shows them as-is. |
| Canonical / dedupe | `canonical_url` is a *dedupe identity* (handle dropped for TikTok/X, `/p/<code>` for every Instagram kind, `/shorts/<id>` for both YouTube forms) and is **globally unique**. It is not necessarily an openable URL — exports use `video_url`. Same link from the same user → "already submitted". Same link from a different user → the first row is kept and flagged `duplicate_of_other_user`, the attempt is logged (`telegram_duplicate_attempts`, shown on hover in the dashboard), and the second user is told it was already submitted (without saying by whom). A Telegram *retry* of the update that created a row is reported as accepted, never as a false duplicate. |
| Campaign attribution | The linked hwid's distinct, non-deleted campaigns in `campaign_exports` in the **last 48 h**. **0** → stored with no campaign (assign it on the Submissions page); **1** → assigned automatically and named in the reply; **≥2** → links are saved first (campaign NULL) and the bot asks with inline buttons (most recent first, max 5). Each button carries a random single-use token bound to that user **and** chat, expiring in 30 min; only rows still NULL are changed. |
| License status | A link from a user whose license is not active is **accepted and flagged** `license_inactive` (visible under *Flags → Suspicious*), not rejected. |
| Idempotency | Every update_id is claimed in `telegram_updates`. Duplicates / replays / concurrent deliveries are acknowledged and not processed again. A claim that never finished (crash) may be retried after 60 s, at most 3 times. |
| Status codes | `401` bad/missing secret (no DB access, body never read) · `413` body > 64 KB · `503` server not configured, **or** the database is unreachable *before* the update was claimed (Telegram redelivers, so no link is lost during a DB blip) · `200` everything else, including failures after the claim (the user is told to retry). This deliberately deviates from "always 200". |
| Replies | HTML parse mode; every user-controlled value is escaped; URLs are shown scheme-less and bidi-isolated; link previews off; long replies are cut on whole lines only. A failed reply never fails the webhook or loses the saved link. |
| "Today" | The UTC day, matching the desktop app's UTC-midnight daily reset. |

### Commands
`/start` · `/help` · `/link CODE` · `/mylinks` (last 10 with status; shows when a link was sent to Whop) ·
`/count` (today) · `/unlink` (confirm) · `/lang`. Unknown commands show help.

## Data, privacy and retention

Stored: Telegram user id, username (if any), language, timestamps, and the **submitted URLs**. No message
bodies, no license keys/hwid ever requested from the user. Cleanup runs in the existing daily cron
(`/api/cron/cleanup` → `tg_cleanup`):

| Table | Kept |
|---|---|
| `telegram_updates` | 3 days |
| `telegram_rate_limits` | window end + 2 days |
| `telegram_pending_choices` | 1 day after expiry |
| `telegram_link_codes` | 30 days after use / expiry / revoke |
| `telegram_links` (revoked) | 90 days (active links: as long as linked) |
| `telegram_users` | while they exist (only created on link or `/lang`) |
| `video_submissions` | kept — business records, never touched by cleanup |

All seven `telegram_*` tables have RLS on, deny-all policies, `REVOKE ALL` from `anon`/`authenticated`;
every `tg_*` function is executable by `service_role` only.

## Founder tooling (Submissions page)

* **Filters** (in the URL, re-validated server-side): source, Whop pending/submitted, campaign / no campaign,
  platform, status, flags (dup / license inactive / short link / suspicious), UTC date range, free-text search,
  one user. **Server-side pagination** (25–200 per page); nothing loads the whole table.
* **Pending counters** per campaign/platform (Telegram rows only — desktop-app rows were already submitted to
  Whop by the creators themselves, per migration 009). Click a chip to filter.
* **Copy pending links** / **Export CSV**: ordered campaign → platform → oldest first (unassigned last), one URL
  per line, streamed in 1,000-row chunks, hard cap 50,000 rows reported in `X-Export-*` headers, spreadsheet
  formula-injection safe, UTF-8 BOM.
* **Bulk**: tick rows, or **Select all N matching** → *Mark submitted to Whop* (idempotent: already-marked rows
  keep their original time) · *Undo* (exact batch) · *Unmark* · *Assign campaign* · *Copy links*.
  "Select all matching" is pinned to a snapshot time and the count you saw; if the set changed, the action
  refuses and changes nothing. Every mutation re-checks the admin session and reports honest row counts
  (0 rows is an error, never a silent success).
* New live rows raise a "N new — click to refresh" banner (plus the existing sound/notification) rather than
  reshuffling a paginated list.

## Configuration

| Variable | Where | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Vercel (Secret) | server only; never logged or returned |
| `TELEGRAM_WEBHOOK_SECRET` | Vercel (Secret) | 16–256 chars `A-Za-z0-9_-`; header secret **and** root of the link-code hash key. Rotating it invalidates unused codes (regenerate them). |
| `TELEGRAM_WEBHOOK_URL` | your shell, script only | exactly `https://<domain>/api/telegram/webhook` |
| `TELEGRAM_API_BASE` | tests only | honoured only for `http://127.0.0.1` / `localhost` |

## Tests

```powershell
npm test                     # unit + real-Postgres (PGlite) suites: URL pipeline, codes, security helpers, filters/CSV,
                             #   webhook script, migration 041 + every RPC, and the handler/webhook running the real SQL
npx next build              # required before the integration suites (they run a real `next start`)
# Real infrastructure (needs migration 041 applied; keep the Submissions page closed - inserts stream via Realtime):
node --env-file=.env.local --import tsx tests/integration/webhook-preflight.ts          # no tables needed
node --env-file=.env.local --import tsx --test tests/integration/db-security.test.ts    # anon denied, grants, desktop RPC, Realtime
node --env-file=.env.local --import tsx --test tests/integration/webhook-e2e.test.ts    # real server + real DB + real concurrency
node --env-file=.env.local --import tsx --test tests/integration/tooling.test.ts        # 10.5k rows: pagination, filters, export, bulk
```
All integration data is prefixed `TEST_TG_` / Telegram ids ≥ 9,100,000,000 and is deleted afterwards; each suite
asserts every table's row count is back to its starting value. The real bot and token are never used
(a fake Telegram runs on 127.0.0.1).

To re-verify privileges yourself in the SQL Editor:
```sql
SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_can
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'tg\_%' ORDER BY 1;   -- anon_can must be false everywhere
SELECT t, has_any_column_privilege('anon', 'public.'||t, 'SELECT') AS anon_can_read
FROM unnest(ARRAY['telegram_users','telegram_links','telegram_link_codes','telegram_updates','telegram_rate_limits','telegram_pending_choices','telegram_duplicate_attempts']) t;  -- all false
```

## Known limitations / follow-ups

* Short links are not resolved, so a short link and its full URL are treated as different posts.
* Desktop-app rows have no `canonical_url` (the unchanged RPC does not compute one), so they are not de-duplicated
  against Telegram rows. A one-off backfill script would fix this.
* The bot does not push notifications (e.g. when you mark a link *verified*, or revoke a link) — `/mylinks` shows status on request.
* No per-platform validity check (a well-formed URL to a deleted video is still recorded).
* `youtu.be/<id>` may be a normal video rather than a Short; it cannot be told apart without fetching.
* Export is capped at 50,000 rows (reported in headers); very large backlogs should be exported per campaign.
* Whop-side automation is intentionally out of scope.
