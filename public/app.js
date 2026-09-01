/* Vyapaar dashboard. No build step, no framework — it should open in a browser
   the moment the server starts. */

const $ = (id) => document.getElementById(id);
const state = { mandates: [], selected: null, faults: {}, lastOrder: null };

/* ---------- helpers ---------- */

function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = "toast"), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const inr = (paise) =>
  paise == null
    ? "—"
    : "₹" + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function pretty(v) {
  if (typeof v !== "string") return JSON.stringify(v, null, 2);
  return v;
}

/* ---------- status ---------- */

async function loadStatus() {
  const s = await api("/api/v1/status");
  $("badge-payments").textContent = s.mode.payments;
  $("badge-payments").className = "badge " + (s.mode.payments.startsWith("razorpay") ? "ok" : "info");
  $("badge-parser").textContent = s.mode.intentParsing;
  $("badge-parser").className = "badge " + (s.mode.intentParsing.startsWith("llm") ? "ok" : "info");

  const p = s.merchantPolicy;
  $("policy").innerHTML = `
    <div class="kv"><span class="k">Max discount</span><span class="v">${(p.maxDiscountBps / 100).toFixed(1)}%</span></div>
    <div class="kv"><span class="k">Basket discount cap</span><span class="v">${inr(p.maxBasketDiscountPaise)}</span></div>
    <div class="kv"><span class="k">Margin floor</span><span class="v">${inr(p.minMarginPaise)}</span></div>
    <div class="kv"><span class="k">No-discount categories</span><span class="v">${p.noDiscountCategories.join(", ") || "—"}</span></div>
    <div class="note">Every generated offer is gated here before it is ever shown to a buyer. Rejected offers are visible in the run trace with their reason.</div>
  `;

  await verifyChain();
}

async function verifyChain() {
  const v = await api("/api/v1/ledger/verify");
  const b = $("badge-ledger");
  b.textContent = `chain: ${v.ok ? "intact" : "BROKEN"} (${v.entries})`;
  b.className = "badge mono " + (v.ok ? "ok" : "bad");
  return v;
}

/* ---------- mandates ---------- */

async function loadMandates() {
  const { mandates } = await api("/api/v1/mandates");
  state.mandates = mandates;
  if (!state.selected && mandates.length) state.selected = mandates[0].id;
  renderMandates();
}

function renderMandates() {
  const el = $("mandates");
  if (!state.mandates.length) {
    el.innerHTML = `<div class="empty">No mandates yet.</div>`;
    return;
  }
  el.innerHTML = state.mandates
    .map(
      (m) => `
    <div class="mandate ${m.id === state.selected ? "selected" : ""}" data-id="${m.id}">
      <div class="t">${escapeHtml(m.purpose)}</div>
      <div class="m">
        <span><b>txn</b> ${m.perTxnCapDisplay}</span>
        <span><b>left</b> ${m.remainingDisplay}</span>
        <span><b>approve&gt;</b> ${m.approvalAboveDisplay}</span>
      </div>
      <div class="m" style="margin-top:3px">
        <span>${escapeHtml(m.principal)}</span>
        <span>${m.status}</span>
      </div>
    </div>`
    )
    .join("");

  el.querySelectorAll(".mandate").forEach((n) =>
    n.addEventListener("click", () => {
      state.selected = n.dataset.id;
      renderMandates();
    })
  );
}

/* ---------- agent run ---------- */

async function runAgent(dryRun) {
  if (!state.selected) return toast("Create a mandate first.", "error");
  const request = $("request").value.trim();
  if (!request) return toast("Describe what the buyer wants.", "error");

  $("btn-run").disabled = true;
  $("btn-dry").disabled = true;
  try {
    const { run, quote } = await api("/api/v1/agent/run", {
      method: "POST",
      body: JSON.stringify({
        mandateId: state.selected,
        request,
        dryRun,
        acceptOffers: $("accept-offers").checked,
      }),
    });
    renderTrace(run, quote);
    if (run.orderId) state.lastOrder = run.orderId;
    toast(`Run finished: ${run.outcome}`, run.outcome === "completed" ? "success" : "");
    await refreshAll();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("btn-run").disabled = false;
    $("btn-dry").disabled = false;
  }
}

function renderTrace(run, quote) {
  $("run-outcome").innerHTML = `outcome: <b>${run.outcome}</b> · intent via ${run.intent.source} · confidence ${run.intent.confidence.toFixed(2)}`;

  const steps = run.steps
    .map(
      (s) => `
    <div class="step">
      <div class="step-n">${s.seq + 1}</div>
      <div class="step-body">
        <span class="step-kind ${s.kind}">${s.kind}</span>
        <span class="step-text">${escapeHtml(s.summary)}</span>
        ${s.detail ? `<div class="step-detail">${escapeHtml(JSON.stringify(s.detail, null, 2))}</div>` : ""}
      </div>
    </div>`
    )
    .join("");

  let quoteHtml = "";
  if (quote) {
    quoteHtml = `
      <div class="note ${quote.decision === "ALLOW" ? "good" : quote.decision === "DENY" ? "bad" : "warn"}" style="margin-top:12px">
        <b>${quote.decision}</b> · subtotal ${inr(quote.subtotal)} − discount ${inr(quote.discount)} + shipping ${inr(quote.shipping)} = <b>${inr(quote.total)}</b>
        <div style="margin-top:6px">${(quote.reasons || []).map(escapeHtml).join("<br/>")}</div>
      </div>`;
  }

  $("trace").innerHTML = steps + quoteHtml || `<div class="empty">No steps recorded.</div>`;
}

