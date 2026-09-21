/* ReelScribe — shared site-wide motion layer.
   Adds scroll-reveal + subtle 3D tilt + a hero entrance to every page.
   Self-contained: injects its own CSS, touches no existing page script,
   and respects prefers-reduced-motion throughout. */
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  // Inject the small amount of CSS this script depends on.
  var style = document.createElement('style');
  style.textContent =
    '.rs-reveal{opacity:0;transform:translateY(18px);transition:opacity .6s ease,transform .6s ease;}' +
    '.rs-reveal.rs-in{opacity:1;transform:translateY(0);}' +
    '.rs-hero-in{animation:rs-fade-up .7s ease both;}' +
    '@keyframes rs-fade-up{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:translateY(0);}}' +
    '@media(prefers-reduced-motion:reduce){.rs-reveal{opacity:1!important;transform:none!important;transition:none!important;}' +
    '.rs-hero-in{animation:none!important;}}';
  document.head.appendChild(style);

  ready(function () {
    // ── Scroll reveal for repeating cards/sections across every page ──
    var revealSelectors = [
      '.step', '.plan-card', '.home-plan-card', '.testi-card', '.feat-card',
      '.faq-item', '.stat-cell', '.exec-card', '.stat-card', '.pricing-card',
      '.activity .row', '.billing-id-grid > div', '.compare-table',
      '.reel .card', '.node', '.hook', '.blog .card'
    ].join(',');
    var revealEls = document.querySelectorAll(revealSelectors);

    if (!reduce && 'IntersectionObserver' in window && revealEls.length) {
      revealEls.forEach(function (el, i) {
        el.classList.add('rs-reveal');
        el.style.transitionDelay = (i % 6) * 70 + 'ms';
      });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('rs-in');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12 });
      revealEls.forEach(function (el) { io.observe(el); });
    } else {
      revealEls.forEach(function (el) { el.classList.add('rs-reveal', 'rs-in'); });
    }

    // ── One-time hero entrance on load ──
    if (!reduce) {
      var heroBits = document.querySelectorAll(
        '.hero-h1, .hero-sub, .hero-input-wrap, .trust-pills, .login-h1, .auth-shell, .title, .lead'
      );
      heroBits.forEach(function (el, i) {
        el.classList.add('rs-hero-in');
        el.style.animationDelay = (i * 90) + 'ms';
      });
    }

    // ── Subtle pointer-based 3D tilt on card-like elements ──
    if (!reduce && window.matchMedia('(hover: hover)').matches) {
      var tiltEls = document.querySelectorAll(
        '.plan-card, .home-plan-card, .exec-card, .clip-thumb, .frame-thumb'
      );
      tiltEls.forEach(function (card) {
        var rect = null;
        card.style.transition = (card.style.transition ? card.style.transition + ',' : '') + 'transform .2s ease-out';
        card.style.willChange = 'transform';
        card.addEventListener('mouseenter', function () { rect = card.getBoundingClientRect(); });
        card.addEventListener('mousemove', function (e) {
          if (!rect) rect = card.getBoundingClientRect();
          var px = (e.clientX - rect.left) / rect.width;
          var py = (e.clientY - rect.top) / rect.height;
          var rx = (0.5 - py) * 5;
          var ry = (px - 0.5) * 5;
          card.style.transform = 'perspective(900px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
        });
        card.addEventListener('mouseleave', function () { rect = null; card.style.transform = ''; });
      });
    }
  });
})();
