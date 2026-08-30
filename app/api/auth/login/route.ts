import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  const adminPassword = (process.env.ADMIN_PASSWORD ?? "").trim();

  // DEBUG — remove after diagnosis
  console.log("[login] ADMIN_PASSWORD raw:", JSON.stringify(process.env.ADMIN_PASSWORD));
  console.log("[login] ADMIN_PASSWORD trimmed:", JSON.stringify(adminPassword));
  console.log("[login] received password:", JSON.stringify(password?.trim()));
  console.log("[login] match:", password?.trim() === adminPassword);

  if (!adminPassword || password.trim() !== adminPassword) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("admin_auth", adminPassword, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // secure: true, // enable in production
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
  return res;
}
