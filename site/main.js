// Spendkit landing: theme toggle, copy buttons, tabs, the example feed and the limits playground.
// No dependencies. Everything here is illustrative; nothing talks to a server.
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

  // ---------- theme ----------
  const root = document.documentElement;
  const isLight = () => (root.dataset.theme ? root.dataset.theme === "light" : matchMedia("(prefers-color-scheme: light)").matches);
  $("#theme").addEventListener("click", () => {
    root.dataset.theme = isLight() ? "dark" : "light";
    try { localStorage.setItem("sk-theme", root.dataset.theme); } catch { /* not saved; still applied */ }
  });

  // ---------- copy ----------
  async function copy(btn, text) {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "copied";
      btn.classList.add("done");
    } catch {
      btn.textContent = "select + copy";
    }
    setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("done"); }, 1400);
  }
  for (const b of $$("[data-copy]")) b.addEventListener("click", () => copy(b, $(b.dataset.copy).textContent.trim()));

  // ---------- tabs ----------
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
  $("#copyTab").addEventListener("click", (e) => {
    const panel = $$('[role="tabpanel"]').find((p) => !p.hidden);
    // Copy the command only: drop comment lines and the example response.
    const lines = panel.textContent.split("\n").filter((l) => !l.trimStart().startsWith("#") && l.trim());
    copy(e.currentTarget, lines.join("\n"));
  });

  // ---------- example feed ----------
  const FEED = [
    { k: "ok", who: "research-bot", to: "Example API", amt: 1250, why: "approved" },
    { k: "no", who: "travel-agent", to: "Airline", amt: 64000, why: "declined · per-transaction limit exceeded" },
    { k: "ok", who: "design-bot", to: "Font foundry", amt: 1500, why: "approved" },
    { k: "info", who: "research-bot", to: "retry order-1", why: "same result returned · no double charge" },
    { k: "no", who: "scraper-7", to: "Casino", amt: 2000, why: "declined · merchant category not allowed" },
    { k: "ok", who: "support-bot", to: "Checkout cs_9f2…", amt: 1299, why: "paid" },
    { k: "no", who: "design-bot", to: "Stock photos", amt: 4500, why: "declined · daily limit exceeded" },
    { k: "info", who: "ops-agent", to: "revoked by owner", why: "token stops working at once" },
    { k: "ok", who: "research-bot", to: "Dataset store", amt: 800, why: "approved" },
  ];
  const MARK = { ok: "✓", no: "✗", info: "↺" };
  const feed = $("#feed"), okN = $("#feed-ok"), noN = $("#feed-no");
  let fi = 0, ok = 0, no = 0;
  function pushFeed() {
    const f = FEED[fi++ % FEED.length];
    const li = el("li", f.k);
    li.append(el("span", "mark", MARK[f.k]));
    const who = el("span", "who", f.who);
    who.append(el("span", "", ` → ${f.to}`));
    li.append(who, el("span", "amt", f.amt ? usd(f.amt) : ""), el("span", "why", f.why));
    feed.append(li);
    while (feed.children.length > 7) feed.firstElementChild.remove();
    if (f.k === "ok") okN.textContent = String(++ok);
    if (f.k === "no") noN.textContent = String(++no);
  }
  if (reduced) {
    for (let i = 0; i < 6; i++) pushFeed();
  } else {
    for (let i = 0; i < 3; i++) pushFeed();
    let timer;
    const start = () => { timer ??= setInterval(pushFeed, 1900); };
    const stop = () => { clearInterval(timer); timer = undefined; };
    // Only animate while the terminal is on screen and the tab is visible.
    new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? start() : stop())).observe(feed);
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  }

  // ---------- limits playground ----------
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
  const TRIES = [
    { amountCents: 1250, merchant: "Example API", mcc: "5734" },
    { amountCents: 3800, merchant: "GPU hour", mcc: "7372" },
    { amountCents: 1800, merchant: "Lunch order", mcc: "5812" },
    { amountCents: 64000, merchant: "Flight", mcc: "4511" },
    { amountCents: 2000, merchant: "Casino", mcc: "7995" },
    { amountCents: 900, merchant: "Dataset store", mcc: "5734" },
  ];
  const catName = (mcc) => CATS.find((c) => c.mcc === mcc)?.name ?? mcc;

  const state = { perTx: 2000, daily: 5000, any: false, allowed: new Set(["5734", "7372"]), spent: 0 };
  const policy = () => ({
    perTransactionCents: state.perTx,
    dailyCents: state.daily,
    ...(state.any ? {} : { allowedMccs: CATS.map((c) => c.mcc).filter((m) => state.allowed.has(m)) }),
  });

  const perTx = $("#perTx"), daily = $("#daily"), chips = $("#chips"), log = $("#log");
  const fill = (r) => r.style.setProperty("--fill", `${((r.value - r.min) / (r.max - r.min)) * 100}%`);

  function paint() {
    $("#perTxOut").textContent = `$${state.perTx / 100}`;
    $("#dailyOut").textContent = `$${state.daily / 100}`;
    fill(perTx); fill(daily);
    for (const b of $$("button", chips)) {
      b.setAttribute("aria-pressed", String(b.dataset.mcc === "any" ? state.any : !state.any && state.allowed.has(b.dataset.mcc)));
    }
    const p = policy();
    $("#policyJson").textContent =
      `{\n  "perTransactionCents": ${p.perTransactionCents},\n  "dailyCents": ${p.dailyCents}` +
      (p.allowedMccs ? `,\n  "allowedMccs": ${JSON.stringify(p.allowedMccs).replaceAll(",", ", ")}` : "") + `\n}`;
    const pct = Math.min(100, (state.spent / state.daily) * 100);
    const bar = $("#meterBar");
    bar.style.width = `${pct}%`;
    bar.classList.toggle("full", state.spent >= state.daily);
    $("#spent").textContent = usd(state.spent);
    $("#cap").textContent = usd(state.daily);
    $("#left").textContent = `${usd(Math.max(0, state.daily - state.spent))} left`;
  }

  for (const c of [{ mcc: "any", name: "any" }, ...CATS]) {
    const b = el("button", "", c.mcc === "any" ? "any" : `${c.name} ${c.mcc}`);
    b.type = "button";
    b.dataset.mcc = c.mcc;
    b.addEventListener("click", () => {
      if (c.mcc === "any") state.any = !state.any;
      else {
        state.any = false;
        state.allowed.has(c.mcc) ? state.allowed.delete(c.mcc) : state.allowed.add(c.mcc);
      }
      paint();
    });
    chips.append(b);
  }
  perTx.addEventListener("input", () => { state.perTx = Number(perTx.value) * 100; paint(); });
  daily.addEventListener("input", () => { state.daily = Number(daily.value) * 100; paint(); });

  for (const t of TRIES) {
    const b = el("button");
    b.type = "button";
    const amt = el("b", "", usd(t.amountCents));
    amt.append(el("i", "", catName(t.mcc)));
    b.append(amt, el("span", "", t.merchant));
    b.addEventListener("click", () => {
      const r = evaluate(policy(), { amountCents: t.amountCents, mcc: t.mcc, spentTodayCents: state.spent });
      if (r.ok) state.spent += t.amountCents;
      $(".empty", log)?.remove();
      const li = el("li", r.ok ? "ok" : "no");
      const body = el("span", "", `${usd(t.amountCents)} ${t.merchant} `);
      body.append(el("span", "why", r.ok ? "approved" : `declined · ${r.reason}`));
      li.append(el("span", "mark", r.ok ? "✓" : "✗"), body);
      log.prepend(li);
      while (log.children.length > 5) log.lastElementChild.remove();
      paint();
    });
    $("#tries").append(b);
  }
  $("#newDay").addEventListener("click", () => {
    state.spent = 0;
    log.replaceChildren(el("li", "empty", "A new day: the daily total is back to zero."));
    paint();
  });
  paint();
})();
