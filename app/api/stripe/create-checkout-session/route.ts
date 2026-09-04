import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

// PLACEHOLDER — one upgrade tier for now. STRIPE_PRO_PRICE_ID must point at
// a real recurring Price you create in the Stripe dashboard; PRO_CREDITS_LIMIT
// must match the number of credits that price is meant to grant (also used
// in ../webhook/route.ts when the upgrade actually completes — keep both in
// sync if you change this).
const PRO_PLAN_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID ?? "";

export async function POST(req: NextRequest) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey || !PRO_PLAN_PRICE_ID) {
    return NextResponse.json(
      { error: "Stripe is not configured on the server yet." },
      { status: 503 }
    );
  }

  let hwid: unknown;
  try {
    ({ hwid } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!hwid || typeof hwid !== "string") {
    return NextResponse.json({ error: "Missing hwid" }, { status: 400 });
  }

  const stripe = new Stripe(secretKey);
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRO_PLAN_PRICE_ID, quantity: 1 }],
      success_url: `${origin}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/upgrade/cancel`,
      metadata: { hwid },
      client_reference_id: hwid,
    });
    if (!session.url) {
      return NextResponse.json({ error: "Stripe did not return a Checkout URL" }, { status: 500 });
    }
    return NextResponse.json({ url: session.url });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Stripe error" },
      { status: 500 }
    );
  }
}
