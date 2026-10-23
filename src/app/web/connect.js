// Hosted end-user page (/connect). The session token arrives in the URL fragment, is stripped from the address bar at
// once, and lives only in this closure: not in storage, not in the DOM, not in any log or error text.
(() => {
  "use strict";

  // ---------- session ----------
  const hash = /(?:^#|&)session=([^&]+)/.exec(location.hash);
  let token = hash ? decodeURIComponent(hash[1]) : null;
  history.replaceState(null, "", location.pathname + location.search);

  const view = document.getElementById("view");
  const statusEl = document.getElementById("status");
  const POLL_MS = 4000;
  let state = null;
  let pollTimer = null;
  let ended = false;

  class Expired extends Error {}

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        // The server 415s any POST without a JSON content-type, so body-less POSTs (refresh) send {}.
        headers: { authorization: "Bearer " + token, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    }
    if (res.status === 401) { expire(); throw new Expired(); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === "string" && data.error ? data.error : "Something went wrong. Please try again.");
    return data;
  }

  // ---------- tiny DOM helpers (text only: nothing from the server is ever parsed as HTML) ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const usd = (c) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const announce = (t) => { statusEl.textContent = ""; setTimeout(() => (statusEl.textContent = t), 30); };
  let uid = 0;
  const nextId = (p) => p + "-" + ++uid;

  /** Whole dollars or dollars and cents ("12", "12.5", "$12.50") to integer cents; null if not a positive amount. */
  function toCents(s) {
    const m = /^\$?\s*(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(s).trim().replace(/,/g, ""));
    if (!m) return null;
    const c = Number(m[1]) * 100 + Number(((m[2] || "") + "00").slice(0, 2));
    return c > 0 ? c : null;
  }

  function show(...nodes) {
    clearTimeout(pollTimer);
    view.replaceChildren(...nodes.filter(Boolean));
    view.removeAttribute("aria-busy");
    const first = view.querySelector("h1");
    if (first) { first.setAttribute("tabindex", "-1"); first.focus({ preventScroll: false }); }
  }

  // ---------- terminal and transitional states ----------
  function loading() {
    view.setAttribute("aria-busy", "true");
    view.replaceChildren(h("div", { class: "card center stack", role: "status" }, h("div", { class: "spinner", "aria-hidden": "true" }), h("p", { class: "muted", text: "Loading your card…" })));
  }

  function expire() {
    ended = true;
    token = null;
    state = null;
    show(h("div", { class: "card center stack" },
      h("h1", { text: "This link has expired" }),
      h("p", { class: "muted", text: "For your security, these links only last a short while. Go back to the app and try again." })));
    announce("This link has expired. Go back to the app and try again.");
  }

  function missing() {
    ended = true;
    show(h("div", { class: "card center stack" },
      h("h1", { text: "This link isn't complete" }),
      h("p", { class: "muted", text: "Go back to the app and open the link again." })));
  }

  function failed(msg, retry) {
    show(h("div", { class: "card center stack" },
      h("h1", { text: "We couldn't load this page" }),
      h("p", { class: "muted", text: msg }),
      h("button", { class: "primary", type: "button", onclick: retry, text: "Try again" })));
  }

  // ---------- routing ----------
  async function load() {
    loading();
    try { state = await api("GET", "/api/me"); } catch (e) { if (!(e instanceof Expired)) failed(e.message, load); return; }
    route();
  }

  function route(opts) {
    if (ended) return;
    const s = state.kycStatus;
    if (state.card) return spendControls(opts);
    if (s === "Initiated" || s === "Pending") return inReview();
    if (s === "Approved") return settingUp();
    if (s === "Rejected") return kycForm({ rejected: true });
    return kycForm({});
  }

  /** Polls POST /api/me/refresh while the identity check or card set-up is running. */
  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (ended) return;
      try {
        const next = await api("POST", "/api/me/refresh");
        const changed = next.kycStatus !== state.kycStatus || !!next.card !== !!state.card;
        state = next;
        if (changed) { route(); announce(state.card ? "Your card is ready." : state.kycStatus === "Rejected" ? "We couldn't verify your identity." : "Status updated."); return; }
      } catch (e) { if (e instanceof Expired) return; /* transient: try again next tick */ }
      poll();
    }, POLL_MS);
  }

  function inReview() {
    show(h("div", { class: "card center stack" },
      h("div", { class: "spinner", "aria-hidden": "true" }),
      h("h1", { text: "We're checking your details" }),
      h("p", { class: "muted", text: "This usually takes a few minutes. You can keep this page open. It updates by itself." }),
      h("p", { class: "small muted", text: "Status: " + (state.kycStatus === "Pending" ? "in review" : "received") })));
    poll();
  }

  function settingUp() {
    show(h("div", { class: "card center stack" },
      h("div", { class: "spinner", "aria-hidden": "true" }),
      h("h1", { text: "You're verified. Setting up your card…" }),
      h("p", { class: "muted", text: "Just a moment." })));
    poll();
  }

  // ---------- KYC form ----------
  const STEPS = ["Identity", "Address", "ID photo", "Review"];
  const ID_TYPES = [["PASSPORT", "Passport"], ["NATIONAL_ID", "National ID"], ["DRIVERS_LICENSE", "Driver's licence"], ["VOTERS_CARD", "Voter's card"]];
  const MAX_IMAGE_CHARS = 1_400_000; // the server accepts up to 1.5M characters of data URI

  // Everything the person types stays in this object until it is sent; it is dropped after a successful submit.
  let kyc = blankKyc();
  function blankKyc() {
    return { firstName: "", lastName: "", dateOfBirth: "", phone: "", email: "", address1: "", city: "", state: "", zipcode: "", country: "", idType: "PASSPORT", idNumber: "", idFrontImage: "" };
  }
  const FIELD_DEFS = {
    firstName: { label: "First name", ac: "given-name" },
    lastName: { label: "Last name", ac: "family-name" },
    dateOfBirth: { label: "Date of birth", type: "date", ac: "bday", check: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= new Date().toISOString().slice(0, 10) ? "" : "Enter your date of birth.") },
    phone: { label: "Phone", type: "tel", ac: "tel", inputmode: "tel", hint: "Include the country code, like +2348012345678.", check: (v) => (/^\+?[\d\s()-]{7,20}$/.test(v) ? "" : "Enter a phone number with its country code.") },
    email: { label: "Email", type: "email", ac: "email", inputmode: "email", check: (v) => (/^\S+@\S+\.\S+$/.test(v) ? "" : "Enter a valid email address.") },
    address1: { label: "Street address", ac: "address-line1" },
    city: { label: "City", ac: "address-level2" },
    state: { label: "State or region", ac: "address-level1" },
    zipcode: { label: "Postcode", ac: "postal-code" },
    country: { label: "Country", ac: "country", maxlength: "2", hint: "Two-letter code, like NG or US.", check: (v) => (/^[A-Za-z]{2}$/.test(v) ? "" : "Use the two-letter country code, like NG or US.") },
    idNumber: { label: "ID number", ac: "off" },
  };
  const STEP_FIELDS = [["firstName", "lastName", "dateOfBirth", "phone", "email"], ["address1", "city", "state", "zipcode", "country"], ["idNumber"]];

  function kycForm({ rejected, step = 0, notice } = {}) {
    const errors = h("div", { class: "err", role: "alert", "aria-live": "polite" });
    const fields = new Map(); // name -> { input, error }

    function field(name) {
      const d = FIELD_DEFS[name];
      const id = nextId("f");
      const input = h("input", {
        id, name, type: d.type || "text", autocomplete: d.ac, inputmode: d.inputmode, maxlength: d.maxlength || "120", required: true,
        autocapitalize: name === "email" ? "off" : name === "country" ? "characters" : undefined, spellcheck: "false",
        "aria-describedby": id + "-e" + (d.hint ? " " + id + "-h" : ""), value: kyc[name],
      });
      if (name === "dateOfBirth") input.max = new Date().toISOString().slice(0, 10);
      input.addEventListener("input", () => { kyc[name] = input.value; clear(name); });
      const error = h("span", { class: "err", id: id + "-e" });
      fields.set(name, { input, error });
      return h("label", { for: id }, d.label, input, d.hint ? h("span", { class: "hint", id: id + "-h", text: d.hint }) : null, error);
    }
    function clear(name) {
      const f = fields.get(name);
      if (!f) return;
      f.error.textContent = "";
      f.input.removeAttribute("aria-invalid");
      if (![...fields.values()].some((x) => x.input.getAttribute("aria-invalid"))) errors.textContent = "";
    }
    function validate(names) {
      const bad = [];
      for (const n of names) {
        const d = FIELD_DEFS[n], f = fields.get(n);
        const v = (kyc[n] = f.input.value.trim());
        const msg = !v ? `Enter your ${d.label.toLowerCase()}.` : d.check ? d.check(v) : "";
        if (msg) { f.error.textContent = msg; f.input.setAttribute("aria-invalid", "true"); bad.push(n); }
        else clear(n);
      }
      errors.textContent = bad.length ? (bad.length === 1 ? "Please fix 1 field below." : `Please fix ${bad.length} fields below.`) : "";
      if (bad.length) fields.get(bad[0]).input.focus();
      return !bad.length;
    }
    const go = (n, extra) => kycForm({ rejected, step: n, ...extra });

    let body;
    if (step === 0 || step === 1) {
      const names = STEP_FIELDS[step];
      body = h("form", { class: "stack", novalidate: true, onsubmit: (e) => { e.preventDefault(); if (validate(names)) go(step + 1); } },
        h("fieldset", null, h("legend", { text: step === 0 ? "About you" : "Where you live" }),
          step === 0 ? h("div", { class: "two" }, field("firstName"), field("lastName")) : null,
          ...(step === 0 ? [field("dateOfBirth"), field("phone"), field("email")] : [field("address1"), h("div", { class: "two" }, field("city"), field("state")), h("div", { class: "two" }, field("zipcode"), field("country"))])),
        errors,
        h("div", { class: "actions" },
          step ? h("button", { type: "button", onclick: () => { names.forEach((n) => (kyc[n] = fields.get(n).input.value.trim())); go(step - 1); }, text: "Back" }) : h("span"),
          h("button", { class: "accent", type: "submit", text: "Continue" })));
    } else if (step === 2) {
      body = idPhotoStep(field, validate, errors, go, fields);
    } else {
      body = reviewStep(go, rejected);
    }

    show(h("div", { class: "stack" },
      h("div", null, h("p", { class: "stepname", text: `Step ${step + 1} of ${STEPS.length} · ${STEPS[step]}` }),
        h("ol", { class: "progress", "aria-hidden": "true" }, STEPS.map((_, i) => h("li", { class: i <= step ? "on" : "" })))),
      step === 0 ? h("div", null, h("h1", { text: rejected ? "Let's try that again" : "Verify your identity" }),
        h("p", { class: "lede", text: rejected ? "We couldn't verify your details last time. Check them carefully and send them again." : "Your card is issued once we've checked who you are. It takes about two minutes." })) : null,
      step === 0 && rejected ? h("div", { class: "banner bad", role: "alert", text: "Your last submission wasn't approved." }) : null,
      notice ? h("div", { class: "banner warn", role: "alert", text: notice }) : null,
      h("div", { class: "card" }, body),
      h("p", { class: "small muted", text: "Your identity details go straight to our card partner for verification. We never store them." })));
    if (step === 0 && !rejected) view.querySelector("h1")?.removeAttribute("tabindex");
    if (step > 0) view.querySelector("form, .stack")?.querySelector("input")?.focus();
  }

  function idPhotoStep(field, validate, errors, go, fields) {
    const typeId = nextId("f"), fileId = nextId("f");
    const typeSel = h("select", { id: typeId, name: "idType" }, ID_TYPES.map(([v, t]) => h("option", { value: v, selected: v === kyc.idType, text: t })));
    typeSel.addEventListener("change", () => (kyc.idType = typeSel.value));
    const fileErr = h("span", { class: "err", id: fileId + "-e" });
    const preview = h("img", { alt: "Preview of the ID photo you chose", hidden: !kyc.idFrontImage });
    if (kyc.idFrontImage) preview.src = kyc.idFrontImage;
    const file = h("input", { id: fileId, type: "file", accept: "image/png,image/jpeg", "aria-describedby": fileId + "-h " + fileId + "-e" });
    file.addEventListener("change", async () => {
      fileErr.textContent = ""; file.removeAttribute("aria-invalid");
      const f = file.files && file.files[0];
      if (!f) return;
      try {
        kyc.idFrontImage = await toDataUri(f);
        preview.src = kyc.idFrontImage; preview.hidden = false;
        announce("Photo added.");
      } catch (e) {
        kyc.idFrontImage = ""; preview.hidden = true; file.value = "";
        fileErr.textContent = e.message; file.setAttribute("aria-invalid", "true");
      }
    });
    return h("form", { class: "stack", novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const ok = validate(["idNumber"]);
      if (!kyc.idFrontImage) { fileErr.textContent = "Add a clear photo of the front of your ID."; file.setAttribute("aria-invalid", "true"); if (ok) file.focus(); return; }
      if (ok) go(3);
    } },
      h("fieldset", null, h("legend", { text: "Your ID" }),
        h("label", { for: typeId }, "ID type", typeSel),
        field("idNumber"),
        h("div", { class: "photo" },
          h("label", { for: fileId }, "Photo of the front of your ID", file,
            h("span", { class: "hint", id: fileId + "-h", text: "A JPEG or PNG. All four corners visible, no glare." }), fileErr),
          preview)),
      errors,
      h("div", { class: "actions" },
        h("button", { type: "button", onclick: () => { kyc.idNumber = fields.get("idNumber").input.value.trim(); go(1); }, text: "Back" }),
        h("button", { class: "accent", type: "submit", text: "Continue" })));
  }

  function reviewStep(go, rejected) {
    const rows = [["Name", `${kyc.firstName} ${kyc.lastName}`], ["Date of birth", kyc.dateOfBirth], ["Phone", kyc.phone], ["Email", kyc.email],
      ["Address", `${kyc.address1}, ${kyc.city}, ${kyc.state} ${kyc.zipcode}, ${kyc.country.toUpperCase()}`],
      ["ID", `${(ID_TYPES.find(([v]) => v === kyc.idType) || [, kyc.idType])[1]} · ${kyc.idNumber}`], ["ID photo", "Added"]];
    const err = h("div", { class: "err", role: "alert", "aria-live": "polite" });
    const submit = h("button", { class: "accent", type: "submit", text: "Submit for verification" });
    return h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = ""; submit.disabled = true; submit.classList.add("spin"); submit.textContent = "Submitting…";
      try {
        await api("POST", "/api/me/kyc", {
          firstName: kyc.firstName, lastName: kyc.lastName, dateOfBirth: kyc.dateOfBirth, idType: kyc.idType, idNumber: kyc.idNumber,
          phone: kyc.phone, email: kyc.email, idFrontImage: kyc.idFrontImage,
          address: { address1: kyc.address1, city: kyc.city, state: kyc.state, zipcode: kyc.zipcode, country: kyc.country.toUpperCase() },
        });
        kyc = blankKyc();
        state = await api("GET", "/api/me");
        route();
      } catch (x) {
        if (x instanceof Expired) return;
        err.textContent = x.message;
        submit.disabled = false; submit.classList.remove("spin"); submit.textContent = "Submit for verification";
      }
    } },
      h("fieldset", null, h("legend", { text: "Check and submit" }),
        h("dl", { class: "kv" }, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]))),
      err,
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => go(0), text: "Edit details" }), submit));
  }

  /** Reads an image file as a JPEG/PNG data URI, shrinking phone-camera photos until the server will take them. */
  async function toDataUri(file) {
    if (!/^image\/(png|jpe?g)$/.test(file.type)) throw new Error("Please choose a JPEG or PNG photo.");
    const raw = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Couldn't read that file. Try another photo.")); r.readAsDataURL(file); });
    if (raw.length <= MAX_IMAGE_CHARS) return raw;
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Couldn't read that photo. Try another one.")); i.src = raw; });
    let scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    for (let i = 0; i < 6; i++) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL("image/jpeg", 0.82);
      if (out.length <= MAX_IMAGE_CHARS) return out;
      scale *= 0.75;
    }
    throw new Error("That photo is too large. Try a smaller one.");
  }

  // ---------- spend controls ----------
  function spendControls(opts) {
    const card = state.card;
    const open = (opts && opts.open) || new Set();
    const agents = card.agents;
    const children = [
      h("div", null, h("h1", { text: "Spend controls" }),
        h("p", { class: "lede", text: "Choose how much each agent can spend and where. Changes apply to the next payment." })),
      state.privacyMode ? h("p", { class: "privacy" }, h("span", { class: "badge accent", text: "Privacy" }), "Privacy mode is on: every purchase uses a fresh one-time card.") : null,
      h("div", { class: "totals" },
        h("div", { class: "stat" }, h("span", { class: "lbl", text: "Available to give agents" }), h("b", { class: "num", text: usd(card.balances.unallocatedOnCardCents) })),
        h("div", { class: "stat" }, h("span", { class: "lbl", text: "Card limit" }), h("b", { class: "num", text: usd(card.limits.perTransactionCents) }), h("span", { class: "small muted", text: `per payment · ${usd(card.limits.dailyCents)} a day` }))),
      agents.length
        ? h("div", { class: "stack" }, agents.map((a) => agentCard(a, card, open)))
        : h("div", { class: "empty" }, h("p", { style: "margin:0 0 4px;font-weight:600;color:var(--ink)", text: "No agents yet" }), h("p", { style: "margin:0", text: "The app will add them here when it needs one. You'll be able to set their limits then." })),
    ];
    show(...children);
    document.querySelector("h1").scrollIntoView?.({ block: "start" });
  }

  /** Re-reads the overview and redraws, keeping the agents the person had open. */
  async function reload(extra) {
    const open = new Set([...document.querySelectorAll("details[data-agent][open]")].map((d) => d.dataset.agent));
    if (extra) open.add(extra);
    const y = scrollY;
    state = await api("GET", "/api/me");
    if (state.card) { spendControls({ open }); scrollTo(0, y); } else route();
  }

  function agentCard(a, card, open) {
    const mccs = a.policy.allowedMccs;
    const id = nextId("a");
    const head = h("div", { class: "head" },
      h("div", null, h("div", { class: "name", text: a.name }),
        h("div", { class: "small muted", text: `${usd(a.policy.perTransactionCents)} per payment · ${usd(a.policy.dailyCents)} a day${mccs && mccs.length ? " · " + mccs.length + " categor" + (mccs.length === 1 ? "y" : "ies") : ""}` })),
      h("span", { class: "badge " + (a.revoked ? "" : "ok"), text: a.revoked ? "Paused" : "Active" }));
    const stats = h("div", { class: "stats" },
      h("div", { class: "stat" }, h("span", { class: "lbl", text: "Balance" }), h("b", { class: "num", text: usd(a.balanceCents) })),
      h("div", { class: "stat" }, h("span", { class: "lbl", text: "Spent today" }), h("b", { class: "num", text: usd(a.spentTodayCents) })));
    if (a.revoked) return h("section", { class: "agent revoked", "aria-labelledby": id }, relabel(head, id), stats, h("p", { class: "small muted", style: "margin:0", text: "This agent is paused and can't make payments." }));
    return h("section", { class: "agent", "aria-labelledby": id }, relabel(head, id), stats,
      h("details", { "data-agent": a.agentId, open: open.has(a.agentId) }, h("summary", { text: "Limits" }), limitsForm(a, card)),
      h("details", { "data-agent": a.agentId + ":m", open: open.has(a.agentId + ":m") }, h("summary", { text: "Move money" }), moneyForm(a, card)),
      pauseControl(a));
  }
  const relabel = (head, id) => { head.querySelector(".name").id = id; return head; };

  function moneyField(label, value, hint) {
    const id = nextId("m");
    const input = h("input", { id, inputmode: "decimal", autocomplete: "off", placeholder: "0.00", value: value ?? "", "aria-describedby": id + "-e" + (hint ? " " + id + "-h" : "") });
    const err = h("span", { class: "err", id: id + "-e" });
    return { input, err, node: h("label", { for: id }, label, h("div", { class: "inputwrap" }, h("span", { "aria-hidden": "true", text: "$" }), input), hint ? h("span", { class: "hint", id: id + "-h", text: hint }) : null, err) };
  }
  const centsToField = (c) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

  function limitsForm(a, card) {
    const per = moneyField("Per-payment limit", centsToField(a.policy.perTransactionCents), `Up to ${usd(card.limits.perTransactionCents)}, the card's limit.`);
    const day = moneyField("Daily limit", centsToField(a.policy.dailyCents), `Up to ${usd(card.limits.dailyCents)}, the card's limit.`);
    const mccId = nextId("m");
    const mcc = h("input", { id: mccId, inputmode: "numeric", autocomplete: "off", placeholder: "5411, 5812", value: (a.policy.allowedMccs || []).join(", "), "aria-describedby": mccId + "-h " + mccId + "-e" });
    const mccErr = h("span", { class: "err", id: mccId + "-e" });
    const formErr = h("div", { class: "err", role: "alert", "aria-live": "polite" });
    const save = h("button", { class: "accent", type: "submit", text: "Save limits" });
    const bad = (f, msg) => { f.err.textContent = msg; f.input.setAttribute("aria-invalid", "true"); return f.input; };
    const reset = () => { [per, day].forEach((f) => { f.err.textContent = ""; f.input.removeAttribute("aria-invalid"); }); mccErr.textContent = ""; mcc.removeAttribute("aria-invalid"); formErr.textContent = ""; };
    return h("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); reset();
      const p = toCents(per.input.value), d = toCents(day.input.value);
      const codes = mcc.value.split(",").map((x) => x.trim()).filter(Boolean);
      let first;
      if (p == null) first = bad(per, "Enter an amount like 50 or 50.00.");
      if (d == null) first = first || bad(day, "Enter an amount like 200 or 200.00.");
      if (p != null && d != null && p > d) first = first || bad(per, "The per-payment limit can't be more than the daily limit.");
      if (!codes.every((c) => /^\d{4}$/.test(c))) { mccErr.textContent = "Use 4-digit category codes separated by commas, like 5411, 5812."; mcc.setAttribute("aria-invalid", "true"); first = first || mcc; }
      if (first) { first.focus(); return; }
      save.disabled = true; save.classList.add("spin"); save.textContent = "Saving…";
      try {
        await api("POST", `/api/me/agents/${encodeURIComponent(a.agentId)}/limits`, { perTransactionCents: p, dailyCents: d, allowedMccs: codes });
        await reload();
        announce(`Saved limits for ${a.name}.`);
      } catch (x) {
        if (x instanceof Expired) return;
        formErr.textContent = x.message; // the server's own wording, e.g. "per-payment limit can be at most $50.00, the card's limit"
        save.disabled = false; save.classList.remove("spin"); save.textContent = "Save limits";
      }
    } },
      per.node, day.node,
      h("label", { for: mccId }, "Allowed merchant categories (optional)", mcc,
        h("span", { class: "hint", id: mccId + "-h", text: "Merchant category codes (MCC), comma separated. Leave empty to allow any category." }), mccErr),
      formErr, save);
  }

  function moneyForm(a, card) {
    const amt = moneyField("Amount", "", null);
    const err = h("div", { class: "err", role: "alert", "aria-live": "polite" });
    const give = h("button", { class: "accent", type: "button", text: "Give to agent" });
    const take = h("button", { type: "button", text: "Take back" });
    const run = (btn, verb, path, label) => async () => {
      err.textContent = ""; amt.err.textContent = ""; amt.input.removeAttribute("aria-invalid");
      const c = toCents(amt.input.value);
      if (c == null) { amt.err.textContent = "Enter an amount like 25 or 25.50."; amt.input.setAttribute("aria-invalid", "true"); amt.input.focus(); return; }
      const idle = btn.textContent;
      give.disabled = take.disabled = true; btn.classList.add("spin"); btn.textContent = verb;
      try {
        // A fresh key per click: a retried request for the same click can't move the money twice.
        await api("POST", `/api/me/agents/${encodeURIComponent(a.agentId)}/${path}`, path === "fund" ? { amountCents: c, key: crypto.randomUUID() } : { amountCents: c });
        await reload(a.agentId + ":m");
        announce(`${label} ${usd(c)}.`);
      } catch (x) {
        if (x instanceof Expired) return;
        err.textContent = x.message;
        give.disabled = take.disabled = false; btn.classList.remove("spin"); btn.textContent = idle;
      }
    };
    give.addEventListener("click", run(give, "Giving…", "fund", "Gave"));
    take.addEventListener("click", run(take, "Taking back…", "reclaim", "Took back"));
    return h("div", { class: "stack" },
      h("p", { class: "small muted", style: "margin:0", text: `${usd(card.balances.unallocatedOnCardCents)} is available on your card. ${a.name} holds ${usd(a.balanceCents)}.` }),
      amt.node, err, h("div", { class: "row-actions" }, give, take));
  }

  function pauseControl(a) {
    const holder = h("div");
    const start = h("button", { class: "danger sm", type: "button", "aria-expanded": "false", text: "Pause agent…" });
    const err = h("div", { class: "err", role: "alert", "aria-live": "polite" });
    start.addEventListener("click", () => {
      start.hidden = true;
      const yes = h("button", { class: "danger solid sm", type: "button", text: "Yes, pause it" });
      const no = h("button", { class: "sm", type: "button", text: "Keep it active" });
      const box = h("div", { class: "confirm", role: "group", "aria-label": `Confirm pausing ${a.name}` },
        h("p", { text: `Pause ${a.name}? It will stop making payments for good, and its ${usd(a.balanceCents)} goes back to your card. To use it again, the app will need to set up a new agent.` }),
        h("div", { class: "row-actions" }, yes, no), err);
      holder.append(box);
      yes.focus();
      no.addEventListener("click", () => { box.remove(); start.hidden = false; start.focus(); });
      yes.addEventListener("click", async () => {
        yes.disabled = no.disabled = true; yes.classList.add("spin"); yes.textContent = "Pausing…"; err.textContent = "";
        try {
          await api("POST", `/api/me/agents/${encodeURIComponent(a.agentId)}/revoke`, {});
          await reload();
          announce(`${a.name} is paused.`);
        } catch (x) {
          if (x instanceof Expired) return;
          err.textContent = x.message; yes.disabled = no.disabled = false; yes.classList.remove("spin"); yes.textContent = "Yes, pause it";
        }
      });
    });
    holder.append(start);
    return holder;
  }

  // ---------- go ----------
  if (!token) missing();
  else load();
})();
