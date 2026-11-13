// Spendkit landing: the till on the left prints onto the receipt on the right.
// No dependencies and no network calls: the limits logic runs here, in the page.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // The same three checks, in the same order, as evaluate() in src/lib/services/spendPolicy.ts.
  function evaluate(policy, a) {
    if (a.amountCents > policy.perTransactionCents) return { ok: false, reason: "per-transaction limit exceeded" };
    if (a.spentTodayCents + a.amountCents > policy.dailyCents) return { ok: false, reason: "daily limit exceeded" };
    if (policy.allowedMccs && (!a.mcc || !policy.allowedMccs.includes(a.mcc))) return { ok: false, reason: "merchant category not allowed" };
    return { ok: true };
  }

  const CATS = [
    { mcc: "5734", name: "software" },
    { mcc: "7372", name: "cloud" },
    { mcc: "5812", name: "food" },
    { mcc: "4511", name: "airlines" },
    { mcc: "7995", name: "gambling" },
  ];
  const BUYS = [
    { amountCents: 1250, merchant: "Example API", mcc: "5734" },
    { amountCents: 3800, merchant: "GPU hour", mcc: "7372" },
    { amountCents: 900, merchant: "Dataset store", mcc: "5734" },
    { amountCents: 1800, merchant: "Lunch order", mcc: "5812" },
    { amountCents: 64000, merchant: "Flight", mcc: "4511" },
    { amountCents: 2000, merchant: "Casino", mcc: "7995" },
  ];
  const DIALS = { perTx: { step: 500, min: 500, max: 10000 }, daily: { step: 1000, min: 1000, max: 30000 } };
  const catName = (mcc) => CATS.find((c) => c.mcc === mcc)?.name ?? mcc;

  const state = { perTx: 2000, daily: 5000, allowed: new Set(["5734", "7372"]), spent: 0, ok: 0, no: 0, order: 0, last: null };
  const policy = () => ({ perTransactionCents: state.perTx, dailyCents: state.daily, allowedMccs: CATS.map((c) => c.mcc).filter((m) => state.allowed.has(m)) });

  // ---------- receipt header: live date, time and number ----------
  const pad = (n) => String(n).padStart(2, "0");
  function clock() {
    const d = new Date();
    $("#r-date").textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    $("#r-time").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  clock();
  setInterval(clock, 1000);
  $("#r-no").textContent = `no. ${String(Math.floor(Math.random() * 90000) + 10000)}`;

  // ---------- paint policy and totals ----------
  function paint() {
    $("#perTxOut").textContent = `$${state.perTx / 100}`;
    $("#dailyOut").textContent = `$${state.daily / 100}`;
    $("#p-perTx").textContent = usd(state.perTx);
    $("#p-daily").textContent = usd(state.daily);
    const names = CATS.filter((c) => state.allowed.has(c.mcc)).map((c) => `${c.name} ${c.mcc}`);
    $("#p-cats").textContent = names.length ? names.join(", ") : "none";
    for (const b of $$("#cats button")) b.setAttribute("aria-pressed", String(state.allowed.has(b.dataset.mcc)));
    $("#t-spent").textContent = usd(state.spent);
    $("#t-left").textContent = usd(Math.max(0, state.daily - state.spent));
    $("#t-ok").textContent = String(state.ok);
    $("#t-no").textContent = String(state.no);
    const bar = $("#t-bar");
    bar.style.width = `${Math.min(100, (state.spent / state.daily) * 100)}%`;
    bar.classList.toggle("full", state.spent >= state.daily);
  }

  // ---------- printing ----------
  const items = $("#items"), wait = $("#wait");
  function printLine(li, fromUser) {
    items.append(li);
    while (items.children.length > 7) items.firstElementChild.remove();
    wait.hidden = true;
    // On a phone the receipt is below the till: bring the new line into view.
    if (fromUser && !reduced && matchMedia("(max-width: 1000px)").matches) li.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (fromUser) li.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  }
  function row(left, right, cls) {
    const r = el("div", "row");
    r.append(el("span", "", left), el("i"), el("span", cls, right));
    return r;
  }
  function ring(buy, fromUser) {
    const key = `order-${++state.order}`;
    const r = evaluate(policy(), { amountCents: buy.amountCents, mcc: buy.mcc, spentTodayCents: state.spent });
    if (r.ok) { state.spent += buy.amountCents; state.ok++; } else state.no++;
    state.last = { buy, key, r };
    const li = el("li", r.ok ? "ok" : "no");
    li.append(
      row(buy.merchant, usd(buy.amountCents), "amt"),
      el("p", "sub", `mcc ${buy.mcc} ${catName(buy.mcc)} · ${key}`),
      el("p", "res", r.ok ? "approved" : r.reason),
      el("span", r.ok ? "stamp ok" : "stamp", r.ok ? "PAID" : "DECLINED"),
    );
    printLine(li, fromUser);
    paint();
  }
  function retry(fromUser) {
    if (!state.last) return;
    const { buy, key, r } = state.last;
    const li = el("li", "re");
    li.append(
      row(`retry ${buy.merchant}`, usd(buy.amountCents), "amt"),
      el("p", "sub", `same key: ${key}`),
      el("p", "res", r.ok ? "first result returned · not charged again" : `first result returned · ${r.reason}`),
    );
    printLine(li, fromUser);
  }

  // ---------- the till ----------
  const hint = $("#hint");
  let touched = false;
  const touch = () => { touched = true; hint.classList.add("gone"); };

  for (const buy of BUYS) {
    const b = el("button", "key");
    b.type = "button";
    b.append(el("b", "", usd(buy.amountCents)), el("i", "", `${buy.merchant} · ${catName(buy.mcc)}`));
    b.addEventListener("click", () => { touch(); ring(buy, true); });
    buy.el = b;
    $("#keys").append(b);
  }
  $("#retry").addEventListener("click", () => { touch(); retry(true); });
  $("#newDay").addEventListener("click", () => {
    touch();
    Object.assign(state, { spent: 0, ok: 0, no: 0, last: null });
    items.replaceChildren();
    wait.hidden = false;
    paint();
  });
  for (const s of $$(".step")) {
    s.addEventListener("click", () => {
      touch();
      const d = DIALS[s.dataset.dial];
      state[s.dataset.dial] = Math.min(d.max, Math.max(d.min, state[s.dataset.dial] + Number(s.dataset.d) * d.step));
      paint();
    });
  }
  for (const c of CATS) {
    const b = el("button", "", c.name);
    b.type = "button";
    b.dataset.mcc = c.mcc;
    b.addEventListener("click", () => {
      touch();
      state.allowed.has(c.mcc) ? state.allowed.delete(c.mcc) : state.allowed.add(c.mcc);
      paint();
    });
    $("#cats").append(b);
  }
  paint();

  // ---------- a short demo so the receipt is alive before anyone touches it ----------
  const DEMO = [0, 1, 2]; // Example API (paid), GPU hour (over the per-payment cap), Dataset store (paid)
  if (reduced) {
    for (const i of DEMO) ring(BUYS[i], false);
  } else {
    DEMO.forEach((i, n) => setTimeout(() => {
      if (touched) return;
      const k = BUYS[i].el;
      k.classList.add("down");
      setTimeout(() => k.classList.remove("down"), 160);
      ring(BUYS[i], false);
    }, 1100 + n * 1300));
  }

  // ---------- keep the left column in view while the receipt scrolls ----------
  const pitch = $(".pitch");
  const stick = () => pitch.style.setProperty("--pitch-top", `${Math.min(0, innerHeight - pitch.offsetHeight)}px`);
  stick();
  addEventListener("resize", stick);
  document.fonts?.ready.then(stick);

  // ---------- code tabs + copy ----------
  const tabs = $$('[role="tab"]');
  function select(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(`#${t.getAttribute("aria-controls")}`).hidden = !on;
    }
    if (focus) tab.focus();
  }
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) { e.preventDefault(); select(tabs[(i + d + tabs.length) % tabs.length], true); }
    });
  });
  $("#copy").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const text = $$('[role="tabpanel"]').find((p) => !p.hidden).textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "copied";
      btn.classList.add("done");
    } catch {
      btn.textContent = "select it";
    }
    setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("done"); }, 1400);
  });
})();