async function parseOnly() {
  const request = $("request").value.trim();
  if (!request) return toast("Describe what the buyer wants.", "error");
  const out = await api("/api/v1/agent/parse", {
    method: "POST",
    body: JSON.stringify({ request }),
  });
  $("parse-out").innerHTML = `
    <div class="note">
      <b>Understood:</b> terms=[${out.intent.terms.join(", ")}], qty=${out.intent.qty},
      category=${out.intent.category || "—"}, maxUnitPrice=${out.intent.maxUnitPrice ? inr(out.intent.maxUnitPrice) : "—"},
      shipsInDays≤${out.intent.maxShipsInDays || "—"}, filters=${JSON.stringify(out.intent.attributeFilters)}
      <div style="margin-top:5px; color:var(--text-3)">confidence ${out.intent.confidence.toFixed(2)} · parsed by ${out.intent.source}</div>
      <div style="margin-top:7px"><b>Matches:</b> ${out.matches.map((m) => `${m.id} (${inr(m.price)})`).join(", ") || "none"}</div>
    </div>`;
}

/* ---------- orders ---------- */

async function loadOrders() {
  const { orders } = await api("/api/v1/orders");
  const tbody = $("orders");
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty">No orders yet.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = orders
    .slice(0, 20)
    .map(
      (o) => `
    <tr>
      <td class="mono">${o.id}<div style="color:var(--text-3);font-size:10.5px">${o.lines.map((l) => `${l.qty}× ${l.title}`).join(", ")}</div></td>
      <td class="mono">${o.totalDisplay}</td>
      <td><span class="status ${o.status}">${o.status}</span></td>
      <td class="mono" style="font-size:10.5px">${o.razorpayOrderId || "—"}<div style="color:var(--text-3)">${o.razorpayPaymentId || ""}</div></td>
      <td>
        <div class="btn-row">
          ${o.status === "draft" ? `<button class="small" data-act="pay" data-id="${o.id}">Pay</button>` : ""}
          ${o.status === "awaiting_approval" ? `<button class="small" data-act="approve" data-id="${o.id}">Approve</button><button class="small danger" data-act="reject" data-id="${o.id}">Reject</button>` : ""}
          ${o.razorpayOrderId && o.status !== "paid" ? `<button class="small" data-act="simpay" data-id="${o.id}">Complete payment</button>` : ""}
          ${o.razorpayOrderId ? `<button class="small" data-act="reconcile" data-id="${o.id}">Reconcile</button>` : ""}
        </div>
      </td>
    </tr>`
    )
    .join("");

  tbody.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => orderAction(b.dataset.act, b.dataset.id))
  );
}

