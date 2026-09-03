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

const MAX_UPLOAD_MB = 25;
const ALLOWED_EXTENSIONS = ["mp4","mov","mkv","webm","avi","m4v","mp3","wav","m4a","aac","ogg","flac"];

function hasAllowedExtension(filename){
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

document.addEventListener("DOMContentLoaded", () => {
  const uploadTrigger = document.getElementById("uploadTrigger");
  const videoFile = document.getElementById("videoFile");
  if(!uploadTrigger || !videoFile) return;
  uploadTrigger.addEventListener("click", () => videoFile.click());
  videoFile.addEventListener("change", function(){
    if(!this.files.length) return;
    const file = this.files[0];
    const isMedia = file.type.startsWith("video/") || file.type.startsWith("audio/") ||
      (file.type === "" && hasAllowedExtension(file.name));
    if(!isMedia){ alert("Please select a video or audio file."); this.value = ""; return; }
    if(file.size > MAX_UPLOAD_MB * 1024 * 1024){
      alert("File is too large. Please upload something under " + MAX_UPLOAD_MB + "MB.");
      this.value = ""; return;
    }
    transcribeFile(file);
  });
});

async function transcribeVideo(){
  const url = document.getElementById("videoUrl").value.trim();
  if(!url){ alert("Please paste a URL first!"); return; }
  const previewBox = document.getElementById("previewBox");
  const previewText = document.getElementById("previewText");
  previewBox.style.display = "block";
  previewText.innerText = "Generating transcript...";
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("dashboardSection").style.display = "none";
  try {
    const res = await fetch("/transcribe-url", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ url }) });
    const data = await res.json();
    handleResult(data);
  } catch(e){ previewText.innerText = "Server error. Please try again."; }
}

async function transcribeFile(file){
  const previewBox = document.getElementById("previewBox");
  const previewText = document.getElementById("previewText");
  previewBox.style.display = "block";
  previewText.innerText = "Uploading and processing...";
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("dashboardSection").style.display = "none";
  const fd = new FormData();
  fd.append("video", file);
  try {
    const res = await fetch("/transcribe", { method: "POST", body: fd });
    const data = await res.json();
    handleResult(data);
  } catch(e){ previewText.innerText = "Server error. Please try again."; }
}

function handleResult(data){
  const previewText = document.getElementById("previewText");
  if(data.loginRequired){
    previewText.innerText = data.error;
    document.getElementById("loginSection").style.display = "block";
  } else if(data.success){
    localStorage.setItem("latestTranscript", data.transcript);
    if(data.isGuest){
      const words = data.transcript.split(" ");
      previewText.innerText = words.slice(0,60).join(" ") + (words.length>60?"...":"");
      document.getElementById("loginSection").style.display = "block";
    } else {
      previewText.innerText = data.transcript.substring(0,120) + "...";
      document.getElementById("dashboardSection").style.display = "block";
    }
  } else {
    previewText.innerText = data.error || "Something went wrong";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const sticky = document.getElementById("stickyCta");
  const heroInput = document.querySelector(".hero-input-wrap");
  if(!sticky || !heroInput) return;
  const io = new IntersectionObserver((entries) => entries.forEach(entry => sticky.classList.toggle("show", !entry.isIntersecting)), { threshold: 0 });
  io.observe(heroInput);
});
