// Runs before first paint so the saved theme never flashes.
(function () {
  try {
    var t = localStorage.getItem("sk-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) { /* storage blocked: follow the system theme */ }
})();
