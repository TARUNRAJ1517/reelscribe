/* ReelScribe premium motion layer — presentation only, safe to remove without affecting app logic. */
(function(){
  'use strict';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!reduce){
    const selectors = ['.frame-label','.stat-strip','.feat-card','.step','.plan','.plan-card','.free-card','.mockup-box','.blog-card','.faq-item','.channel','.slate','.spec','.clause','.form-box','.panel','.qa-card','.log-card','.cp-panel','.cp-block','.card','.caption-card'];
    const nodes = [];
    selectors.forEach(s=>document.querySelectorAll(s).forEach(el=>{ if(!nodes.includes(el)){el.classList.add('rs-reveal');nodes.push(el)} }));
    const io = new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('rs-visible');io.unobserve(e.target)}}),{threshold:.08,rootMargin:'0px 0px -35px'});
    nodes.forEach((el,i)=>{el.style.transitionDelay=Math.min((i%5)*45,180)+'ms';io.observe(el)});

    // Subtle cursor parallax on desktop — no layout changes.
    if(window.matchMedia('(pointer:fine)').matches){
      const hero=document.querySelector('.hero');
      if(hero){
        let raf=0;
        hero.addEventListener('pointermove',e=>{
          const r=hero.getBoundingClientRect(), x=(e.clientX-r.left)/r.width-.5, y=(e.clientY-r.top)/r.height-.5;
          cancelAnimationFrame(raf); raf=requestAnimationFrame(()=>{
            hero.style.setProperty('--mx',(x*10).toFixed(2)+'px');
            hero.style.setProperty('--my',(y*8).toFixed(2)+'px');
          });
        });
        hero.addEventListener('pointerleave',()=>{hero.style.setProperty('--mx','0px');hero.style.setProperty('--my','0px')});
        hero.style.transform='translate3d(var(--mx,0),var(--my,0),0)';
        hero.style.transition='transform .45s cubic-bezier(.2,.8,.2,1)';
      }
    }
  }

  // Add a small live status beacon to premium navs without changing existing controls.
  document.querySelectorAll('.nav-logo').forEach(logo=>{
    if(logo.querySelector('.rs-live-beacon')) return;
    const b=document.createElement('span'); b.className='rs-live-beacon';
    b.setAttribute('aria-hidden','true');
    b.style.cssText='width:5px;height:5px;border-radius:50%;background:#66e8ff;box-shadow:0 0 12px #66e8ff;display:inline-block;margin-left:-3px;opacity:.8;animation:rsBeacon 2s ease-in-out infinite';
    logo.appendChild(b);
  });
  if(!document.getElementById('rs-premium-keyframes')){
    const s=document.createElement('style');s.id='rs-premium-keyframes';s.textContent='@keyframes rsBeacon{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}';document.head.appendChild(s);
  }
})();

/* ══════════════ AUTOPAY CANCELLATION NOTICE ══════════════
   This is intentionally global and persistent. Once a user cancels AutoPay,
   the server keeps autopayCancelledNotice=true until they successfully start
   a new paid subscription. Every authenticated user page shows the notice.
*/
(function(){
  'use strict';
  const path = window.location.pathname || '';
  if (path === '/admin.html' || path === '/login.html') return;

  function injectStyles(){
    if (document.getElementById('rs-autopay-notice-css')) return;
    const style = document.createElement('style');
    style.id = 'rs-autopay-notice-css';
    style.textContent = `
      .rs-autopay-persistent{position:fixed;left:18px;right:18px;top:14px;z-index:10050;display:none;align-items:center;gap:12px;padding:12px 15px;border:1px solid rgba(220,38,38,.28);border-radius:14px;background:#fff7f7;color:#7f1d1d;box-shadow:0 12px 35px rgba(15,23,42,.12);font:600 13px/1.45 Inter,system-ui,sans-serif}
      .rs-autopay-persistent strong{font-weight:800}.rs-autopay-persistent a{margin-left:auto;color:#b91c1c;font-weight:800;text-decoration:none;white-space:nowrap}
      .rs-autopay-persistent .rs-dot{width:9px;height:9px;border-radius:50%;background:#dc2626;flex:none}
      .rs-autopay-modal-backdrop{position:fixed;inset:0;z-index:10060;display:none;place-items:center;padding:20px;background:rgba(15,23,42,.48);backdrop-filter:blur(5px)}
      .rs-autopay-modal{width:min(460px,100%);padding:25px;border-radius:20px;background:#fff;box-shadow:0 25px 80px rgba(15,23,42,.28);font:400 14px/1.55 Inter,system-ui,sans-serif;color:#334155}
      .rs-autopay-modal h3{margin:0 0 8px;font-size:20px;color:#0f172a}.rs-autopay-modal p{margin:0 0 18px}.rs-autopay-modal .rs-modal-actions{display:flex;gap:10px;justify-content:flex-end}.rs-autopay-modal button,.rs-autopay-modal a{border:0;border-radius:10px;padding:10px 14px;font:700 13px Inter,system-ui,sans-serif;cursor:pointer;text-decoration:none}.rs-autopay-modal button{background:#e2e8f0;color:#0f172a}.rs-autopay-modal a{background:#111827;color:#fff}
      @media(max-width:640px){.rs-autopay-persistent{top:8px;left:8px;right:8px;align-items:flex-start}.rs-autopay-persistent a{margin-left:0}.rs-autopay-modal .rs-modal-actions{flex-direction:column}.rs-autopay-modal a,.rs-autopay-modal button{text-align:center;width:100%}}
    `;
    document.head.appendChild(style);
  }

  function showNotice(data){
    injectStyles();
    if (!document.getElementById('rs-autopay-persistent')) {
      const bar = document.createElement('div');
      bar.id = 'rs-autopay-persistent';
      bar.className = 'rs-autopay-persistent';
      bar.innerHTML = '<span class="rs-dot" aria-hidden="true"></span><span><strong>AutoPay cancelled.</strong> Your account has been switched to the Free plan. You will not be charged again.</span><a href="/pricing.html">Reactivate plan →</a>';
      document.body.appendChild(bar);
    }
    document.getElementById('rs-autopay-persistent').style.display = 'flex';

    const backdrop = document.createElement('div');
    backdrop.className = 'rs-autopay-modal-backdrop';
    backdrop.innerHTML = '<div class="rs-autopay-modal" role="dialog" aria-modal="true" aria-labelledby="rs-autopay-title"><h3 id="rs-autopay-title">AutoPay cancelled</h3><p>Your AutoPay subscription was cancelled, so your paid plan has been switched to the Free plan immediately. You will not be charged again unless you start a new subscription.</p><div class="rs-modal-actions"><button type="button" id="rs-autopay-close">Got it</button><a href="/pricing.html">View plans</a></div></div>';
    document.body.appendChild(backdrop);
    backdrop.style.display = 'grid';
    document.getElementById('rs-autopay-close').onclick = () => backdrop.remove();
    backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
  }

  async function check(){
    try{
      const res = await fetch('/user-plan', { credentials:'include', cache:'no-store' });
      if(!res.ok) return;
      const data = await res.json();
      if(data.success && data.autopayCancelledNotice) showNotice(data);
    }catch(e){}
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check, { once:true });
  else check();
})();
