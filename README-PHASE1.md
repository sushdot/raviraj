# Phase 1 — Order Automation (Raviraj Textiles)

The moment an order is paid, this makes the site automatically:
1. Send a WhatsApp + email confirmation
2. Generate an invoice PDF and email it
3. Create a shipment with Shiprocket and get a tracking number (AWB)
4. Send the tracking number to the customer (WhatsApp + email)
5. Reduce stock count on the products actually shipped

## Why this plugs in cleanly

Your `server.js` (Phase 0) already calls `notifyFulfillmentWebhook(order)` the instant
a payment is verified, POSTing full order + customer + item data to whatever
`FULFILLMENT_WEBHOOK_URL` you set. That's the exact trigger Phase 1 needs — no
WooCommerce webhook required, because this store isn't on WooCommerce; it's the
Supabase/Razorpay backend you already have. n8n just needs to sit at the other
end of that URL.

I made two small, additive changes to `server.js` for this phase (nothing else touched):
- `items` in the webhook payload now include `id` and `price` (needed to reduce stock and
  build the invoice/shipment) — previously only name/category/qty were sent.
- Two new endpoints, both locked behind a shared secret header so only your n8n workflow
  can call them: `POST /internal/reduce-stock` and `POST /internal/fulfillment-update`.

## Files in this phase

| File | Purpose |
|---|---|
| `phase1_migration.sql` | Adds `stock_count` to `products`, and `awb_code`/`courier_name`/`tracking_url`/etc. to `orders`. Run in Supabase SQL Editor. |
| `server.js` | Updated with the internal endpoints + richer webhook payload. Replaces your existing file. |
| `.env.example` | Adds `INTERNAL_API_SECRET`. |
| `phase1-order-automation.n8n.json` | The importable n8n workflow — the automation itself. |

---

## Step-by-step setup

### 1. Run the DB migration
Supabase Dashboard → SQL Editor → paste and run `phase1_migration.sql`.

### 2. Update stock counts
`stock_count` defaults to 20 for every existing product. Edit these to real numbers
in the Table Editor before going live, or automation will "sell" more than you have.

### 3. Deploy the updated `server.js`
Replace your current `server.js` with this one, add `INTERNAL_API_SECRET` to your real
`.env` (generate one with `openssl rand -hex 32`), and redeploy.

### 4. Set up Shiprocket
- Sign up free at shiprocket.in
- Add a **pickup location** (your Elampillai address) under Settings → Pickup Addresses —
  note its exact name, you'll need it as `SHIPROCKET_PICKUP_LOCATION`.
- Note your login email/password (used directly by the API — no separate API key).
- Shiprocket's API field names occasionally shift between versions — before going live,
  test the "Create Order" and "Assign AWB" calls once in Postman against
  https://apidocs.shiprocket.in/ and confirm the response paths used in the workflow
  (`payload.shipment_id`, `response.data.awb_code`, `response.data.courier_name`) still match.

### 5. Get a WhatsApp Cloud API token
If the Raviraj WhatsApp AI service (Phase 0, item #2) already uses Meta's WhatsApp Cloud
API, reuse that same **phone number ID** and **access token** here — same number, same app.
One important note: proactive messages like "your order shipped" sent outside a customer-initiated
24-hour conversation window require an approved **message template**, not free-form text. If your
account doesn't have one yet, request approval for a simple "order_shipped" / "order_confirmed"
template in Meta Business Manager, then swap the `"type": "text"` blocks in the workflow for
`"type": "template"` blocks referencing it.

### 6. Get an invoice-generator.com key (optional but recommended)
Free at invoice-generator.com — works without a key at low volume, a free key raises your limits.

### 7. Get a Resend API key
Free tier at resend.com. Verify your sending domain (or use their sandbox domain while testing)
so `orders@ravirajtextile.com` is a valid "from" address.

### 8. Install n8n
Pick one:
- **n8n Cloud** (~$20/mo, zero maintenance) — sign up at n8n.io, skip to step 9.
- **Self-hosted** (free): on a small VPS —
  ```bash
  docker run -d --name n8n -p 5678:5678 \
    -e WHATSAPP_PHONE_NUMBER_ID=xxx \
    -e WHATSAPP_ACCESS_TOKEN=xxx \
    -e INVOICE_GENERATOR_API_KEY=xxx \
    -e RESEND_API_KEY=xxx \
    -e SHIPROCKET_EMAIL=xxx \
    -e SHIPROCKET_PASSWORD=xxx \
    -e SHIPROCKET_PICKUP_LOCATION="Your Pickup Name" \
    -e BACKEND_URL=https://your-backend-domain.com \
    -e INTERNAL_API_SECRET=same_value_as_server_env \
    -v ~/.n8n:/home/node/.n8n \
    n8nio/n8n
  ```
  Optional package-related env vars (defaults shown): `SHIPROCKET_PKG_LENGTH_CM=30`,
  `SHIPROCKET_PKG_BREADTH_CM=25`, `SHIPROCKET_PKG_HEIGHT_CM=5`, `SHIPROCKET_WEIGHT_PER_ITEM_KG=0.5`.

### 9. Import the workflow
n8n → Workflows → Import from File → `phase1-order-automation.n8n.json`.

### 10. Point your backend at it
Copy the webhook's production URL from the "Order Paid Webhook" node (looks like
`https://your-n8n-host/webhook/raviraj-order-paid`), set it as `FULFILLMENT_WEBHOOK_URL`
in your backend's `.env`, and redeploy the backend.

### 11. Activate and test
Toggle the workflow to **Active** in n8n. Place a small real (or Razorpay test-mode) order
on the storefront. Watch the n8n execution log — you should see: WhatsApp confirmation →
invoice PDF → confirmation email → Shiprocket order → AWB assigned → tracking WhatsApp/email
→ stock reduced. Check the `orders` table in Supabase — `status` should flip to `shipped`
with `awb_code` filled in, and check `products.stock_count` dropped by the right amount.

---

## What happens if something fails

Every non-critical step (`WhatsApp`, `email`, `stock reduction`) is set to "continue on fail" in
the workflow, so one WhatsApp hiccup won't stop the invoice or shipment from being created. The
Shiprocket steps are **not** set to continue-on-fail, since a shipment either needs to exist or
needs a human to notice — n8n's execution list will show the failed run in red for you to check.
If you want proactive alerts instead of checking manually, add an **Error Trigger** workflow in
n8n later that fires on any failed execution and pings you on WhatsApp — happy to build that
next if you'd like.

## What's still manual after this
- Physically packing the order and handing it to the courier when they collect (Shiprocket
  arranges pickup, doesn't pack for you)
- Reviewing the `webhook_failures` table (Phase 0) periodically — genuinely rare, but that's
  where a failed *initial* webhook delivery (before n8n even received it) would show up

---

Next up whenever you're ready: **Phase 2 — abandoned cart + festival WhatsApp/email blasts**,
reusing the same n8n instance and WhatsApp/Resend credentials you just set up.
