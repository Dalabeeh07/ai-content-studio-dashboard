import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { serverClient } from "@/lib/supabase";

// Keep in sync with ../create-checkout-session/route.ts's price/tier.
const PRO_PLAN_CREDITS_LIMIT = 200;

export async function POST(req: NextRequest) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    return NextResponse.json({ error: "Stripe is not configured on the server yet." }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  const stripe = new Stripe(secretKey);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature ?? "", webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const hwid = session.metadata?.hwid ?? session.client_reference_id;

    if (!hwid) {
      console.error("Stripe webhook: checkout.session.completed with no hwid metadata", session.id);
      return NextResponse.json({ error: "Missing hwid metadata" }, { status: 400 });
    }

    const client = serverClient();
    if (!client) {
      console.error("Stripe webhook: serverClient() unavailable (Supabase env vars missing)");
      return NextResponse.json({ error: "Server not configured" }, { status: 500 });
    }

    const { data, error } = await client.rpc("upgrade_plan", {
      p_hwid: hwid,
      p_plan_type: "pro",
      p_credits_limit: PRO_PLAN_CREDITS_LIMIT,
    });
    if (error || !data?.ok) {
      console.error("upgrade_plan RPC failed:", error ?? data);
      return NextResponse.json({ error: "Database update failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
