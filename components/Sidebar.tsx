"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";

const NAV = [
  { label: "Dashboard",     href: "/",              icon: "◈" },
  { label: "Users",         href: "/users",          icon: "👤" },
  { label: "Clips",         href: "/clips",          icon: "✂" },
  { label: "Notifications", href: "/notifications",  icon: "🔔" },
  { label: "Licenses",      href: "/licenses",       icon: "🔑" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }, [router]);

  // Don't render sidebar on /login
  if (pathname.startsWith("/login")) return null;

  return (
    <aside
      className="w-[220px] min-h-screen flex flex-col shrink-0
                 bg-bg-surface border-r border-border"
    >
      {/* Logo */}
      <div className="px-5 py-6 border-b border-border">
        <span className="text-brand-blue font-bold text-base leading-none">
          AI Content Studio
        </span>
        <span className="block text-muted text-[11px] mt-0.5">Admin Panel</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 flex flex-col gap-0.5 px-3">
        {NAV.map(({ label, href, icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm
                          transition-colors duration-100 select-none
                          ${active
                            ? "bg-brand-blue/10 text-brand-blue font-semibold"
                            : "text-muted hover:text-text hover:bg-bg-card"
                          }`}
            >
              <span className="text-base leading-none w-5 text-center">{icon}</span>
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="p-3 border-t border-border">
        <button
          onClick={handleLogout}
          className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg
                     text-sm text-muted hover:text-brand-orange hover:bg-bg-card transition-colors"
        >
          <span className="text-base leading-none w-5 text-center">⏻</span>
          Sign out
        </button>
      </div>
    </aside>
  );
}
