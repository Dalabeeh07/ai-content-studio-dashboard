# Telegram link bot — simple setup guide (no technical knowledge needed)

**What this does:** your creators send the link of each video they posted to the bot
**@PlovikaLinksBot** on Telegram. You see every link on the dashboard, copy them per campaign,
paste them into Whop yourself, and tick them off.

Everything below is already installed on the website. You only need to do these steps **once**.

---

## Part 1 — Tell Telegram where to send messages (5 minutes, once)

You need two secret things. Keep them private — never send them to anyone in chat.

* **The bot token** — the long text like `123456789:AAF...` that @BotFather gave you when you made the bot.
  (Lost it? In Telegram open **@BotFather** → send `/mybots` → tap **PlovikaLinksBot** → **API Token**.)
* **The webhook secret** — the same value you saved into Vercel under the name `TELEGRAM_WEBHOOK_SECRET`.
  *Don't remember it?* No problem, make a new one: see "Forgot the webhook secret" at the bottom.

**Steps**

1. Press the **Windows key**, type **PowerShell**, press **Enter**. A blue window opens.
2. Type this and press **Enter** (it moves PowerShell to the right folder):
   ```
   cd D:\AI-Content-Studio\dashboard
   ```
3. Copy **this whole block**, paste it into the blue window (right-click pastes), and press **Enter**:
   ```
   function Ask($p){ $s = Read-Host $p -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
   $env:TELEGRAM_BOT_TOKEN = Ask "Paste the BOT TOKEN then press Enter"
   $env:TELEGRAM_WEBHOOK_SECRET = Ask "Paste the WEBHOOK SECRET then press Enter"
   $env:TELEGRAM_WEBHOOK_URL = "https://ai-studio-dashboard.vercel.app/api/telegram/webhook"
   ```
4. It asks for the bot token. **Paste it and press Enter.** (You will see stars or nothing — that is normal, it hides secrets.)
5. It asks for the webhook secret. **Paste it and press Enter.**
6. Check that everything is typed correctly. Type this and press **Enter**:
   ```
   node scripts/set-telegram-webhook.mjs --dry-run
   ```
   You should see `[dry-run] environment is valid`. If you see a red "Cannot continue" message, read it — it says exactly which value is wrong.
7. Now do it for real. Type this and press **Enter**:
   ```
   node scripts/set-telegram-webhook.mjs
   ```
   You should see `Webhook registered: https://ai-studio-dashboard.vercel.app/api/telegram/webhook`.
8. Check it worked. Type this and press **Enter**:
   ```
   node scripts/set-telegram-webhook.mjs --info
   ```
   You should see `last error: none`. (If it says `401`, the secret you typed is not the same as the one in Vercel — see the bottom.)
9. **Close the blue window.** That erases the secrets from the computer's memory.

---

## Part 2 — Connect yourself (2 minutes)

1. Open the dashboard: **https://ai-studio-dashboard.vercel.app** and log in.
2. Click **Users** (left menu). Find your own row.
3. In the **Telegram** column click **Generate code**. A box opens with a code like `K7QM-R2XP`.
   **It is shown only once** — click **Copy code**, then **I've copied it — close**.
4. On your phone open **Telegram**, search **@PlovikaLinksBot**, tap it, tap **Start**.
5. Type `/link ` then paste your code, and send. Example: `/link K7QM-R2XP`
   You should get: **✅ تم ربط حسابك بنجاح**.
6. Now send the bot a real TikTok / Instagram / YouTube Shorts / X link of one of your posted videos.
   You should get: **✅ تم تسجيل TikTok …** and "your links today: 1".
7. On the dashboard click **Submissions**. Your link is there, marked **via Telegram**.

If all of that worked, the system is live.

---

## Part 3 — Adding a creator

1. Dashboard → **Users** → the creator's row → **Generate code**.
2. Click **Copy message for the user (ع / EN)** — it copies a ready message in Arabic and English.
3. Send that message to the creator (WhatsApp, etc.). They tap the link in it (or type `/link CODE`) and they are connected.
4. A code works **once** and lasts **7 days**. To disconnect someone: **Users** → their row → **Revoke** → **Confirm revoke**.
5. If they get a new phone or new Telegram account: just **Generate code** again for them (the old connection is replaced).

---

## Part 4 — Your daily routine on the Submissions page

1. Click **Submissions**. At the top you see **"Telegram links waiting for Whop"** and one button per campaign with the number waiting.
2. Click a campaign button (for example *Gaming 120*). The list shows only that campaign's waiting links.
3. Click **⧉ Copy pending links**. All the waiting links are copied — grouped by campaign, then platform, one link per line.
4. Paste them into Whop for that campaign.
5. Back on the dashboard: tick the small box in the table header (selects the page). A blue bar appears: click
   **"Select all … matching this filter"**, then **✓ Mark submitted to Whop**.
6. Made a mistake? A green message appears with an **Undo** button — click it within 20 seconds.
   (Later you can also filter **Whop → Submitted**, tick rows, and press **Unmark**.)
7. **Export CSV** downloads a spreadsheet of what you're looking at (up to 50,000 rows).

Things you may notice in the table:
* **no campaign** (orange) — the bot could not tell which campaign the creator used. Use the **Assign…** menu on that row (or select many rows → *Assign campaign…* → *Apply*).
* **⚠ also sent by another user** (red) — someone else tried to submit the same link. Hover to see who. Worth a look.
* **license inactive** — the creator's license was not active when they sent it.
* **short link** — a shortened link (like vm.tiktok.com). It is saved exactly as sent.

When a new link arrives while the page is open you hear a sound and see a green bar **"N new submissions — click to refresh"**.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| The bot does not answer at all | Repeat Part 1 step 8 (`--info`). If it says `last error: … 401`, the two secrets don't match — see below. If it says the URL is empty, repeat Part 1 step 7. |
| "الكود غير صحيح أو منتهي الصلاحية" (code invalid) | The code was already used, is older than 7 days, or has a typo. Generate a **new** code. |
| "محاولات كثيرة" (too many attempts) | Someone typed wrong codes 5 times. Wait 15 minutes, then try again with the correct code. |
| Users page shows a yellow "Telegram link status unavailable" bar | Tell me — it means the database part is missing. |
| Generate code says "TELEGRAM_WEBHOOK_SECRET is not set on the server" | The secret is missing in Vercel: see below. |

### Forgot the webhook secret (or want to change it)

1. Go to **vercel.com** → your project **ai-studio-dashboard** → **Settings** → **Environment Variables**.
2. Find `TELEGRAM_WEBHOOK_SECRET` → **Edit** → type a new value (letters and numbers only, at least 16 characters, e.g. a long random password without spaces) → **Save**.
3. Go to **Deployments** → the top one → **⋯** → **Redeploy**. (Vercel only uses the new value after a redeploy.)
4. Repeat **Part 1** using that same new value. (Any codes you generated *before* the change stop working — generate new ones.)
