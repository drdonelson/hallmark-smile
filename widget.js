(function () {
  'use strict';
  if (document.getElementById('lucid-sim-widget')) return;

  var script = document.currentScript || (function () {
    var s = document.querySelectorAll('script[src*="widget.js"]');
    return s[s.length - 1];
  })();

  var practice  = (script && script.getAttribute('data-practice'))   || 'Lucid ROI';
  var leadEmail = (script && script.getAttribute('data-lead-email'))  || 'david@lucidroi.com';
  var tenant    = (script && script.getAttribute('data-tenant'))      || 'lucid';
  var headline  = (script && script.getAttribute('data-headline'))    || 'See Your New Smile';
  var subtext   = (script && script.getAttribute('data-subtext'))     || 'AI-powered preview in 30 seconds. No obligation.';
  var btnLabel  = (script && script.getAttribute('data-btn-label'))   || 'Try It Free →';

  var DISMISSED_KEY = 'lucid_widget_dismissed';
  if (sessionStorage.getItem(DISMISSED_KEY)) return;

  var SIM_BASE = 'https://drdonelson.github.io/hallmark-smile/smile-simulator.html';
  var simSrc = SIM_BASE
    + '?leadEmail=' + encodeURIComponent(leadEmail)
    + '&practice='  + encodeURIComponent(practice)
    + '&tenant='    + encodeURIComponent(tenant);

  /* ── Styles ── */
  var style = document.createElement('style');
  style.textContent = [
    '#lucid-sim-widget{position:fixed;bottom:24px;right:24px;z-index:99998;width:288px;background:#fff;border-radius:18px;box-shadow:0 8px 40px rgba(10,22,40,.18),0 2px 8px rgba(10,22,40,.08);overflow:hidden;transform:translateY(16px);opacity:0;transition:transform .45s cubic-bezier(.16,1,.3,1),opacity .35s;pointer-events:none}',
    '#lucid-sim-widget.lsw-visible{transform:translateY(0);opacity:1;pointer-events:auto}',
    '#lucid-sim-widget .lsw-top{background:#2D6FFF;padding:14px 40px 14px 16px;position:relative}',
    '#lucid-sim-widget .lsw-eye{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.7);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin-bottom:4px}',
    '#lucid-sim-widget .lsw-h{font-size:17px;font-weight:700;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.2}',
    '#lucid-sim-widget .lsw-close{position:absolute;top:10px;right:10px;width:26px;height:26px;background:rgba(255,255,255,.18);border:none;border-radius:50%;cursor:pointer;color:#fff;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .15s}',
    '#lucid-sim-widget .lsw-close:hover{background:rgba(255,255,255,.32)}',
    '#lucid-sim-widget .lsw-body{padding:14px 16px 18px}',
    '#lucid-sim-widget .lsw-sub{font-size:13px;color:#4a5a7a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45;margin-bottom:14px}',
    '#lucid-sim-widget .lsw-preview{display:flex;gap:8px;margin-bottom:14px}',
    '#lucid-sim-widget .lsw-thumb{width:52px;height:52px;border-radius:10px;background:linear-gradient(135deg,#e8f0ff 0%,#d0e0ff 100%);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '#lucid-sim-widget .lsw-thumb svg{opacity:.6}',
    '#lucid-sim-widget .lsw-arrow{width:18px;height:52px;display:flex;align-items:center;justify-content:center;color:#9db0d0;font-size:18px;flex-shrink:0}',
    '#lucid-sim-widget .lsw-thumb2{background:linear-gradient(135deg,#dff0e8 0%,#b8e6cc 100%)}',
    '#lucid-sim-widget .lsw-thumb2 svg{opacity:.55}',
    '#lucid-sim-widget .lsw-btn{display:block;width:100%;padding:12px;background:#2D6FFF;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;letter-spacing:.02em;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;transition:background .15s,transform .1s}',
    '#lucid-sim-widget .lsw-btn:hover{background:#1a5aef;transform:translateY(-1px)}',
    '#lucid-sim-widget .lsw-btn:active{transform:translateY(0)}',
    '#lucid-sim-widget .lsw-powered{text-align:center;font-size:10px;color:#b0bccf;font-family:-apple-system,sans-serif;margin-top:10px;letter-spacing:.03em}',
    // Modal
    '#lucid-sim-overlay{position:fixed;inset:0;z-index:99999;background:rgba(6,14,31,.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .3s}',
    '#lucid-sim-overlay.open{opacity:1;pointer-events:auto}',
    '#lucid-sim-modal{position:relative;width:min(480px,96vw);height:min(840px,93vh);background:#0d1929;border-radius:20px;overflow:hidden;box-shadow:0 32px 80px rgba(0,0,0,.55);transform:translateY(28px) scale(.97);transition:transform .38s cubic-bezier(.16,1,.3,1)}',
    '#lucid-sim-overlay.open #lucid-sim-modal{transform:translateY(0) scale(1)}',
    '#lucid-sim-iframe{width:100%;height:100%;border:none;display:block}',
    '#lucid-sim-close-modal{position:absolute;top:12px;right:12px;z-index:10;width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.1);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;line-height:1;transition:background .15s}',
    '#lucid-sim-close-modal:hover{background:rgba(255,255,255,.2)}',
  ].join('');
  document.head.appendChild(style);

  /* ── Widget card ── */
  var card = document.createElement('div');
  card.id = 'lucid-sim-widget';
  card.setAttribute('role', 'complementary');
  card.setAttribute('aria-label', 'Try the Smile Simulator');
  card.innerHTML = [
    '<div class="lsw-top">',
      '<div class="lsw-eye">AI Smile Preview</div>',
      '<div class="lsw-h">' + headline + '</div>',
      '<button class="lsw-close" id="lsw-dismiss" aria-label="Dismiss">&times;</button>',
    '</div>',
    '<div class="lsw-body">',
      '<div class="lsw-preview">',
        '<div class="lsw-thumb">',
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2D6FFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
        '</div>',
        '<div class="lsw-arrow">→</div>',
        '<div class="lsw-thumb lsw-thumb2">',
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a8c52" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/><polyline points="9 13 11 15 15 11" stroke="#1a8c52" stroke-width="2"/></svg>',
        '</div>',
      '</div>',
      '<div class="lsw-sub">' + subtext + '</div>',
      '<button class="lsw-btn" id="lsw-open">' + btnLabel + '</button>',
      '<div class="lsw-powered">Powered by Lucid ROI</div>',
    '</div>',
  ].join('');
  document.body.appendChild(card);

  /* ── Modal ── */
  var overlay = document.createElement('div');
  overlay.id = 'lucid-sim-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Smile Simulator');

  var modal = document.createElement('div');
  modal.id = 'lucid-sim-modal';

  var closeModal = document.createElement('button');
  closeModal.id = 'lucid-sim-close-modal';
  closeModal.setAttribute('aria-label', 'Close');
  closeModal.innerHTML = '&times;';

  var iframe = document.createElement('iframe');
  iframe.id = 'lucid-sim-iframe';
  iframe.allow = 'camera';
  iframe.setAttribute('loading', 'lazy');

  modal.appendChild(closeModal);
  modal.appendChild(iframe);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  /* ── Behaviour ── */
  var loaded = false;

  function openModal() {
    if (!loaded) { iframe.src = simSrc; loaded = true; }
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeModalFn() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
  function dismiss() {
    card.classList.remove('lsw-visible');
    sessionStorage.setItem(DISMISSED_KEY, '1');
  }

  document.getElementById('lsw-open').addEventListener('click', openModal);
  document.getElementById('lsw-dismiss').addEventListener('click', dismiss);
  closeModal.addEventListener('click', closeModalFn);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModalFn(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModalFn(); });

  // Slide in after short delay
  setTimeout(function () { card.classList.add('lsw-visible'); }, 1800);
})();
