// Applies the saved theme before first paint (no flash). Loaded as an external script because the
// CSP forbids inline scripts. Mirrors web/lib/theme.ts (storage key 'baton-theme', class 'dark').
(function () {
  var theme = 'system';
  try {
    var stored = localStorage.getItem('baton-theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') theme = stored;
  } catch (e) {
    // Storage unavailable: fall back to the system preference.
  }
  var dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  if (dark) root.classList.add('dark');
  root.style.colorScheme = dark ? 'dark' : 'light';
})();
