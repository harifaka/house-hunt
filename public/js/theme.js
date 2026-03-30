// Theme toggle — dark mode default, preference stored in cookie
(function () {
  'use strict';

  function getTheme() {
    var match = document.cookie.match(/(?:^|; )theme=(dark|light)/);
    return match ? match[1] : 'dark';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Store preference in cookie for 365 days
    var expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = 'theme=' + theme + '; path=/; expires=' + expires + '; SameSite=Lax';
    updateToggleIcon(theme);
  }

  function updateToggleIcon(theme) {
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var theme = getTheme();
    updateToggleIcon(theme);

    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', function () {
        var current = document.documentElement.getAttribute('data-theme') || 'dark';
        setTheme(current === 'dark' ? 'light' : 'dark');
      });
    }
  });
})();