async function orderAction(act, id) {
  try {
    if (act === "pay") {
      await api(`/api/v1/orders/${id}/pay`, { method: "POST", body: "{}" });
      toast("Payment initiated.", "success");
    } else if (act === "approve" || act === "reject") {
      await api(`/api/v1/orders/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ by: "operator@dashboard", decision: act === "approve" ? "approved" : "rejected" }),
      });
      toast(act === "approve" ? "Approved." : "Rejected.");
    } else if (act === "simpay") {
      const r = await api("/api/v1/simulator/pay", { method: "POST", body: JSON.stringify({ orderId: id }) });
      toast(
        r.webhookDelivered ? "Paid — webhook delivered." : "Paid, but the webhook was dropped. Reconcile to recover.",
        r.webhookDelivered ? "success" : "error"
      );
      renderRecon(r);
    } else if (act === "reconcile") {
      const r = await api(`/api/v1/orders/${id}/reconcile`, { method: "POST", body: "{}" });
      toast(`Reconciliation: ${r.result.status}.`, r.result.status === "recovered" ? "success" : "");
      renderRecon(r);
    }
    await refreshAll();
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderRecon(r) {
  const order = r.order;
  const hist = r.history || [];
  $("recon-out").innerHTML = `
    <div class="note ${r.result && r.result.status === "recovered" ? "good" : "warn"}">
      <b>Outcome:</b> ${r.result ? r.result.status : "—"} — ${r.result ? escapeHtml(r.result.detail) : ""}
      <div style="margin-top:4px; color:var(--text-3)">
        attempt ${r.result ? r.result.attempt : "—"} · order ${order ? order.id : "—"} · status ${order ? order.status : "—"}
      </div>
    </div>
    ${
      hist.length
        ? `<table style="margin-top:10px"><thead><tr><th>#</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>
            ${hist.map((h) => `<tr><td class="mono">${h.attempt}</td><td class="mono">${escapeHtml(h.outcome)}</td><td style="font-size:11.5px">${escapeHtml(h.detail)}</td></tr>`).join("")}
           </tbody></table>`
        : ""
    }`;
}

/* ---------- ledger ---------- */

async function loadLedger() {
  const { entries } = await api("/api/v1/ledger?tail=200");
  $("ledger-count").textContent = `${entries.length} entries`;
  const el = $("ledger");
  if (!entries.length) {
    el.innerHTML = `<div class="empty">No entries yet.</div>`;
    return;
  }
  el.innerHTML = entries
    .map(
      (e) => `
    <div class="entry">
      <div class="entry-head">
        <span class="entry-action">${escapeHtml(e.action)}</span>
        <span class="entry-actor ${e.actor.kind}">${e.actor.kind}</span>
        <span class="entry-hash" title="${e.hash}">${e.hash.slice(0, 10)}…</span>
      </div>
      <div style="margin-top:3px; color:var(--text-3); font-size:11px">
        ${new Date(e.ts).toLocaleTimeString()} · seq ${e.seq}
        ${e.orderId ? ` · <span class="entry-link" data-order="${e.orderId}">${e.orderId}</span>` : ""}
        <span class="entry-link" data-expand>payload</span>
      </div>
      <div class="entry-payload">${escapeHtml(JSON.stringify(e.payload, null, 2))}
prev: ${e.prevHash.slice(0, 16)}…
hash: ${e.hash}</div>
    </div>`
    )
    .join("");

  el.querySelectorAll("[data-expand]").forEach((n) =>
    n.addEventListener("click", () => n.closest(".entry").classList.toggle("open"))
  );
  el.querySelectorAll("[data-order]").forEach((n) =>
    n.addEventListener("click", () => {
      state.lastOrder = n.dataset.order;
      toast(`Filtering not implemented in this view; order ${n.dataset.order}`);
    })
  );
  el.scrollTop = 0;
}

/* ---------- faults ---------- */

async function loadFaults() {
  const { faults } = await api("/api/v1/simulator/faults");
  state.faults = faults;
  document.querySelectorAll(".fault-btn").forEach((b) => {
    b.classList.toggle("active", Boolean(faults[b.dataset.fault]));
  });
}

async function toggleFault(key, btn) {
  const on = !btn.classList.contains("active");
  await api("/api/v1/simulator/faults", { method: "POST", body: JSON.stringify({ [key]: on }) });
  await loadFaults();
  toast(on ? `Fault armed: ${key}` : `Fault cleared: ${key}`, on ? "error" : "success");
}

/* ---------- misc ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function refreshAll() {
  await Promise.all([loadMandates(), loadOrders(), loadLedger(), loadFaults(), verifyChain()]);
}

/* ---------- wiring ---------- */

$("btn-mandate").addEventListener("click", async () => {
  try {
    const m = await api("/api/v1/mandates", {
      method: "POST",
      body: JSON.stringify({
        principal: $("m-principal").value,
        purpose: $("m-purpose").value,
        perTxnCap: Number($("m-pertxn").value),
        totalCap: Number($("m-total").value),
        approvalAbove: Number($("m-approval").value),
        maxQtyPerLine: Number($("m-qty").value),
      }),
    });
    state.selected = m.mandate.id;
    toast("Mandate issued.", "success");
    await refreshAll();
  } catch (err) {
    toast(err.message, "error");
  }
});

$("btn-run").addEventListener("click", () => runAgent(false));
$("btn-dry").addEventListener("click", () => runAgent(true));
$("btn-parse").addEventListener("click", parseOnly);
$("btn-verify").addEventListener("click", async () => {
  const v = await verifyChain();
  toast(v.ok ? `Chain intact across ${v.entries} entries.` : `CHAIN BROKEN at seq ${v.brokenAtSeq}: ${v.reason}`, v.ok ? "success" : "error");
});
$("btn-clear-faults").addEventListener("click", async () => {
  await api("/api/v1/simulator/faults", {
    method: "POST",
    body: JSON.stringify({ dropNextWebhook: false, failPayment: false, timeoutCreateOrder: false, leavePaymentPending: false }),
  });
  await loadFaults();
  toast("Faults cleared.", "success");
});
document.querySelectorAll(".fault-btn").forEach((b) =>
  b.addEventListener("click", () => toggleFault(b.dataset.fault, b))
);

(async function init() {
  try {
    await loadStatus();
    await refreshAll();
    if (!state.mandates.length) {
      await api("/api/v1/mandates", {
        method: "POST",
        body: JSON.stringify({
          principal: "ops.lead@acme.in",
          purpose: "Outfit the Bengaluru office",
          perTxnCap: 20000,
          totalCap: 60000,
          approvalAbove: 12000,
          maxQtyPerLine: 3,
        }),
      });
      await refreshAll();
    }
  } catch (err) {
    toast(err.message, "error");
  }
})();
