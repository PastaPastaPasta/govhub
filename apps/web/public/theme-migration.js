try {
  const old = localStorage.getItem('govhub.theme');
  if (old && !localStorage.getItem('dh-theme') && !document.cookie.split(';').some(c => c.trim().startsWith('dh_theme='))) {
    if (['light', 'dark', 'system'].includes(old)) window.dashhq.theme.set(old);
  }
  localStorage.removeItem('govhub.theme');
} catch {}
