/**
 * Raviraj Textiles — Backend for secure Razorpay checkout
 * Persistence: Supabase (PostgreSQL) via @supabase/supabase-js
 * Fulfillment: forwards paid orders to an external automation webhook
 * ---------------------------------------------------------------
 * SETUP:
 * 1. Install Node.js (v18+): https://nodejs.org
 * 2. In your project folder:
 *      npm init -y
 *      npm install express cors razorpay dotenv @supabase/supabase-js axios
 * 3. Run orders_table.sql, webhook_failures_table.sql, and
 *    products_table.sql (all provided alongside this file) in the
 *    Supabase SQL Editor.
 * 4. Create a ".env" file with:
 *      RAZORPAY_KEY_ID=your_key_id_here
 *      RAZORPAY_KEY_SECRET=your_key_secret_here
 *      RAZORPAY_WEBHOOK_SECRET=your_webhook_secret_here     (optional)
 *      SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
 *      SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
 *      FULFILLMENT_WEBHOOK_URL=https://your-automation-hub.com/hooks/orders
 *
 *    SUPABASE_SERVICE_ROLE_KEY and FULFILLMENT_WEBHOOK_URL are server
 *    secrets — never expose them to the browser or commit them to git.
 * 5. Run: node server.js
 * 6. Deploy on Render.com / Railway.app / a VPS.
 * 7. In store.html:
 *      - set ORDER_API_URL to this server's /create-order endpoint
 *      - when building the `items` array for /create-order, include
 *        category and pricingTier per line, e.g.:
 *          items: cartLines().map(l => ({
 *            id: l.p.id, name: l.p.name, category: l.p.cat,
 *            pricingTier: pricingMode, qty: l.qty, price: currentPrice(l.p)
 *          }))
 *        (the fulfillment payload below reads item.category /
 *        item.pricingTier, so this frontend change is required.)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------
// Clients
// ---------------------------------------------------------------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const ORDERS_TABLE = "orders";
const WEBHOOK_FAILURES_TABLE = "webhook_failures";

// ---------------------------------------------------------------
// Phase 1 — internal automation endpoints (called by n8n, never by
// the browser). Protected by a shared secret header, NOT by Razorpay
// or Supabase auth, because the caller here is your own automation
// hub, not a customer or a payment gateway.
// ---------------------------------------------------------------
function requireInternalSecret(req, res, next) {
  const provided = req.headers["x-internal-secret"];
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) {
    console.error("INTERNAL_API_SECRET not set — refusing internal request.");
    return res.status(500).json({ error: "Server not configured for internal calls" });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Invalid or missing internal secret" });
  }
  next();
}

// ---------------------------------------------------------------
// In-memory diagnostic buffer — a fast, inspectable window into recent
// webhook failures. This is NOT the durable record (Supabase is), it's
// a convenience for `GET /diagnostics/webhook-failures` during on-call
// debugging without needing a DB query. It's capped so it can't leak
// memory, and it is lost on restart by design — durability lives in
// the webhook_failures table.
// ---------------------------------------------------------------
const diagnosticQueue = [];
const DIAGNOSTIC_QUEUE_MAX = 200;
function pushDiagnostic(entry) {
  diagnosticQueue.unshift({ ...entry, loggedAt: new Date().toISOString() });
  if (diagnosticQueue.length > DIAGNOSTIC_QUEUE_MAX) diagnosticQueue.length = DIAGNOSTIC_QUEUE_MAX;
}

// ---------------------------------------------------------------
// Fulfillment webhook — notify the external automation hub that an
// order has been paid, so it can trigger packing/shipping/dropship flow.
//
// Design intent: this must NEVER cause /verify-payment to fail or delay
// the customer's success response. A flaky third-party automation tool
// is not the customer's problem. Failures are caught, logged to both
// an in-memory diagnostic buffer and a persisted Supabase table (so an
// ops process can retry later), and swallowed.
// ---------------------------------------------------------------
async function notifyFulfillmentWebhook(order) {
  const webhookUrl = process.env.FULFILLMENT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("FULFILLMENT_WEBHOOK_URL not configured — skipping fulfillment notification.");
    return;
  }

  const payload = {
    orderId: order.receipt_id,
    razorpayPaymentId: order.razorpay_payment_id,
    paymentCompletedAt: order.paid_at,
    amount: order.amount,
    currency: order.currency || "INR",
    customer: {
      name: order.customer_name,
      phone: order.customer_phone,
      email: order.customer_email,
      address: order.address,
      pincode: order.pincode,
    },
    items: (order.items || []).map((item) => ({
      id: item.id ?? null,
      name: item.name,
      category: item.category ?? null,
      pricingTier: item.pricingTier ?? null,
      quantity: item.qty ?? item.quantity ?? null,
      price: item.price ?? null,
    })),
  };

  try {
    const response = await axios.post(webhookUrl, payload, {
      timeout: 8000,
      headers: { "Content-Type": "application/json" },
      validateStatus: (status) => status >= 200 && status < 300,
    });

    console.log(
      `✅ Fulfillment webhook delivered for order ${order.receipt_id} (status ${response.status})`
    );
  } catch (err) {
    const failureDetail = {
      orderId: order.receipt_id,
      razorpayOrderId: order.razorpay_order_id,
      webhookUrl,
      errorMessage: err.message,
      errorCode: err.code || null,
      responseStatus: err.response ? err.response.status : null,
      responseBody: err.response ? err.response.data : null,
      payload,
    };

    // 1. Fast in-memory diagnostic buffer for immediate on-call visibility
    pushDiagnostic(failureDetail);
    console.error("❌ Fulfillment webhook failed:", failureDetail.errorMessage, {
      orderId: failureDetail.orderId,
      status: failureDetail.responseStatus,
    });

    // 2. Durable record in Supabase so a retry job (cron, queue worker,
    //    or manual ops action) can pick it up later. This insert is
    //    itself wrapped in try/catch — a logging failure must never
    //    throw back into the request lifecycle.
    try {
      await supabase.from(WEBHOOK_FAILURES_TABLE).insert({
        order_receipt_id: failureDetail.orderId,
        razorpay_order_id: failureDetail.razorpayOrderId,
        webhook_url: failureDetail.webhookUrl,
        error_message: failureDetail.errorMessage,
        response_status: failureDetail.responseStatus,
        payload: failureDetail.payload,
        resolved: false,
      });
    } catch (persistErr) {
      console.error(
        "❌ Also failed to persist webhook failure to Supabase (in-memory diagnostic still holds it):",
        persistErr.message
      );
    }
    // Intentionally no re-throw — caller (/verify-payment) must still
    // return success to the customer regardless of this failure.
  }
}

// ---------------------------------------------------------------
// STEP 1 — Create a Razorpay order + persist a 'created' row in Supabase
// ---------------------------------------------------------------
app.post("/create-order", async (req, res) => {
  try {
    const { amount, orderId, name, phone, email, addr, pin, items } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (!name || !phone || !addr) {
      return res.status(400).json({ error: "Missing customer details" });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(amount * 100), // paise
      currency: "INR",
      receipt: orderId,
      notes: { name, phone, pin },
    });

    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .insert({
        receipt_id: orderId,
        razorpay_order_id: razorpayOrder.id,
        status: "created",
        amount,
        currency: "INR",
        customer_name: name,
        customer_phone: phone,
        customer_email: email || null,
        address: addr,
        pincode: pin,
        items: items || [], // expected shape: [{id,name,category,pricingTier,qty,price}, ...]
      })
      .select()
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ error: "Could not save order" });
    }

    res.json({ razorpayOrderId: razorpayOrder.id, orderRowId: data.id });
  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ error: "Could not create order" });
  }
});

// ---------------------------------------------------------------
// STEP 2 — Verify payment signature, mark the row 'paid', then hand off
// to fulfillment. The fulfillment call is awaited (so its logs land
// before the response, which is nice for observability) but its
// outcome — success or failure — is deliberately NOT allowed to change
// the HTTP response sent to the customer. Payment is already verified
// and captured by Razorpay at this point; fulfillment delivery is a
// separate concern with its own failure/retry path.
// ---------------------------------------------------------------
app.post("/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: "Missing verification fields" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      await supabase
        .from(ORDERS_TABLE)
        .update({ status: "failed" })
        .eq("razorpay_order_id", razorpay_order_id);

      return res.status(400).json({ success: false, error: "Signature mismatch" });
    }

    const { data: order, error } = await supabase
      .from(ORDERS_TABLE)
      .update({
        status: "paid",
        razorpay_payment_id,
        paid_at: new Date().toISOString(),
      })
      .eq("razorpay_order_id", razorpay_order_id)
      .select()
      .single();

    if (error) {
      console.error("Supabase update error:", error);
      return res.status(500).json({ success: false, error: "Could not update order" });
    }
    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    console.log("✅ Verified paid order:", order.receipt_id, order.razorpay_payment_id);

    // Forward to supplier / fulfillment automation hub. Errors here are
    // fully contained inside notifyFulfillmentWebhook — this line will
    // never throw, and the customer response below is unaffected either way.
    await notifyFulfillmentWebhook(order);

    res.json({ success: true, order });
  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ success: false, error: "Verification failed" });
  }
});

// ---------------------------------------------------------------
// OPTIONAL — Razorpay webhook (backup path if the customer closes the
// tab before /verify-payment completes on the client side)
// ---------------------------------------------------------------
app.post(
  "/razorpay-webhook",
  express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }),
  async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET || "")
      .update(req.rawBody)
      .digest("hex");

    if (signature !== expected) {
      return res.status(400).json({ received: false, error: "Invalid webhook signature" });
    }

    const event = req.body.event;
    if (event === "payment.captured") {
      const payment = req.body.payload.payment.entity;
      const { data: order } = await supabase
        .from(ORDERS_TABLE)
        .update({ status: "paid", razorpay_payment_id: payment.id, paid_at: new Date().toISOString() })
        .eq("razorpay_order_id", payment.order_id)
        .select()
        .single();

      console.log("✅ Webhook confirmed payment for order:", payment.order_id);
      if (order) await notifyFulfillmentWebhook(order);
    }

    res.json({ received: true });
  }
);

// ---------------------------------------------------------------
// Diagnostics — quick on-call visibility into recent fulfillment
// webhook failures without needing a DB console open.
// ---------------------------------------------------------------
app.get("/diagnostics/webhook-failures", (req, res) => {
  res.json({ count: diagnosticQueue.length, failures: diagnosticQueue });
});

// ---------------------------------------------------------------
// Live product catalogue — consumed by store.html's fetchProductCatalog()
// on page load. Returns an array of products shaped for the storefront.
// ---------------------------------------------------------------
app.get("/api/products", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("id, name, category, retail_price, wholesale_price, mrp, tag, swatch_class, in_stock")
      .eq("in_stock", true)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase products query error:", error);
      return res.status(500).json({ error: "Could not load catalogue" });
    }

    // Reshape snake_case DB columns into the camelCase-ish keys the
    // frontend's normalizeProduct() already expects.
    const products = data.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      retail: row.retail_price,
      wholesale: row.wholesale_price,
      mrp: row.mrp,
      tag: row.tag,
      cls: row.swatch_class,
      inStock: row.in_stock,
    }));

    res.json(products);
  } catch (err) {
    console.error("api/products error:", err);
    res.status(500).json({ error: "Could not load catalogue" });
  }
});

// ---------------------------------------------------------------
// Read endpoint — handy for an admin dashboard later
// ---------------------------------------------------------------
app.get("/orders/:razorpayOrderId", async (req, res) => {
  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .select("*")
    .eq("razorpay_order_id", req.params.razorpayOrderId)
    .single();

  if (error) return res.status(404).json({ error: "Order not found" });
  res.json(data);
});

// ---------------------------------------------------------------
// Phase 1 — reduce stock after a paid order ships. Called by the n8n
// order-automation workflow, once, after Shiprocket confirms the
// shipment (not right after payment — you want stock to reflect
// what's actually been committed to a courier, not just paid-for).
//
// Body: { items: [{ id: "<product uuid>", qty: 2 }, ...] }
// ---------------------------------------------------------------
app.post("/internal/reduce-stock", requireInternalSecret, async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array required" });
    }

    const results = [];
    for (const item of items) {
      if (!item.id || !item.qty) continue;

      const { data: product, error: fetchErr } = await supabase
        .from("products")
        .select("id, stock_count")
        .eq("id", item.id)
        .single();

      if (fetchErr || !product) {
        results.push({ id: item.id, ok: false, error: "Product not found" });
        continue;
      }

      const newCount = Math.max(0, product.stock_count - item.qty);
      const { error: updateErr } = await supabase
        .from("products")
        .update({ stock_count: newCount, in_stock: newCount > 0 })
        .eq("id", item.id);

      results.push({ id: item.id, ok: !updateErr, newStockCount: newCount });
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error("reduce-stock error:", err);
    res.status(500).json({ error: "Could not reduce stock" });
  }
});

// ---------------------------------------------------------------
// Phase 1 — record shipment/tracking info once Shiprocket has created
// the shipment and assigned an AWB (tracking number). Called by n8n
// right after the Shiprocket "assign AWB" step.
//
// Body: {
//   orderId (= receipt_id), shiprocketOrderId, shiprocketShipmentId,
//   awbCode, courierName, trackingUrl, invoiceUrl
// }
// ---------------------------------------------------------------
app.post("/internal/fulfillment-update", requireInternalSecret, async (req, res) => {
  try {
    const {
      orderId,
      shiprocketOrderId,
      shiprocketShipmentId,
      awbCode,
      courierName,
      trackingUrl,
      invoiceUrl,
    } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "orderId required" });
    }

    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .update({
        status: "shipped",
        shiprocket_order_id: shiprocketOrderId || null,
        shiprocket_shipment_id: shiprocketShipmentId || null,
        awb_code: awbCode || null,
        courier_name: courierName || null,
        tracking_url: trackingUrl || null,
        invoice_url: invoiceUrl || null,
        shipped_at: new Date().toISOString(),
      })
      .eq("receipt_id", orderId)
      .select()
      .single();

    if (error) {
      console.error("fulfillment-update Supabase error:", error);
      return res.status(500).json({ error: "Could not update order" });
    }
    if (!data) {
      return res.status(404).json({ error: "Order not found" });
    }

    console.log(`✅ Order ${orderId} marked shipped — AWB ${awbCode}`);
    res.json({ success: true, order: data });
  } catch (err) {
    console.error("fulfillment-update error:", err);
    res.status(500).json({ error: "Could not update fulfillment info" });
  }
});

// ---------------------------------------------------------------
// Phase 2 — reporting & segmentation endpoints (called by the
// "Raviraj Textiles - Phase 2 Reporting & Segmentation" n8n workflow).
// Same shared-secret protection as the Phase 1 internal routes above.
//
// NOTE on "today": this uses the Render server's own clock (UTC on
// Render by default), not IST. If your daily numbers look ~5.5 hours
// off from what you'd expect for the Indian business day, that's why —
// let me know if you want this pinned to IST instead.
// ---------------------------------------------------------------

// GET /internal/daily-summary
// Returns today's order count, today's revenue (paid orders only), and
// how many paid orders are still waiting to be shipped.
app.get("/internal/daily-summary", requireInternalSecret, async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfDayIso = startOfDay.toISOString();

    const { data: todaysPaidOrders, error: paidErr } = await supabase
      .from(ORDERS_TABLE)
      .select("amount")
      .eq("status", "paid")
      .gte("paid_at", startOfDayIso);

    if (paidErr) {
      console.error("daily-summary paid orders error:", paidErr);
      return res.status(500).json({ error: "Could not load daily summary" });
    }

    const orderCount = todaysPaidOrders.length;
    const revenue = todaysPaidOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0);

    const { count: pendingShipping, error: pendingErr } = await supabase
      .from(ORDERS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("status", "paid");

    if (pendingErr) {
      console.error("daily-summary pending-shipping error:", pendingErr);
      return res.status(500).json({ error: "Could not load daily summary" });
    }

    res.json({ orderCount, revenue, pendingShipping: pendingShipping ?? 0 });
  } catch (err) {
    console.error("daily-summary error:", err);
    res.status(500).json({ error: "Could not load daily summary" });
  }
});

// GET /internal/low-stock?threshold=5
// Returns in-stock products at or below the given stock threshold.
app.get("/internal/low-stock", requireInternalSecret, async (req, res) => {
  try {
    const threshold = Number(req.query.threshold) || 5;

    const { data, error } = await supabase
      .from("products")
      .select("id, name, stock_count")
      .lte("stock_count", threshold)
      .order("stock_count", { ascending: true });

    if (error) {
      console.error("low-stock error:", error);
      return res.status(500).json({ error: "Could not load low stock items" });
    }

    const items = data.map((p) => ({ id: p.id, name: p.name, stock: p.stock_count }));
    res.json({ items });
  } catch (err) {
    console.error("low-stock error:", err);
    res.status(500).json({ error: "Could not load low stock items" });
  }
});

// GET /internal/customers-summary
// There's no separate customers table — a "customer" here is identified
// by phone number, aggregated across their orders. Only orders that
// actually resulted in payment count toward orderCount/totalSpent
// (created/failed/cancelled orders are excluded).
app.get("/internal/customers-summary", requireInternalSecret, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("customer_phone, customer_name, amount, status")
      .in("status", ["paid", "shipped", "delivered"]);

    if (error) {
      console.error("customers-summary error:", error);
      return res.status(500).json({ error: "Could not load customers summary" });
    }

    const byPhone = new Map();
    for (const order of data) {
      const phone = order.customer_phone;
      if (!phone) continue;
      if (!byPhone.has(phone)) {
        byPhone.set(phone, {
          customerId: phone,
          phone,
          name: order.customer_name,
          orderCount: 0,
          totalSpent: 0,
        });
      }
      const entry = byPhone.get(phone);
      entry.orderCount += 1;
      entry.totalSpent += Number(order.amount || 0);
    }

    res.json({ customers: Array.from(byPhone.values()) });
  } catch (err) {
    console.error("customers-summary error:", err);
    res.status(500).json({ error: "Could not load customers summary" });
  }
});

// POST /internal/update-customer-tag
// Body: { customerId, tag }  — customerId is the customer's phone number.
app.post("/internal/update-customer-tag", requireInternalSecret, async (req, res) => {
  try {
    const { customerId, tag } = req.body;
    if (!customerId || !tag) {
      return res.status(400).json({ error: "customerId and tag are required" });
    }
    if (!["first-time", "repeat", "high-value"].includes(tag)) {
      return res.status(400).json({ error: "Invalid tag" });
    }

    const { data, error } = await supabase
      .from("customer_tags")
      .upsert(
        { customer_phone: customerId, tag, updated_at: new Date().toISOString() },
        { onConflict: "customer_phone" }
      )
      .select()
      .single();

    if (error) {
      console.error("update-customer-tag error:", error);
      return res.status(500).json({ error: "Could not update customer tag" });
    }

    res.json({ success: true, customerTag: data });
  } catch (err) {
    console.error("update-customer-tag error:", err);
    res.status(500).json({ error: "Could not update customer tag" });
  }
});

// ---------------------------------------------------------------
// Phase 3-5 — marketing, support follow-up, and inventory/reporting
// endpoints (called by the "Raviraj Textiles - Phase 3-5 Growth
// Automations" n8n workflow). Same shared-secret protection as all
// other /internal/* routes.
//
// Each "candidate" GET route below returns rows that (a) match a
// business condition and (b) have NOT already had that specific email
// sent (tracked via one-shot boolean flags added in
// phase3_migration.sql). After n8n successfully sends the email, it
// calls the matching "mark-*-sent" route so the same order/customer
// is never emailed twice for the same reason.
// ---------------------------------------------------------------

// Only these columns may be flipped true via /internal/mark-order-flag.
// Whitelisting prevents the endpoint from being used to blindly
// overwrite arbitrary columns (e.g. "status") via a bad/compromised
// n8n call.
const ALLOWED_ORDER_FLAGS = new Set([
  "abandoned_email_sent",
  "review_email_sent",
  "welcome_email_sent",
  "failed_followup_email_sent",
  "invoice_email_sent",
  "owner_alert_sent",
  "stale_shipment_alert_sent",
]);

// GET /internal/abandoned-carts
// Orders started (Razorpay order created) but never paid, between 30
// minutes and 48 hours ago. The lower bound gives real slow checkouts
// time to finish; the upper bound stops emailing about week-old junk.
app.get("/internal/abandoned-carts", requireInternalSecret, async (req, res) => {
  try {
    const now = Date.now();
    const lower = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const upper = new Date(now - 30 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("id, receipt_id, customer_name, customer_email, amount, items, created_at")
      .eq("status", "created")
      .eq("abandoned_email_sent", false)
      .not("customer_email", "is", null)
      .gte("created_at", lower)
      .lte("created_at", upper);

    if (error) {
      console.error("abandoned-carts error:", error);
      return res.status(500).json({ error: "Could not load abandoned carts" });
    }

    const orders = data.map((o) => ({
      id: o.id,
      receiptId: o.receipt_id,
      customerName: o.customer_name,
      customerEmail: o.customer_email,
      amount: o.amount,
      items: o.items || [],
      createdAt: o.created_at,
    }));
    res.json({ orders });
  } catch (err) {
    console.error("abandoned-carts error:", err);
    res.status(500).json({ error: "Could not load abandoned carts" });
  }
});

// GET /internal/review-candidates
// Orders shipped/delivered 3-4 days ago (a 1-day window so the daily
// cron catches each order exactly once).
app.get("/internal/review-candidates", requireInternalSecret, async (req, res) => {
  try {
    const now = Date.now();
    const lower = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();
    const upper = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("id, receipt_id, customer_name, customer_email, items, shipped_at")
      .in("status", ["shipped", "delivered"])
      .eq("review_email_sent", false)
      .not("customer_email", "is", null)
      .gte("shipped_at", lower)
      .lte("shipped_at", upper);

    if (error) {
      console.error("review-candidates error:", error);
      return res.status(500).json({ error: "Could not load review candidates" });
    }

    const orders = data.map((o) => ({
      id: o.id,
      receiptId: o.receipt_id,
      customerName: o.customer_name,
      customerEmail: o.customer_email,
      items: o.items || [],
      shippedAt: o.shipped_at,
    }));
    res.json({ orders });
  } catch (err) {
    console.error("review-candidates error:", err);
    res.status(500).json({ error: "Could not load review candidates" });
  }
});

// GET /internal/welcome-candidates
// Newly paid orders (checked every 30 min) that haven't gotten a
// welcome email yet. Not restricted to "first-ever order" — it's a
// welcome/thank-you for every fresh paid order that hasn't been
// welcomed, which in practice fires once per customer's first order
// since older orders were back-filled as already-sent in the migration.
app.get("/internal/welcome-candidates", requireInternalSecret, async (req, res) => {
  try {
    const lower = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("id, receipt_id, customer_name, customer_email, paid_at")
      .eq("status", "paid")
      .eq("welcome_email_sent", false)
      .not("customer_email", "is", null)
      .gte("paid_at", lower);

    if (error) {
      console.error("welcome-candidates error:", error);
      return res.status(500).json({ error: "Could not load welcome candidates" });
    }

    const orders = data.map((o) => ({
      id: o.id,
      receiptId: o.receipt_id,
      customerName: o.customer_name,
      customerEmail: o.customer_email,
      paidAt: o.paid_at,
    }));
    res.json({ orders });
  } catch (err) {
    console.error("welcome-candidates error:", err);
    res.status(500).json({ error: "Could not load welcome candidates" });
  }
});

// GET /internal/failed-payment-candidates
// Payments that failed 1-25 hours ago (gives the customer a chance to
// just retry themselves first; 25h window so an hourly cron catches
// each once).
app.get("/internal/failed-payment-candidates", requireInternalSecret, async (req, res) => {
  try {
    const now = Date.now();
    const lower = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    const upper = new Date(now - 1 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("id, receipt_id, customer_name, customer_email, amount, created_at")
      .eq("status", "failed")
      .eq("failed_followup_email_sent", false)
      .not("customer_email", "is", null)
      .gte("created_at", lower)
      .lte("created_at", upper);

    if (error) {
      console.error("failed-payment-candidates error:", error);
      return res.status(500).json({ error: "Could not load failed payment candidates" });
    }

    const orders = data.map((o) => ({
      id: o.id,
      receiptId: o.receipt_id,
      customerName: o.customer_name,
      customerEmail: o.customer_email,
      amount: o.amount,
      createdAt: o.created_at,
    }));
    res.json({ orders });
  } catch (err) {
    console.error("failed-payment-candidates error:", err);
    res.status(500).json({ error: "Could not load failed payment candidates" });
  }
});

// POST /internal/mark-order-flag
// Body: { id, flag }  — id is the order's uuid (orders.id), flag must
// be one of ALLOWED_ORDER_FLAGS.
app.post("/internal/mark-order-flag", requireInternalSecret, async (req, res) => {
  try {
    const { id, flag } = req.body;
    if (!id || !flag) {
      return res.status(400).json({ error: "id and flag are required" });
    }
    if (!ALLOWED_ORDER_FLAGS.has(flag)) {
      return res.status(400).json({ error: "Invalid flag" });
    }

    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .update({ [flag]: true })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("mark-order-flag error:", error);
      return res.status(500).json({ error: "Could not update order flag" });
    }
    if (!data) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("mark-order-flag error:", err);
    res.status(500).json({ error: "Could not update order flag" });
  }
});

// GET /internal/winback-candidates
// Customers whose most recent paid/shipped/delivered order was
// 30-45 days ago, and who haven't already gotten a win-back email in
// the last 30 days. Since there's no dedicated customers table, this
// aggregates straight from orders (matching /internal/customers-summary)
// and cross-references customer_tags for win-back state.
app.get("/internal/winback-candidates", requireInternalSecret, async (req, res) => {
  try {
    const { data: orders, error: ordersErr } = await supabase
      .from(ORDERS_TABLE)
      .select("customer_phone, customer_name, customer_email, paid_at")
      .in("status", ["paid", "shipped", "delivered"])
      .not("customer_email", "is", null);

    if (ordersErr) {
      console.error("winback-candidates orders error:", ordersErr);
      return res.status(500).json({ error: "Could not load winback candidates" });
    }

    const lastOrderByPhone = new Map();
    for (const o of orders) {
      if (!o.customer_phone || !o.paid_at) continue;
      const existing = lastOrderByPhone.get(o.customer_phone);
      if (!existing || new Date(o.paid_at) > new Date(existing.paidAt)) {
        lastOrderByPhone.set(o.customer_phone, {
          phone: o.customer_phone,
          name: o.customer_name,
          email: o.customer_email,
          paidAt: o.paid_at,
        });
      }
    }

    const { data: tags, error: tagsErr } = await supabase
      .from("customer_tags")
      .select("customer_phone, winback_email_sent, winback_sent_at");

    if (tagsErr) {
      console.error("winback-candidates tags error:", tagsErr);
      return res.status(500).json({ error: "Could not load winback candidates" });
    }
    const tagByPhone = new Map(tags.map((t) => [t.customer_phone, t]));

    const now = Date.now();
    const lowerGapMs = 30 * 24 * 60 * 60 * 1000;
    const upperGapMs = 45 * 24 * 60 * 60 * 1000;
    const resendCooldownMs = 30 * 24 * 60 * 60 * 1000;

    const customers = [];
    for (const c of lastOrderByPhone.values()) {
      const gap = now - new Date(c.paidAt).getTime();
      if (gap < lowerGapMs || gap > upperGapMs) continue;

      const tag = tagByPhone.get(c.phone);
      if (tag?.winback_email_sent && tag.winback_sent_at) {
        if (now - new Date(tag.winback_sent_at).getTime() < resendCooldownMs) continue;
      }
      customers.push(c);
    }

    res.json({ customers });
  } catch (err) {
    console.error("winback-candidates error:", err);
    res.status(500).json({ error: "Could not load winback candidates" });
  }
});

// POST /internal/mark-winback-sent
// Body: { phone }
app.post("/internal/mark-winback-sent", requireInternalSecret, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: "phone is required" });
    }

    const { error } = await supabase
      .from("customer_tags")
      .upsert(
        {
          customer_phone: phone,
          winback_email_sent: true,
          winback_sent_at: new Date().toISOString(),
        },
        { onConflict: "customer_phone" }
      );

    if (error) {
      console.error("mark-winback-sent error:", error);
      return res.status(500).json({ error: "Could not update winback state" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("mark-winback-sent error:", err);
    res.status(500).json({ error: "Could not update winback state" });
  }
});

// GET /internal/weekly-summary
// Revenue, order count, and top-selling products over the last 7 days,
// plus an overall (not just this-week) repeat-customer percentage
// pulled from customer_tags.
app.get("/internal/weekly-summary", requireInternalSecret, async (req, res) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: weekOrders, error: weekErr } = await supabase
      .from(ORDERS_TABLE)
      .select("amount, items")
      .eq("status", "paid")
      .gte("paid_at", weekAgo);

    if (weekErr) {
      console.error("weekly-summary orders error:", weekErr);
      return res.status(500).json({ error: "Could not load weekly summary" });
    }

    const orderCount = weekOrders.length;
    const revenue = weekOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0);

    const qtyByProduct = new Map();
    for (const o of weekOrders) {
      for (const item of o.items || []) {
        const key = item.name || "Unknown";
        qtyByProduct.set(key, (qtyByProduct.get(key) || 0) + Number(item.qty || 0));
      }
    }
    const topProducts = Array.from(qtyByProduct.entries())
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);

    const { data: tags, error: tagsErr } = await supabase
      .from("customer_tags")
      .select("tag");

    if (tagsErr) {
      console.error("weekly-summary tags error:", tagsErr);
      return res.status(500).json({ error: "Could not load weekly summary" });
    }
    const totalCustomers = tags.length;
    const repeatCustomers = tags.filter((t) => t.tag === "repeat" || t.tag === "high-value").length;
    const repeatCustomerPct = totalCustomers > 0 ? Math.round((repeatCustomers / totalCustomers) * 100) : 0;

    res.json({ orderCount, revenue, topProducts, repeatCustomerPct, totalCustomers });
  } catch (err) {
    console.error("weekly-summary error:", err);
    res.status(500).json({ error: "Could not load weekly summary" });
  }
});

// ---------------------------------------------------------------
// Phase 6 — advanced automations: order-confirmation invoices,
// instant owner alerts, stale-shipment nudges, VIP perks, and a
// fraud/risk flag for repeated failed payments.
//
// NOTE on "invoice": this generates a friendly order-confirmation
// receipt (items, amounts, address), not a GST-compliant tax invoice
// (no GSTIN/HSN codes/tax breakdown). If proper GST invoicing is
// needed for accounting/compliance, that's a separate, more involved
// piece of work — flag it if you need that built too.
// ---------------------------------------------------------------

// GET /internal/invoice-candidates
// Newly paid orders (last 24h) that haven't had a confirmation email
// sent yet.
app.get("/internal/invoice-candidates", requireInternalSecret, async (req, res) => {
  try {
    const lower = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("id, receipt_id, customer_name, customer_email, address, pincode, amount, items, paid_at")
      .eq("status", "paid")
      .eq("invoice_email_sent", false)
      .not("customer_email", "is", null)
      .gte("paid_at", lower);

    if (error) {
      console.error("invoice-candidates error:", error);
      return res.status(500).json({ error: "Could not load invoice candidates" });
    }

    const orders = data.map((o) => ({
      id: o.id,
      receiptId: o.receipt_id,
      customerName: o.customer_name,
      customerEmail: o.customer_email,
      address: o.address,
      pincode: o.pincode,
      amount: o.amount,
      items: o.items || [],
      paidAt: o.paid_at,
    }));
    res.json({ orders });
  } catch (err) {
    console.error("invoice-candidates error:", err);
    res.status(500).json({ error: "Could not load invoice candidates" });
  }
});

// GET /internal/new-order-alerts
// Paid orders in the last 2 hours not yet included in an instant
// owner alert (meant to be polled every 5-10 min for near-real-time
// notification, separate from the once-a-day 9am summary).
app.get("/internal/new-order-alerts", requireInternalSecret, async (req, res) => {
  try {
    const lower = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("id, receipt_id, customer_name, amount, items, paid_at")
      .eq("status", "paid")
      .eq("owner_alert_sent", false)
      .gte("paid_at", lower);

    if (error) {
      console.error("new-order-alerts error:", error);
      return res.status(500).json({ error: "Could not load new order alerts" });
    }

    const orders = data.map((o) => ({
      id: o.id,
      receiptId: o.receipt_id,
      customerName: o.customer_name,
      amount: o.amount,
      items: o.items || [],
      paidAt: o.paid_at,
    }));
    res.json({ orders });
  } catch (err) {
    console.error("new-order-alerts error:", err);
    res.status(500).json({ error: "Could not load new order alerts" });
  }
});

// GET /internal/stale-shipments
// Orders shipped 5+ days ago with no further status change (there's no
// delivery-confirmation webhook wired up yet, so "delivered" never
// gets set automatically — this is a manual-check nudge for the
// owner to chase the courier using the awb_code, not an automatic
// delivered/RTO detector).
app.get("/internal/stale-shipments", requireInternalSecret, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("id, receipt_id, customer_name, awb_code, shipped_at")
      .eq("status", "shipped")
      .eq("stale_shipment_alert_sent", false)
      .lte("shipped_at", cutoff);

    if (error) {
      console.error("stale-shipments error:", error);
      return res.status(500).json({ error: "Could not load stale shipments" });
    }

    const orders = data.map((o) => ({
      id: o.id,
      receiptId: o.receipt_id,
      customerName: o.customer_name,
      awbCode: o.awb_code,
      shippedAt: o.shipped_at,
    }));
    res.json({ orders });
  } catch (err) {
    console.error("stale-shipments error:", err);
    res.status(500).json({ error: "Could not load stale shipments" });
  }
});

// GET /internal/vip-candidates
// Customers tagged 'high-value' (from the Phase 2 tagging workflow)
// who haven't gotten a VIP perks email in the last 30 days. There's no
// separate customers table, so name/email are looked up from their
// most recent order.
app.get("/internal/vip-candidates", requireInternalSecret, async (req, res) => {
  try {
    const { data: tags, error: tagsErr } = await supabase
      .from("customer_tags")
      .select("customer_phone, vip_email_sent, vip_sent_at")
      .eq("tag", "high-value");

    if (tagsErr) {
      console.error("vip-candidates tags error:", tagsErr);
      return res.status(500).json({ error: "Could not load VIP candidates" });
    }

    const resendCooldownMs = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const eligiblePhones = tags
      .filter((t) => !t.vip_email_sent || !t.vip_sent_at || now - new Date(t.vip_sent_at).getTime() >= resendCooldownMs)
      .map((t) => t.customer_phone);

    if (eligiblePhones.length === 0) {
      return res.json({ customers: [] });
    }

    const { data: orders, error: ordersErr } = await supabase
      .from(ORDERS_TABLE)
      .select("customer_phone, customer_name, customer_email, paid_at")
      .in("customer_phone", eligiblePhones)
      .not("customer_email", "is", null)
      .order("paid_at", { ascending: false });

    if (ordersErr) {
      console.error("vip-candidates orders error:", ordersErr);
      return res.status(500).json({ error: "Could not load VIP candidates" });
    }

    const latestByPhone = new Map();
    for (const o of orders) {
      if (!latestByPhone.has(o.customer_phone)) {
        latestByPhone.set(o.customer_phone, {
          phone: o.customer_phone,
          name: o.customer_name,
          email: o.customer_email,
        });
      }
    }

    res.json({ customers: Array.from(latestByPhone.values()) });
  } catch (err) {
    console.error("vip-candidates error:", err);
    res.status(500).json({ error: "Could not load VIP candidates" });
  }
});

// POST /internal/mark-vip-sent
// Body: { phone }
app.post("/internal/mark-vip-sent", requireInternalSecret, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: "phone is required" });
    }

    const { error } = await supabase
      .from("customer_tags")
      .upsert(
        { customer_phone: phone, vip_email_sent: true, vip_sent_at: new Date().toISOString() },
        { onConflict: "customer_phone" }
      );

    if (error) {
      console.error("mark-vip-sent error:", error);
      return res.status(500).json({ error: "Could not update VIP state" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("mark-vip-sent error:", err);
    res.status(500).json({ error: "Could not update VIP state" });
  }
});

// GET /internal/fraud-risk-candidates
// Customers (by phone) with 2+ failed payments in the last 7 days,
// who haven't already been flagged to the owner in the last 7 days.
// This is a heads-up for manual review, not an automatic block.
app.get("/internal/fraud-risk-candidates", requireInternalSecret, async (req, res) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: failedOrders, error: failedErr } = await supabase
      .from(ORDERS_TABLE)
      .select("customer_phone, customer_name, customer_email, created_at")
      .eq("status", "failed")
      .gte("created_at", weekAgo);

    if (failedErr) {
      console.error("fraud-risk-candidates orders error:", failedErr);
      return res.status(500).json({ error: "Could not load fraud risk candidates" });
    }

    const countByPhone = new Map();
    for (const o of failedOrders) {
      if (!o.customer_phone) continue;
      const entry = countByPhone.get(o.customer_phone) || {
        phone: o.customer_phone,
        name: o.customer_name,
        email: o.customer_email,
        failedCount: 0,
      };
      entry.failedCount += 1;
      countByPhone.set(o.customer_phone, entry);
    }

    const riskyPhones = Array.from(countByPhone.values()).filter((c) => c.failedCount >= 2);
    if (riskyPhones.length === 0) {
      return res.json({ customers: [] });
    }

    const { data: tags, error: tagsErr } = await supabase
      .from("customer_tags")
      .select("customer_phone, fraud_alert_sent, fraud_alert_sent_at")
      .in("customer_phone", riskyPhones.map((c) => c.phone));

    if (tagsErr) {
      console.error("fraud-risk-candidates tags error:", tagsErr);
      return res.status(500).json({ error: "Could not load fraud risk candidates" });
    }
    const tagByPhone = new Map(tags.map((t) => [t.customer_phone, t]));

    const now = Date.now();
    const cooldownMs = 7 * 24 * 60 * 60 * 1000;
    const customers = riskyPhones.filter((c) => {
      const tag = tagByPhone.get(c.phone);
      if (tag?.fraud_alert_sent && tag.fraud_alert_sent_at) {
        return now - new Date(tag.fraud_alert_sent_at).getTime() >= cooldownMs;
      }
      return true;
    });

    res.json({ customers });
  } catch (err) {
    console.error("fraud-risk-candidates error:", err);
    res.status(500).json({ error: "Could not load fraud risk candidates" });
  }
});

// POST /internal/mark-fraud-alert-sent
// Body: { phone }
app.post("/internal/mark-fraud-alert-sent", requireInternalSecret, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: "phone is required" });
    }

    const { error } = await supabase
      .from("customer_tags")
      .upsert(
        { customer_phone: phone, fraud_alert_sent: true, fraud_alert_sent_at: new Date().toISOString() },
        { onConflict: "customer_phone" }
      );

    if (error) {
      console.error("mark-fraud-alert-sent error:", error);
      return res.status(500).json({ error: "Could not update fraud alert state" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("mark-fraud-alert-sent error:", err);
    res.status(500).json({ error: "Could not update fraud alert state" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Raviraj Textiles backend running on port ${PORT}`));
