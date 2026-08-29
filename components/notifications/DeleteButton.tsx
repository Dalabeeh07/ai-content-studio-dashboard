"use client";

import { useTransition } from "react";
import { deleteNotification } from "@/app/notifications/actions";

export default function DeleteButton({ notifId }: { notifId: string }) {
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    if (!confirm("Delete this notification and all delivery records?")) return;
    startTransition(() => { void deleteNotification(notifId); });
  }

  return (
    <button
      onClick={handleDelete}
      disabled={pending}
      className="px-3 py-1 rounded-md text-xs font-medium
                 bg-[#141428] border border-[#1e1e38]
                 text-brand-orange hover:border-brand-orange hover:bg-[#2a1010]
                 disabled:text-[#3a3a60] disabled:border-[#1e1e38] disabled:cursor-not-allowed
                 transition-colors"
    >
      {pending ? "…" : "Delete"}
    </button>
  );
}
