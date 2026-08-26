// Loaded on every page (base.html): theme toggle + the mobile sidebar
// drawer, both part of the shared shell now (sidebar/nav/theme-toggle live
// in base.html, not per-page). The actual before-paint theme application
// lives inline in base.html's <head> -- this just wires the toggle button
// and keeps its icon in sync.

function effectiveTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const SUN_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function updateToggleIcon() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  // Shows the mode tapping it switches TO.
  btn.innerHTML = effectiveTheme() === "dark" ? SUN_SVG : MOON_SVG;
}

const toggleBtn = document.getElementById("theme-toggle");
if (toggleBtn) {
  toggleBtn.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("mauso_theme", next);
    updateToggleIcon();
  });
}

updateToggleIcon();

// Sidebar drawer (mobile only -- harmless no-op on desktop, where .sidebar
// ignores the "open" class under the CSS media query). Exposed on window
// so page-specific scripts (app.js, on the Chat page) can close the drawer
// after an action like picking a conversation.
function setSidebarOpen(open) {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (!sidebar || !backdrop) return;
  const shouldOpen = open === undefined ? !sidebar.classList.contains("open") : open;
  sidebar.classList.toggle("open", shouldOpen);
  backdrop.classList.toggle("open", shouldOpen);
}
window.mausoSetSidebarOpen = setSidebarOpen;

const sidebarToggleBtn = document.getElementById("sidebar-toggle");
if (sidebarToggleBtn) sidebarToggleBtn.addEventListener("click", () => setSidebarOpen());
const sidebarBackdropEl = document.getElementById("sidebar-backdrop");
if (sidebarBackdropEl) sidebarBackdropEl.addEventListener("click", () => setSidebarOpen(false));
