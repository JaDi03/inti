// Apply the theme before first paint (same key as src/theme.tsx) to avoid a light flash.
(function () {
  var theme;
  try { theme = localStorage.getItem("inti-theme"); } catch (e) {}
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  if (theme === "dark") document.documentElement.classList.add("dark");
  document.documentElement.style.colorScheme = theme;
})();
