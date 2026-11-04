// Shared by every page: theme toggle, code-copy buttons, active nav link, toast. No dependencies.
(() => {
  const root = document.documentElement;
  const saved = localStorage.getItem("ac-theme");
  if (saved) root.dataset.theme = saved;
  const sun = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const moon = '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  const paint = (b) => { b.innerHTML = isDark() ? sun : moon; b.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme"); };
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
    paint(b);
    b.addEventListener("click", () => { root.dataset.theme = isDark() ? "light" : "dark"; localStorage.setItem("ac-theme", root.dataset.theme); paint(b); });
  });

  const msg = document.getElementById("msg");
  let t;
  window.toast = (text, kind) => {
    if (!msg) return;
    msg.textContent = (kind === "ok" ? "✓ " : "") + text;
    msg.className = "show " + (kind || "");
    clearTimeout(t);
    t = setTimeout(() => (msg.className = ""), kind === "bad" ? 7000 : 3500);
  };
  msg?.addEventListener("click", () => (msg.className = ""));

  // Copy: any [data-copy] copies its value; any .code .cp copies the sibling <pre>.
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-copy], .code .cp");
    if (!b) return;
    const text = b.dataset.copy ?? b.closest(".code").querySelector("pre").innerText;
    navigator.clipboard.writeText(text).then(() => window.toast("Copied", "ok"), () => window.toast("Couldn't copy. Select the text and copy it by hand.", "bad"));
  });
  document.querySelectorAll(".code").forEach((c) => {
    if (c.querySelector(".cp")) return;
    const bar = c.querySelector(".bar") ?? c.insertAdjacentElement("afterbegin", Object.assign(document.createElement("div"), { className: "bar" }));
    if (!bar.firstChild) bar.innerHTML = `<span>${c.dataset.lang || ""}</span>`;
    bar.insertAdjacentHTML("beforeend", '<button type="button" class="cp">Copy</button>');
  });

  const here = location.pathname.replace(/\/$/, "") || "/";
  document.querySelectorAll(".nav-links a").forEach((a) => { if ((new URL(a.href).pathname.replace(/\/$/, "") || "/") === here) a.setAttribute("aria-current", "page"); });
})();
