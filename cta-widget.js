/*!
 * Lucid ROI — Smile Simulator Floating CTA Widget
 * Drop one <script> tag on any page. Zero dependencies.
 * Config via window.LucidCTA before the script loads, or use data-* attrs.
 *
 * Usage:
 *   <script src="https://app.lucidroi.com/cta-widget.js"
 *     data-sim-url="https://app.lucidroi.com/smile-simulator.html"
 *     data-heading="Want to See Your Future Smile? (FREE)"
 *     data-cta-label="Get Started"
 *     data-hero-url="https://app.lucidroi.com/smile-hero.jpg"
 *     data-booking-url="https://practice.com/book"
 *     data-side-tab="Schedule Your Consultation Today!"
 *     data-delay="3000"
 *     data-open="modal"
 *     data-theme="hallmark">
 *   </script>
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────
  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var ext = window.LucidCTA || {};
  function opt(attr, key, def) {
    var v = script.getAttribute(attr);
    if (v === null || v === '') v = (key in ext) ? ext[key] : undefined;
    return (v === undefined || v === null) ? def : v;
  }
  var cfg = {
    simUrl:     opt('data-sim-url',     'simUrl',     'https://app.lucidroi.com/smile-simulator.html'),
    heading:    opt('data-heading',     'heading',    'Want to See Your Future Smile? (FREE)'),
    sub:        opt('data-sub',         'sub',        ''),
    ctaLabel:   opt('data-cta-label',   'ctaLabel',   'Get Started'),
    heroUrl:    opt('data-hero-url',    'heroUrl',    'https://app.lucidroi.com/smile-hero.jpg'),
    heroVideo:  opt('data-hero-video',  'heroVideo',  'https://app.lucidroi.com/smile-hero.mp4'),
    bookingUrl: opt('data-booking-url', 'bookingUrl', ''),
    sideTab:    opt('data-side-tab',    'sideTab',    'Schedule Your Consultation Today!'),
    delay:      parseInt(opt('data-delay', 'delay', '3000'), 10),
    theme:      opt('data-theme',       'theme',      'hallmark'),
    openMode:   opt('data-open',        'openMode',   'modal'), // 'modal' | 'tab'
    tenant:     opt('data-tenant',      'tenant',     ''),
    practice:   opt('data-practice',    'practice',   ''),
    leadEmail:  opt('data-lead-email',  'leadEmail',  ''),
  };

  // Thread tenant/practice/leadEmail into the simulator URL so leads route to
  // the right practice and the simulator loads that practice's white-label config.
  (function () {
    try {
      var u = new URL(cfg.simUrl, location.href);
      if (cfg.tenant    && !u.searchParams.get('tenant'))    u.searchParams.set('tenant', cfg.tenant);
      if (cfg.practice  && !u.searchParams.get('practice'))  u.searchParams.set('practice', cfg.practice);
      if (cfg.leadEmail && !u.searchParams.get('leadEmail')) u.searchParams.set('leadEmail', cfg.leadEmail);
      cfg.simUrl = u.toString();
    } catch (e) { /* leave simUrl as-is */ }
  })();

  // ── Themes (per-practice; card stays white, accents follow the brand) ─────
  var THEMES = {
    hallmark: { accent: 'linear-gradient(135deg,#004a82 0%,#003057 100%)', accentSolid: '#003057', glow: 'rgba(217,192,135,0.55)', tab: 'linear-gradient(180deg,#004a82,#003057)' },
    lucid:    { accent: 'linear-gradient(135deg,#2D6FFF 0%,#6B8FFF 100%)', accentSolid: '#2D6FFF', glow: 'rgba(107,143,255,0.5)',  tab: 'linear-gradient(180deg,#2D6FFF,#1b4fd0)' },
  };
  var T = THEMES[cfg.theme] || THEMES.hallmark;

  // ── Session persistence ──────────────────────────────────────────────────
  var SK = 'lucid_cta_dismissed';
  if (sessionStorage.getItem(SK)) { mountSideTab(); return; } // card dismissed → keep the booking tab

  // ── Styles ────────────────────────────────────────────────────────────────
  var CSS = [
    '#lucid-cta-card{',
    '  position:fixed;bottom:22px;right:22px;z-index:99999;',
    '  width:225px;max-width:calc(100vw - 40px);',
    '  background:#fff;border-radius:16px;',
    '  box-shadow:0 12px 44px rgba(0,0,0,0.22), 0 0 0 3px ' + T.glow + ';',
    '  padding:11px;',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    '  animation:lucid-cta-in 0.5s cubic-bezier(0.34,1.56,0.64,1) both;',
    '  transform-origin:bottom right;',
    '}',
    '@keyframes lucid-cta-in{from{opacity:0;transform:scale(0.85) translateY(16px);}to{opacity:1;transform:scale(1) translateY(0);}}',
    '@keyframes lucid-cta-out{from{opacity:1;transform:scale(1);}to{opacity:0;transform:scale(0.85) translateY(16px);}}',
    '#lucid-cta-hero{',
    '  width:100%;height:112px;border-radius:10px;object-fit:cover;display:block;',
    '  background:#0c1622;cursor:pointer;',
    '}',
    '#lucid-cta-heading{',
    '  font-size:12.5px;font-weight:800;line-height:1.28;color:#16222f;',
    '  text-align:center;margin:9px 5px 2px;cursor:pointer;',
    '}',
    '#lucid-cta-sub{font-size:12.5px;line-height:1.4;color:#5b6b7a;text-align:center;margin:0 6px 4px;}',
    '#lucid-cta-btn{',
    '  display:block;width:100%;margin-top:11px;padding:12px 16px;',
    '  background:' + T.accent + ';color:#fff;font-weight:800;font-size:14.5px;',
    '  border:none;border-radius:12px;cursor:pointer;text-align:center;',
    '  font-family:inherit;letter-spacing:.2px;transition:filter .15s,transform .15s;',
    '}',
    '#lucid-cta-btn:hover{filter:brightness(1.08);transform:translateY(-1px);}',
    '#lucid-cta-close{',
    '  position:absolute;top:-9px;right:-9px;width:26px;height:26px;',
    '  background:#fff;border:1px solid #e4e9ef;border-radius:50%;cursor:pointer;',
    '  color:#8b98a6;font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center;',
    '  box-shadow:0 2px 8px rgba(0,0,0,0.15);font-family:inherit;',
    '}',
    '#lucid-cta-close:hover{color:#16222f;}',
    // Vertical side tab (booking CTA)
    '#lucid-side-tab{',
    '  position:fixed;top:34%;right:0;z-index:99998;',
    '  background:' + T.tab + ';color:#fff;',
    '  writing-mode:vertical-rl;transform:rotate(180deg);',
    '  padding:16px 9px;border-radius:0 0 12px 12px;',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    '  font-size:13.5px;font-weight:700;letter-spacing:.3px;cursor:pointer;',
    '  box-shadow:-4px 0 18px rgba(0,0,0,0.2);text-decoration:none;',
    '  transition:padding-right .15s;user-select:none;',
    '}',
    '#lucid-side-tab:hover{padding-right:13px;}',
    // Modal
    // Contained popup (bitebot-style) — a compact card anchored bottom-right where
    // the widget lives, NOT a full-screen takeover. Light backdrop; click to close.
    '#lucid-cta-modal{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.32);}',
    '#lucid-cta-modal-inner{position:fixed;bottom:12px;right:12px;width:410px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 24px);transition:height .2s ease;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,0.45);animation:lucid-cta-in 0.35s cubic-bezier(0.34,1.56,0.64,1) both;transform-origin:bottom right;}',
    '#lucid-cta-modal iframe{width:100%;height:100%;border:none;display:block;}',
    '@media(max-width:480px){#lucid-cta-modal-inner{top:auto;bottom:8px;left:8px;right:8px;width:auto;max-width:none;}}',
    '#lucid-cta-modal-close{position:absolute;top:10px;right:12px;z-index:1;background:rgba(0,0,0,0.5);border:none;border-radius:50%;width:30px;height:30px;cursor:pointer;color:#fff;font-size:16px;display:flex;align-items:center;justify-content:center;}',
    '@media(max-width:420px){#lucid-cta-card{right:12px;left:12px;width:auto;max-width:none;}#lucid-side-tab{font-size:12px;padding:13px 7px;}}',
  ].join('\n');

  var styleEl = null;
  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.id = 'lucid-cta-style';
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  // ── Vertical booking side tab (shown whenever there's a booking URL) ──────
  function mountSideTab() {
    if (!cfg.bookingUrl || document.getElementById('lucid-side-tab')) return;
    ensureStyle();
    var a = document.createElement('a');
    a.id = 'lucid-side-tab';
    a.href = cfg.bookingUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = cfg.sideTab;
    document.body.appendChild(a);
  }

  // ── Floating before/after card ────────────────────────────────────────────
  function inject() {
    ensureStyle();
    mountSideTab();

    var card = document.createElement('div');
    card.id = 'lucid-cta-card';
    card.innerHTML = [
      '<button id="lucid-cta-close" aria-label="Close" title="Dismiss">&#x2715;</button>',
      (cfg.heroVideo
        ? '<video id="lucid-cta-hero" src="' + cfg.heroVideo + '" poster="' + cfg.heroUrl + '" autoplay muted loop playsinline preload="metadata"></video>'
        : '<img id="lucid-cta-hero" src="' + cfg.heroUrl + '" alt="AI smile before and after" loading="lazy">'),
      '<div id="lucid-cta-heading">' + cfg.heading + '</div>',
      cfg.sub ? '<div id="lucid-cta-sub">' + cfg.sub + '</div>' : '',
    ].join('');
    card.style.cursor = 'pointer';
    document.body.appendChild(card);

    // No button — the whole card is clickable (opens the simulator).
    document.getElementById('lucid-cta-close').addEventListener('click', function (e) { e.stopPropagation(); dismiss(); });
    card.addEventListener('click', openSim);
  }

  function dismiss() {
    var card = document.getElementById('lucid-cta-card');
    if (!card) return;
    card.style.animation = 'lucid-cta-out 0.25s ease forwards';
    setTimeout(function () { card.remove(); }, 260);
    sessionStorage.setItem(SK, '1'); // side tab stays; only the card is dismissed
  }

  function openSim() {
    if (cfg.openMode === 'modal') openModal();
    else window.open(cfg.simUrl, '_blank', 'noopener');
  }

  function openModal() {
    var modal = document.createElement('div');
    modal.id = 'lucid-cta-modal';
    modal.innerHTML = [
      '<div id="lucid-cta-modal-inner">',
      '  <button id="lucid-cta-modal-close" aria-label="Close simulator">&#x2715;</button>',
      '  <iframe src="' + cfg.simUrl + '" title="AI Smile Simulator" allow="camera"></iframe>',
      '</div>',
    ].join('');
    document.body.appendChild(modal);
    var inner = document.getElementById('lucid-cta-modal-inner');

    // Auto-size the popup to the simulator's reported content height: opens just
    // tall enough for the upload dialog + legal + powered-by, and grows as the
    // patient advances (form, result). Clamped to the viewport.
    function onMsg(e) {
      var h = e && e.data && e.data.lucidSimHeight;
      if (typeof h === 'number' && h > 0 && inner) {
        // On phones leave ~90px at the top so the popup is a bottom-anchored card
        // (like bitebot) sized to content, not a full-screen takeover.
        var maxH = window.innerHeight - (window.innerWidth <= 480 ? 90 : 24);
        inner.style.height = Math.max(300, Math.min(h, maxH)) + 'px';
      }
    }
    window.addEventListener('message', onMsg);
    function close() { window.removeEventListener('message', onMsg); modal.remove(); }
    document.getElementById('lucid-cta-modal-close').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  }

  // ── Wait for DOM, then delay the card (side tab shows immediately) ─────────
  function init() {
    mountSideTab();
    setTimeout(inject, cfg.delay);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
