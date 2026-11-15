// Applies the saved light/dark pick before first paint (CSP forbids inline scripts). app.js owns the toggle.
try {
  const theme = localStorage.getItem('mendil-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* storage blocked: follow the OS */ }
