/**
 * Lightbox — Full-screen image viewer with navigation
 * Usage: Add data-lightbox="group-name" to <img> elements.
 * Images with the same group name can be navigated with arrows.
 */
(function() {
  'use strict';

  var overlay, imgEl, captionEl, closeBtn, prevBtn, nextBtn, counterEl;
  var currentGroup = [];
  var currentIndex = 0;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    overlay.innerHTML =
      '<button class="lightbox-overlay__close" aria-label="Close">&times;</button>' +
      '<button class="lightbox-overlay__nav lightbox-overlay__nav--prev" aria-label="Previous">&#8249;</button>' +
      '<button class="lightbox-overlay__nav lightbox-overlay__nav--next" aria-label="Next">&#8250;</button>' +
      '<img src="" alt="">' +
      '<div class="lightbox-overlay__caption"></div>' +
      '<div class="lightbox-overlay__counter"></div>';
    document.body.appendChild(overlay);

    imgEl = overlay.querySelector('img');
    captionEl = overlay.querySelector('.lightbox-overlay__caption');
    closeBtn = overlay.querySelector('.lightbox-overlay__close');
    prevBtn = overlay.querySelector('.lightbox-overlay__nav--prev');
    nextBtn = overlay.querySelector('.lightbox-overlay__nav--next');
    counterEl = overlay.querySelector('.lightbox-overlay__counter');

    closeBtn.addEventListener('click', close);
    prevBtn.addEventListener('click', function(e) { e.stopPropagation(); navigate(-1); });
    nextBtn.addEventListener('click', function(e) { e.stopPropagation(); navigate(1); });
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) close();
    });
  }

  function open(groupName, startIndex) {
    var all = document.querySelectorAll('img[data-lightbox="' + groupName + '"]');
    currentGroup = [];
    all.forEach(function(img) {
      currentGroup.push({
        src: img.src,
        alt: img.alt || '',
        caption: img.dataset.caption || img.alt || ''
      });
    });
    currentIndex = startIndex || 0;
    show();
    overlay.classList.add('is-active');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    overlay.classList.remove('is-active');
    document.body.style.overflow = '';
  }

  function navigate(dir) {
    currentIndex += dir;
    if (currentIndex < 0) currentIndex = currentGroup.length - 1;
    if (currentIndex >= currentGroup.length) currentIndex = 0;
    show();
  }

  function show() {
    if (!currentGroup.length) return;
    var item = currentGroup[currentIndex];
    imgEl.src = item.src;
    imgEl.alt = item.alt;
    captionEl.textContent = item.caption;
    captionEl.style.display = item.caption ? 'block' : 'none';
    counterEl.textContent = (currentIndex + 1) + ' / ' + currentGroup.length;
    prevBtn.style.display = currentGroup.length > 1 ? 'flex' : 'none';
    nextBtn.style.display = currentGroup.length > 1 ? 'flex' : 'none';
  }

  document.addEventListener('DOMContentLoaded', function() {
    createOverlay();

    document.addEventListener('click', function(e) {
      var img = e.target.closest('img[data-lightbox]');
      if (!img) return;
      e.preventDefault();
      var group = img.dataset.lightbox;
      var all = document.querySelectorAll('img[data-lightbox="' + group + '"]');
      var idx = 0;
      all.forEach(function(el, i) {
        if (el === img) idx = i;
      });
      open(group, idx);
    });

    // Make lightbox images keyboard-accessible
    document.querySelectorAll('img[data-lightbox]').forEach(function(img) {
      if (!img.getAttribute('tabindex')) img.setAttribute('tabindex', '0');
      img.setAttribute('role', 'button');
      img.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          img.click();
        }
      });
    });

    document.addEventListener('keydown', function(e) {
      if (!overlay || !overlay.classList.contains('is-active')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') navigate(-1);
      else if (e.key === 'ArrowRight') navigate(1);
    });
  });
})();
