// Hero product switch. Outgoing pane exits upward (.out), incoming rises in (.on); after the exit it snaps back below, ready to rise again.
(() => {
  const hero = document.querySelector(".hero"), tabs = [...hero.querySelectorAll("[role=tab]")], panes = [...hero.querySelectorAll(".pane")];
  const set = (mode, focus) => {
    if (hero.dataset.mode === mode) return;
    hero.dataset.mode = mode;
    tabs.forEach((t) => { const on = t.dataset.mode === mode; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
    panes.forEach((p) => {
      clearTimeout(p._t);
      if (p.dataset.pane === mode) { p.classList.remove("out"); p.classList.add("on"); p.inert = false; p.removeAttribute("aria-hidden"); return; }
      if (!p.classList.contains("on")) return;
      p.classList.replace("on", "out"); p.inert = true; p.setAttribute("aria-hidden", "true");
      p._t = setTimeout(() => { p.classList.add("snap"); p.classList.remove("out"); void p.offsetWidth; p.classList.remove("snap"); }, 1000);
    });
    history.replaceState(null, "", mode === "checkout" ? "#checkout" : location.pathname);
  };
  tabs.forEach((t) => t.addEventListener("click", () => set(t.dataset.mode)));
  hero.querySelector("[role=tablist]").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault(); set(hero.dataset.mode === "cards" ? "checkout" : "cards", true);
  });
  const fromHash = () => { if (location.hash === "#checkout") { set("checkout"); scrollTo({ top: 0, behavior: "smooth" }); } };
  addEventListener("hashchange", fromHash); fromHash();
})();
