"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export default function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
      className="px-4 py-1.5 rounded-lg text-sm font-medium
                 border border-[#1e1e38] text-[#7070a0]
                 hover:border-brand-blue hover:text-brand-blue
                 disabled:opacity-50 transition-colors"
    >
      {pending ? "Refreshing…" : "↻ Refresh"}
    </button>
  );
}
