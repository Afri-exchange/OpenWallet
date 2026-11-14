// Docs + landing helper: fills in this server's origin, filters the sidebar, highlights the section in view.
(() => {
  const origin = location.origin;
  const pattern = /<origin>|http:\/\/127\.0\.0\.1:8787/g;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.search(pattern) >= 0) nodes.push(n);
  for (const n of nodes) n.nodeValue = n.nodeValue.replace(pattern, origin);

  const side = document.getElementById("side");
  if (!side) return;
  const links = [...side.querySelectorAll("a[href^='#']")];

  const q = document.getElementById("q");
  q?.addEventListener("input", () => {
    const term = q.value.trim().toLowerCase();
    let shown = 0;
    side.querySelectorAll("li").forEach((li) => {
      const hit = !term || li.textContent.toLowerCase().includes(term) || (li.dataset.k ?? "").includes(term);
      li.hidden = !hit;
      if (hit) shown++;
    });
    document.getElementById("none").hidden = shown > 0;
  });
  q?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") links.find((a) => !a.closest("li").hidden)?.click();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); q?.focus(); }
  });

  // Scrollspy: the last heading above the top third of the viewport is current.
  const heads = links.map((a) => document.getElementById(a.getAttribute("href").slice(1))).filter(Boolean);
  let raf = 0;
  const spy = () => {
    raf = 0;
    let cur = heads[0];
    for (const h of heads) if (h.getBoundingClientRect().top < innerHeight * 0.33) cur = h;
    links.forEach((a) => (a.getAttribute("href") === "#" + cur?.id ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
  };
  addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(spy); }, { passive: true });
  spy();
})();
