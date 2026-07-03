/*!
 * Lucid ROI — Smile Simulator Floating CTA Widget
 * Drop one <script> tag on any page. Zero dependencies.
 * Config via window.LucidCTA before the script loads, or use data-* attrs.
 *
 * Usage:
 *   <script src="https://app.lucidroi.com/cta-widget.js"
 *     data-sim-url="https://app.lucidroi.com/smile-simulator.html"
 *     data-heading="Ready for a New Smile?"
 *     data-sub="Get a Quick Smile Makeover Preview to See What&apos;s Possible."
 *     data-avatar-url=""
 *     data-delay="3000"
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
  var cfg = {
    simUrl:    script.getAttribute('data-sim-url')    || ext.simUrl    || 'https://app.lucidroi.com/smile-simulator.html',
    heading:   script.getAttribute('data-heading')    || ext.heading   || 'Ready for a New Smile?',
    sub:       script.getAttribute('data-sub')        || ext.sub       || 'Get a Quick Smile Makeover Preview to See What’s Possible.',
    avatarUrl: script.getAttribute('data-avatar-url') || ext.avatarUrl || 'https://app.lucidroi.com/smile-avatar.png',
    delay:     parseInt(script.getAttribute('data-delay') || ext.delay || '3000', 10),
    theme:     script.getAttribute('data-theme')      || ext.theme     || 'hallmark',
    openMode:  script.getAttribute('data-open')       || ext.openMode  || 'tab', // 'tab' | 'modal'
    tenant:    script.getAttribute('data-tenant')     || ext.tenant    || '',
    practice:  script.getAttribute('data-practice')   || ext.practice  || '',
    leadEmail: script.getAttribute('data-lead-email') || ext.leadEmail || '',
  };

  // Thread tenant/practice/leadEmail into the simulator URL so leads route to
  // the right practice and the simulator loads that practice's white-label
  // config. Params already present in data-sim-url are preserved.
  (function () {
    try {
      var u = new URL(cfg.simUrl, location.href);
      if (cfg.tenant    && !u.searchParams.get('tenant'))    u.searchParams.set('tenant', cfg.tenant);
      if (cfg.practice  && !u.searchParams.get('practice'))  u.searchParams.set('practice', cfg.practice);
      if (cfg.leadEmail && !u.searchParams.get('leadEmail')) u.searchParams.set('leadEmail', cfg.leadEmail);
      cfg.simUrl = u.toString();
    } catch (e) { /* leave simUrl as-is on parse failure */ }
  })();

  // ── Themes ───────────────────────────────────────────────────────────────
  var THEMES = {
    hallmark: {
      bg:         '#003057',
      bgGrad:     'linear-gradient(135deg,#003057 0%,#004a82 100%)',
      highlight:  '#D9C087',
      text:       '#ffffff',
      sub:        'rgba(255,255,255,0.82)',
      avatarBg:   'linear-gradient(135deg,#BA935A,#D9C087)',
      closeFg:    'rgba(255,255,255,0.65)',
      shadow:     '0 8px 40px rgba(0,48,87,0.45)',
      border:     'rgba(217,192,135,0.25)',
    },
    lucid: {
      bg:         '#0a1628',
      bgGrad:     'linear-gradient(135deg,#0a1628 0%,#162444 100%)',
      highlight:  '#6B8FFF',
      text:       '#EEF2FF',
      sub:        'rgba(195,215,250,0.82)',
      avatarBg:   'linear-gradient(135deg,#2D6FFF,#6B8FFF)',
      closeFg:    'rgba(255,255,255,0.55)',
      shadow:     '0 8px 40px rgba(10,22,40,0.55)',
      border:     'rgba(100,145,255,0.2)',
    },
  };
  var T = THEMES[cfg.theme] || THEMES.hallmark;

  // ── Session persistence ──────────────────────────────────────────────────
  var SK = 'lucid_cta_dismissed';
  if (sessionStorage.getItem(SK)) return; // dismissed this session — don't show

  // ── Avatar SVG (smiling face) ─────────────────────────────────────────────
  var AVATAR_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
    '<circle cx="32" cy="32" r="32" fill="url(#ag)"/>',
    '<defs><linearGradient id="ag" x1="0" y1="0" x2="1" y2="1">',
    '<stop offset="0%" stop-color="#BA935A"/>',
    '<stop offset="100%" stop-color="#D9C087"/>',
    '</linearGradient></defs>',
    // face
    '<circle cx="32" cy="28" r="14" fill="rgba(255,255,255,0.18)"/>',
    // eyes
    '<circle cx="27" cy="25" r="2" fill="#fff"/>',
    '<circle cx="37" cy="25" r="2" fill="#fff"/>',
    // smile arc
    '<path d="M24 32 Q32 40 40 32" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>',
    // teeth hint
    '<path d="M26 32 Q32 37 38 32" fill="rgba(255,255,255,0.4)"/>',
    '</svg>'
  ].join('');

  // ── Styles ────────────────────────────────────────────────────────────────
  var CSS = [
    '#lucid-cta-wrap{',
    '  position:fixed;bottom:24px;right:24px;z-index:99999;',
    '  display:flex;align-items:center;',
    '  max-width:340px;width:calc(100vw - 48px);',
    '  background:' + T.bgGrad + ';',
    '  border:1px solid ' + T.border + ';',
    '  border-radius:18px;',
    '  box-shadow:' + T.shadow + ';',
    '  padding:18px 20px 18px 24px;',
    '  gap:14px;',
    '  cursor:pointer;',
    '  text-decoration:none;',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    '  animation:lucid-cta-in 0.45s cubic-bezier(0.34,1.56,0.64,1) both;',
    '  transform-origin:bottom right;',
    '}',
    '#lucid-cta-wrap:hover{filter:brightness(1.08);}',
    '@keyframes lucid-cta-in{',
    '  from{opacity:0;transform:scale(0.7) translateY(20px);}',
    '  to{opacity:1;transform:scale(1) translateY(0);}',
    '}',
    '@keyframes lucid-cta-out{',
    '  from{opacity:1;transform:scale(1) translateY(0);}',
    '  to{opacity:0;transform:scale(0.7) translateY(20px);}',
    '}',
    '#lucid-cta-avatar{',
    '  flex-shrink:0;',
    '  width:58px;height:58px;',
    '  border-radius:50%;',
    '  overflow:hidden;',
    '  border:2.5px solid rgba(255,255,255,0.3);',
    '  background:' + T.avatarBg + ';',
    '  display:flex;align-items:center;justify-content:center;',
    '}',
    '#lucid-cta-avatar img{width:100%;height:100%;object-fit:cover;display:block;}',
    '#lucid-cta-body{flex:1;min-width:0;}',
    '#lucid-cta-heading{',
    '  font-size:15px;font-weight:700;line-height:1.3;',
    '  color:' + T.text + ';margin-bottom:4px;',
    '}',
    '#lucid-cta-heading .hl{color:' + T.highlight + ';}',
    '#lucid-cta-sub{',
    '  font-size:12.5px;line-height:1.45;',
    '  color:' + T.sub + ';',
    '}',
    '#lucid-cta-close{',
    '  position:absolute;top:8px;right:10px;',
    '  background:none;border:none;cursor:pointer;',
    '  color:' + T.closeFg + ';',
    '  font-size:18px;line-height:1;padding:2px 4px;',
    '  font-family:inherit;',
    '}',
    '#lucid-cta-close:hover{color:' + T.text + ';}',
    // Modal overlay
    '#lucid-cta-modal{',
    '  position:fixed;inset:0;z-index:100000;',
    '  background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);',
    '  display:flex;align-items:center;justify-content:center;padding:16px;',
    '}',
    '#lucid-cta-modal-inner{',
    '  position:relative;width:100%;max-width:560px;',
    '  background:#fff;border-radius:20px;overflow:hidden;',
    '  box-shadow:0 24px 80px rgba(0,0,0,0.4);',
    '}',
    '#lucid-cta-modal iframe{',
    '  width:100%;height:88vh;max-height:700px;border:none;display:block;',
    '}',
    '#lucid-cta-modal-close{',
    '  position:absolute;top:10px;right:12px;z-index:1;',
    '  background:rgba(0,0,0,0.5);border:none;border-radius:50%;',
    '  width:30px;height:30px;cursor:pointer;color:#fff;font-size:16px;',
    '  display:flex;align-items:center;justify-content:center;',
    '}',
    '@media(max-width:420px){',
    '  #lucid-cta-wrap{bottom:16px;right:12px;left:12px;width:auto;max-width:none;}',
    '}',
  ].join('\n');

  // ── Build heading HTML (highlights first word) ───────────────────────────
  function buildHeading(text) {
    var parts = text.split(' ');
    parts[0] = '<span class="hl">' + parts[0] + '</span>';
    return parts.join(' ');
  }

  // ── Inject ────────────────────────────────────────────────────────────────
  function inject() {
    // style
    var style = document.createElement('style');
    style.id = 'lucid-cta-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    // avatar content
    var avatarContent = cfg.avatarUrl
      ? '<img src="' + cfg.avatarUrl + '" alt="Smile preview" loading="lazy">'
      : AVATAR_SVG;

    // bubble
    var wrap = document.createElement('div');
    wrap.id = 'lucid-cta-wrap';
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('aria-label', cfg.heading);
    wrap.innerHTML = [
      '<button id="lucid-cta-close" aria-label="Close" title="Dismiss">&#x2715;</button>',
      '<div id="lucid-cta-avatar">' + avatarContent + '</div>',
      '<div id="lucid-cta-body">',
      '  <div id="lucid-cta-heading">' + buildHeading(cfg.heading) + '</div>',
      '  <div id="lucid-cta-sub">' + cfg.sub + '</div>',
      '</div>',
    ].join('');
    document.body.appendChild(wrap);

    // close
    document.getElementById('lucid-cta-close').addEventListener('click', function (e) {
      e.stopPropagation();
      dismiss();
    });

    // click → open
    wrap.addEventListener('click', function () { openSim(); });
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') openSim();
    });
  }

  function dismiss() {
    var wrap = document.getElementById('lucid-cta-wrap');
    if (!wrap) return;
    wrap.style.animation = 'lucid-cta-out 0.25s ease forwards';
    setTimeout(function () { wrap.remove(); }, 260);
    sessionStorage.setItem(SK, '1');
  }

  function openSim() {
    if (cfg.openMode === 'modal') {
      openModal();
    } else {
      window.open(cfg.simUrl, '_blank', 'noopener');
    }
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

    document.getElementById('lucid-cta-modal-close').addEventListener('click', function () {
      modal.remove();
    });
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.remove();
    });
  }

  // ── Wait for DOM, then delay ──────────────────────────────────────────────
  function init() {
    setTimeout(inject, cfg.delay);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
