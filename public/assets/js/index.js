/* ── AUTH ─────────────────────────────────────────────────────────── */
let userEmail = localStorage.getItem("userEmail") || "";
let isLoggedIn = false;

async function resolveIdentity(){
  const params = new URLSearchParams(window.location.search);
  const gEmail = params.get("email");
  if(gEmail) localStorage.setItem("userEmail", gEmail);

  try {
    const me = await fetch("/me").then(r => r.json());
    isLoggedIn = !!me.loggedIn;
    userEmail = me.email || "";
    if(userEmail) localStorage.setItem("userEmail", userEmail);
    else localStorage.removeItem("userEmail");
  } catch(e) {
    isLoggedIn = false;
  }

  if(isLoggedIn){
    document.getElementById("menuDashTranscript").style.display = "block";
    document.getElementById("menuDashClips").style.display = "block";
    document.getElementById("menuLoginBtn").style.display = "none";
    document.getElementById("menuLogoutBtn").style.display = "block";
  }
}

async function logout(){
  try { await fetch("/logout", { method: "POST" }); } catch(e) {}
  localStorage.removeItem("userEmail");
  localStorage.removeItem("latestTranscript");
  window.location.href = "/";
}

resolveIdentity();

function openMenu(){ document.getElementById('menuOverlay').style.display = 'block'; }
function closeMenu(){ document.getElementById('menuOverlay').style.display = 'none'; }

document.getElementById('menuOverlay').addEventListener('click', function(e){
  if(e.target === this) closeMenu();
});
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape') closeMenu();
});

function googleLogin(){ window.location.href = "/auth/google"; }

/* FAQ accordion */
function toggleFaq(btn){
  const item = btn.closest('.faq-item');
  const wasOpen = item.classList.contains('open');
  item.closest('.faq-list').querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
  if(!wasOpen) item.classList.add('open');
}

/* Count-up animation for stat numbers when they scroll into view */
function animateCounters(){
  const cells = document.querySelectorAll('.stat-num');
  const seen = new WeakSet();
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(!entry.isIntersecting || seen.has(entry.target)) return;
      seen.add(entry.target);
      const el = entry.target;
      const raw = el.textContent.trim();
      const match = raw.match(/^([\d.]+)(.*)$/);
      if(!match) return;
      const end = parseFloat(match[1]);
      const suffix = match[2];
      const isDecimal = match[1].includes(".");
      let start = 0;
      const duration = 700;
      const startTime = performance.now();
      function tick(now){
        const progress = Math.min((now - startTime) / duration, 1);
        const val = start + (end - start) * progress;
        el.textContent = (isDecimal ? val.toFixed(1) : Math.round(val)) + suffix;
        if(progress < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }, { threshold: 0.4 });
  cells.forEach(el => io.observe(el));
}
document.addEventListener("DOMContentLoaded", animateCounters);

document.addEventListener("DOMContentLoaded", () => {
  const sticky = document.getElementById("stickyCta");
  const heroInput = document.querySelector(".hero-input-wrap");
  if(!sticky || !heroInput) return;
  const io = new IntersectionObserver((entries) => entries.forEach(entry => sticky.classList.toggle("show", !entry.isIntersecting)), { threshold: 0 });
  io.observe(heroInput);
});

function generateClips(){
  const url = document.getElementById("clipUrl").value.trim();
  if(!url){ alert("Please paste a YouTube URL!"); return; }

  if(!isLoggedIn){
    document.getElementById('clipLoginWall').style.display = 'block';
    document.getElementById('clipLoginWall').scrollIntoView({behavior:'smooth', block:'center'});
    return;
  }

  window.location.href = "/clips-dashboard.html?ytUrl=" + encodeURIComponent(url) + "&autostart=1";
}
