// Pure formatting for the founder's export / "copy links" - shared by the
// streaming route and the client (copying a selection needs no round trip).

export interface ExportRow {
  campaign: string | null;   // campaign NAME, or null when unassigned
  platform: string;
  url: string;
  canonicalUrl: string | null;
  userEmail: string | null;
  hwid: string;
  telegram: string | null;   // "@handle" or numeric id
  submittedAt: string;
  status: string;
  whopSubmittedAt: string | null;
  source: string;
  flags: string[];
}

export const CSV_HEADER = [
  "campaign", "platform", "url", "canonical_url", "user", "device_id", "telegram",
  "submitted_at", "status", "whop_submitted_at", "source", "flags",
] as const;

/**
 * RFC-4180 quoting PLUS spreadsheet formula-injection defence: a cell that
 * begins with = + - @ (or a tab/CR) is prefixed with an apostrophe so Excel /
 * Sheets treat it as text. Handles and emails are user-controlled, so
 * "=HYPERLINK(...)" as a display name must not execute when the founder opens
 * the file.
 */
export function csvCell(v: string | null | undefined): string {
  let s = v ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(r: ExportRow): string {
  return [
    r.campaign, r.platform, r.url, r.canonicalUrl, r.userEmail, r.hwid, r.telegram,
    r.submittedAt, r.status, r.whopSubmittedAt, r.source, r.flags.join(" "),
  ].map(csvCell).join(",");
}

export function csvHeaderLine(): string {
  return CSV_HEADER.join(",");
}

export const NO_CAMPAIGN_LABEL = "(no campaign)";

/**
 * One URL per line, grouped campaign -> platform (rows MUST already arrive in
 * that order - the route guarantees it). A blank line separates groups and
 * optional "# Campaign - platform" comment lines label them (Whop is
 * submitted per campaign, so a group is one paste batch). Stateful so it
 * stays correct when the stream is fed chunk by chunk.
 */
export class TxtGrouper {
  private prev: string | null = null;
  constructor(private withHeaders: boolean) {}

  chunk(rows: Iterable<Pick<ExportRow, "campaign" | "platform" | "url">>): string {
    const out: string[] = [];
    for (const r of rows) {
      const key = `${r.campaign ?? ""}|${r.platform}`;
      if (key !== this.prev) {
        if (this.prev !== null) out.push("");
        if (this.withHeaders) out.push(`# ${r.campaign ?? NO_CAMPAIGN_LABEL} - ${r.platform}`);
        this.prev = key;
      }
      out.push(r.url);
    }
    return out.length ? out.join("\n") + "\n" : "";
  }
}

export function txtFromOrderedRows(rows: Iterable<Pick<ExportRow, "campaign" | "platform" | "url">>, withHeaders: boolean): string {
  return new TxtGrouper(withHeaders).chunk(rows);
}

/** Client-side ordering identical to the server's (campaign name, then platform, then oldest first). */
export function sortForExport<T extends { campaign: string | null; platform: string; submittedAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if ((a.campaign === null) !== (b.campaign === null)) return a.campaign === null ? 1 : -1; // unassigned last
    const c = (a.campaign ?? "").localeCompare(b.campaign ?? "");
    if (c !== 0) return c;
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    return a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0;
  });
}
