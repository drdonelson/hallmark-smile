(function () {
  'use strict';
  if (document.getElementById('lucid-sim-widget')) return; // guard against double-load

  var script = document.currentScript || (function () {
    var s = document.querySelectorAll('script[src*="widget.js"]');
    return s[s.length - 1];
  })();

  var practice  = (script && script.getAttribute('data-practice'))   || 'Lucid ROI';
  var leadEmail = (script && script.getAttribute('data-lead-email'))  || 'david@lucidroi.com';
  var tenant    = (script && script.getAttribute('data-tenant'))      || 'lucid';
  var label     = (script && script.getAttribute('data-label'))       || 'Try Smile Simulator';

  var SIM_BASE = 'https://drdonelson.github.io/hallmark-smile/smile-simulator.html';
  var simSrc = SIM_BASE
    + '?leadEmail=' + encodeURIComponent(leadEmail)
    + '&practice='  + encodeURIComponent(practice)
    + '&tenant='    + encodeURIComponent(tenant);

  /* ── Styles ── */
  var style = document.createElement('style');
  style.textContent = [
    '#lucid-sim-widget{position:fixed;left:0;top:50%;transform:translateY(-50%) rotate(-90deg) translateX(-50%);transform-origin:left center;z-index:99998;cursor:pointer;background:#2D6FFF;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;padding:10px 22px 10px 18px;border-radius:0 0 10px 10px;box-shadow:2px 2px 16px rgba(45,111,255,.35);display:flex;align-items:center;gap:9px;white-space:nowrap;border:none;outline:none;transition:background .15s,box-shadow .15s}',
    '#lucid-sim-widget:hover{background:#1a5aef;box-shadow:2px 2px 24px rgba(45,111,255,.5)}',
    '#lucid-sim-widget svg{flex-shrink:0;transform:rotate(90deg)}',
    '#lucid-sim-overlay{position:fixed;inset:0;z-index:99999;background:rgba(6,14,31,.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .3s}',
    '#lucid-sim-overlay.open{opacity:1;pointer-events:auto}',
    '#lucid-sim-modal{position:relative;width:min(480px,96vw);height:min(820px,92vh);background:#0d1929;border-radius:18px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.6);transform:translateY(24px) scale(.97);transition:transform .35s cubic-bezier(.16,1,.3,1)}',
    '#lucid-sim-overlay.open #lucid-sim-modal{transform:translateY(0) scale(1)}',
    '#lucid-sim-iframe{width:100%;height:100%;border:none;display:block}',
    '#lucid-sim-close{position:absolute;top:12px;right:12px;z-index:10;width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.12);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;line-height:1;transition:background .15s}',
    '#lucid-sim-close:hover{background:rgba(255,255,255,.22)}',
    '#lucid-sim-badge{position:absolute;bottom:0;left:0;right:0;text-align:center;padding:7px;background:rgba(6,14,31,.7);font-family:-apple-system,sans-serif;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.35);pointer-events:none}',
  ].join('');
  document.head.appendChild(style);

  /* ── Floating tab ── */
  var tab = document.createElement('button');
  tab.id = 'lucid-sim-widget';
  tab.setAttribute('aria-label', 'Open Smile Simulator');
  tab.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>'
    + label;
  document.body.appendChild(tab);

  /* ── Modal overlay ── */
  var overlay = document.createElement('div');
  overlay.id = 'lucid-sim-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Smile Simulator');

  var modal = document.createElement('div');
  modal.id = 'lucid-sim-modal';

  var closeBtn = document.createElement('button');
  closeBtn.id = 'lucid-sim-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '&times;';

  var iframe = document.createElement('iframe');
  iframe.id = 'lucid-sim-iframe';
  iframe.allow = 'camera';
  iframe.setAttribute('loading', 'lazy');
  // src set on first open to avoid loading until needed

  var badge = document.createElement('div');
  badge.id = 'lucid-sim-badge';
  badge.textContent = 'Powered by Lucid ROI';

  modal.appendChild(closeBtn);
  modal.appendChild(iframe);
  modal.appendChild(badge);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  /* ── Open / close ── */
  var loaded = false;
  function open() {
    if (!loaded) { iframe.src = simSrc; loaded = true; }
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function close() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  tab.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });
})();
