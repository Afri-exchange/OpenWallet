// Landing motion layer: particle field, card tilt, scroll reveals, rolling titles, magnetic buttons, confetti.
// Everything here is decoration. With reduced motion it only sets up the ticker loop and leaves the page still.
(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const track = $(".ticker .track");
  if (track) track.append(...[...track.children].map((n) => n.cloneNode(true)));
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  root.classList.add("motion");
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---- confetti: one fixed canvas, only drawing while pieces are alive ----
  const bc = Object.assign(document.createElement("canvas"), { className: "burst" });
  bc.setAttribute("aria-hidden", "true");
  document.body.append(bc);
  const bx = bc.getContext("2d");
  let bits = [], bursting = false;
  const burst = (x, y, n = 80) => {
    const colors = [css("--accent"), "#7c5cff", "#ff4fb8", "#19d3a2", "#ffb020", "#ffffff"];
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), v = rand(3, 11);
      bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, r: rand(0, 6), vr: rand(-0.3, 0.3), w: rand(6, 11), h: rand(3, 6), c: colors[i % colors.length], life: 1 });
    }
    if (!bursting) { bursting = true; requestAnimationFrame(drawBurst); }
  };
  function drawBurst() {
    const d = Math.min(devicePixelRatio, 2);
    if (bc.width !== innerWidth * d) { bc.width = innerWidth * d; bc.height = innerHeight * d; }
    bx.setTransform(d, 0, 0, d, 0, 0);
    bx.clearRect(0, 0, innerWidth, innerHeight);
    bits = bits.filter((p) => (p.life -= 0.011) > 0 && p.y < innerHeight + 40);
    for (const p of bits) {
      p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.22; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      bx.save(); bx.globalAlpha = Math.min(1, p.life * 2); bx.translate(p.x, p.y); bx.rotate(p.r); bx.scale(1, Math.cos(p.r * 2));
      bx.fillStyle = p.c; bx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); bx.restore();
    }
    if (bits.length) requestAnimationFrame(drawBurst); else { bursting = false; bx.clearRect(0, 0, innerWidth, innerHeight); }
  }
  const centre = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };

  // ---- hero particle field: drifting nodes, links between neighbours and to the pointer ----
  const hero = $(".hero"), cv = $(".hero .field");
  if (cv) {
    const cx = cv.getContext("2d");
    let w = 0, h = 0, pts = [], live = false, color = css("--accent");
    const ptr = { x: -1e4, y: -1e4 };
    const size = () => {
      const d = Math.min(devicePixelRatio, 2), r = cv.getBoundingClientRect();
      w = r.width; h = r.height; cv.width = w * d; cv.height = h * d; cx.setTransform(d, 0, 0, d, 0, 0);
      const n = Math.min(110, Math.round((w * h) / 11000));
      pts = Array.from({ length: n }, () => ({ x: rand(0, w), y: rand(0, h), vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), s: rand(0.8, 2.2) }));
    };
    const frame = () => {
      if (!live) return;
      cx.clearRect(0, 0, w, h);
      cx.fillStyle = cx.strokeStyle = color;
      for (const p of pts) {
        const dx = p.x - ptr.x, dy = p.y - ptr.y, dd = dx * dx + dy * dy;
        if (dd < 140 * 140) { const f = (1 - Math.sqrt(dd) / 140) * 0.6; p.vx += (dx / 140) * f; p.vy += (dy / 140) * f; }
        p.vx *= 0.97; p.vy *= 0.97;
        p.vx += rand(-0.02, 0.02); p.vy += rand(-0.02, 0.02);
        p.x = (p.x + p.vx + w) % w; p.y = (p.y + p.vy + h) % h;
      }
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        cx.globalAlpha = 0.55; cx.beginPath(); cx.arc(a.x, a.y, a.s, 0, 7); cx.fill();
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 110) { cx.globalAlpha = (1 - d / 110) * 0.28; cx.lineWidth = 1; cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y); cx.stroke(); }
        }
        const d = Math.hypot(a.x - ptr.x, a.y - ptr.y);
        if (d < 190) { cx.globalAlpha = (1 - d / 190) * 0.6; cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(ptr.x, ptr.y); cx.stroke(); }
      }
      cx.globalAlpha = 1;
      requestAnimationFrame(frame);
    };
    size();
    addEventListener("resize", size);
    hero.addEventListener("pointermove", (e) => { const r = cv.getBoundingClientRect(); ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top; });
    hero.addEventListener("pointerleave", () => { ptr.x = ptr.y = -1e4; });
    new IntersectionObserver(([e]) => { const was = live; live = e.isIntersecting; if (live && !was) requestAnimationFrame(frame); }).observe(hero);
    // follow the theme toggle
    new MutationObserver(() => (color = css("--accent"))).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  }

  // ---- hero visuals: tilt follows the pointer; the code panel and badges move on their own depth ----
  const stageWrap = $(".hero .wrap > .swap:last-child");
  if (stageWrap && fine) {
    stageWrap.addEventListener("pointermove", (e) => {
      const r = stageWrap.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      stageWrap.style.setProperty("--sx", (x - 0.5).toFixed(3)); stageWrap.style.setProperty("--sy", (y - 0.5).toFixed(3));
      for (const c of $$(".vcard, .rcpt", stageWrap)) {
        c.style.setProperty("--rx", ((0.5 - y) * 18).toFixed(2) + "deg"); c.style.setProperty("--ry", ((x - 0.5) * 24).toFixed(2) + "deg");
      }
    });
    stageWrap.addEventListener("pointerleave", () => {
      stageWrap.style.removeProperty("--sx"); stageWrap.style.removeProperty("--sy");
      for (const c of $$(".vcard, .rcpt", stageWrap)) ["--rx", "--ry"].forEach((p) => c.style.removeProperty(p));
    });
  }
  const card = $(".stage .vcard");
  card?.addEventListener("click", (e) => { card.classList.remove("spin"); void card.offsetWidth; card.classList.add("spin"); burst(e.clientX, e.clientY, 60); });
  card?.addEventListener("animationend", (e) => e.animationName === "spinY" && card.classList.remove("spin"));
  // the checkout receipt gets paid ~2s after its pane comes in: celebrate it
  let paidT;
  new MutationObserver(() => {
    clearTimeout(paidT);
    if (hero.dataset.mode === "checkout") paidT = setTimeout(() => { const s = $(".s-paid"); if (s) burst(...centre(s), 70); }, 2050);
  }).observe(hero, { attributes: true, attributeFilter: ["data-mode"] });

  // ---- section titles roll in word by word; kickers decode ----
  for (const h of $$("main h2.t")) {
    const words = h.textContent.trim().split(/\s+/);
    h.setAttribute("aria-label", words.join(" "));
    h.innerHTML = words.map((w, i) => `<span class="w" aria-hidden="true" style="--i:${i}"><span></span></span>`).join(" ");
    $$(".w>span", h).forEach((s, i) => (s.textContent = words[i]));
    h.classList.add("split");
  }
  const decode = (el) => {
    const txt = el.textContent, glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$#%&*";
    el.setAttribute("aria-label", txt);
    let f = 0;
    const step = () => {
      el.textContent = [...txt].map((c, i) => (c === " " || i < f / 2 - 4 ? c : glyphs[(Math.random() * glyphs.length) | 0])).join("");
      if (f++ < txt.length * 2 + 8) requestAnimationFrame(step); else el.textContent = txt;
    };
    step();
  };

  // ---- scroll reveals: staggered by position among siblings ----
  const sel = ".sec .sub, .steps>.step, .grid>.card, .list>li, .tabs, .final .sub, .final .cta>*";
  for (const el of $$(sel)) {
    el.classList.add("rv");
    el.style.setProperty("--rv", [...el.parentElement.children].filter((c) => c.matches(sel)).indexOf(el));
  }
  const io = new IntersectionObserver((entries) => {
    for (const { target: el, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      io.unobserve(el);
      el.classList.add("in");
      if (el.classList.contains("kick")) decode(el);
      if (el.classList.contains("final")) setTimeout(() => burst(...centre($("h2", el)), 120), 500);
      // hand control back to the element's own hover transitions once the entrance is done
      if (el.classList.contains("rv")) setTimeout(() => el.classList.remove("rv", "in"), 1200 + (+el.style.getPropertyValue("--rv") || 0) * 90);
    }
  }, { threshold: 0.15, rootMargin: "0px 0px -6% 0px" });
  $$(".rv, .split, .kick, .steps, .final").forEach((el) => io.observe(el));

  // ---- magnetic buttons, ripples ----
  if (fine) {
    for (const b of $$(".btn.lg, .nav .btn")) {
      b.classList.add("mag");
      b.addEventListener("pointermove", (e) => { const r = b.getBoundingClientRect(); b.style.translate = `${(e.clientX - r.left - r.width / 2) * 0.22}px ${(e.clientY - r.top - r.height / 2) * 0.35}px`; });
      b.addEventListener("pointerleave", () => (b.style.translate = ""));
    }
  }
  document.addEventListener("pointerdown", (e) => {
    const b = e.target.closest?.(".btn.lg");
    if (!b) return;
    const r = b.getBoundingClientRect(), s = Object.assign(document.createElement("span"), { className: "rip" });
    s.style.left = e.clientX - r.left + "px"; s.style.top = e.clientY - r.top + "px";
    b.append(s); s.addEventListener("animationend", () => s.remove());
  });

  // ---- scroll progress ----
  const bar = Object.assign(document.createElement("div"), { className: "scrollbar" });
  bar.setAttribute("aria-hidden", "true");
  document.body.append(bar);
  let queued = false;
  addEventListener("scroll", () => {
    if (queued) return; queued = true;
    requestAnimationFrame(() => { queued = false; const m = root.scrollHeight - innerHeight; bar.style.setProperty("--sp", m > 0 ? (scrollY / m).toFixed(4) : 0); });
  }, { passive: true });
})();
