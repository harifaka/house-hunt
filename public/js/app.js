// Sidebar toggle
document.addEventListener('DOMContentLoaded', function() {
  var hamburger = document.getElementById('hamburger-toggle');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');

  if (hamburger && sidebar && overlay) {
    hamburger.addEventListener('click', function() {
      hamburger.classList.toggle('is-active');
      sidebar.classList.toggle('is-open');
      overlay.classList.toggle('is-visible');
    });

    overlay.addEventListener('click', function() {
      hamburger.classList.remove('is-active');
      sidebar.classList.remove('is-open');
      overlay.classList.remove('is-visible');
    });
  }
});
