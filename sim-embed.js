/*! Lucid Smile Simulator embed helper.
 * Paste AFTER the simulator <iframe> — auto-sizes the frame to the sim's
 * content so there is never an inner scrollbar. Hosted so page builders
 * (Elementor etc.) can't mangle inline JS with line wraps / nbsp.
 */
(function () {
  function find() {
    return document.querySelector('iframe[src*="app.lucidroi.com/smile-simulator"]');
  }
  function prep() {
    var f = find();
    if (f) { f.setAttribute('scrolling', 'no'); f.style.overflow = 'hidden'; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', prep);
  else prep();
  window.addEventListener('message', function (e) {
    if (e.origin !== 'https://app.lucidroi.com') return;
    var h = e.data && e.data.lucidSimHeight;
    if (h > 0) { var f = find(); if (f) f.style.height = Math.ceil(h) + 'px'; }
  });
})();
