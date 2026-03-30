/**
 * Toast notification system
 * Usage: window.showToast('Message', 'success'|'warning'|'error', durationMs)
 */
(function() {
  'use strict';

  var container;

  function init() {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  window.showToast = function(message, type, duration) {
    if (!container) init();
    type = type || 'success';
    duration = duration || 2500;

    var toast = document.createElement('div');
    toast.className = 'toast toast--' + type;

    var icon = '✅';
    if (type === 'warning') icon = '⚠️';
    else if (type === 'error') icon = '❌';

    toast.innerHTML = '<span>' + icon + '</span><span>' + message + '</span>';
    container.appendChild(toast);

    setTimeout(function() {
      toast.classList.add('toast--fadeout');
      setTimeout(function() {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 350);
    }, duration);
  };
})();
