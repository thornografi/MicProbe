// Shared by the landing, app and legal pages; the HTML retains a no-JS fallback.
document.querySelectorAll('[data-copyright-year]').forEach(element => {
  element.textContent = String(new Date().getFullYear());
});
