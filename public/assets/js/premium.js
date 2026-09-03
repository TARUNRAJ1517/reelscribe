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
