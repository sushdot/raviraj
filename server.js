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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Raviraj Textiles backend running on port ${PORT}`));
