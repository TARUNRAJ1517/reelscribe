/* ══════════════ SECURITY HELPER ══════════════
   Any text that ultimately comes from user/AI-generated data
   (video titles, clip titles, AI reasons, file keys) must be
   escaped before it's placed into innerHTML. YouTube titles are
   attacker-controllable, so this is not optional. */
function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ══════════════ AUTH / IDENTITY ══════════════
   Identity comes from the server session (/me), not localStorage.
   localStorage is kept only to show the email instantly on load —
   it carries no authentication weight. */
let email = localStorage.getItem("userEmail") || "";
let isGuest = true;
let userEmail = "";
let currentPlan = "free";
let currentReferralCuts = 0;

async function resolveIdentity() {
  try {
    const res = await fetch("/me");
    const data = await res.json();
    isGuest = !data.loggedIn;
    email = data.email || "";
    userEmail = email;
    if (email) localStorage.setItem("userEmail", email);
    else localStorage.removeItem("userEmail");
  } catch (e) { isGuest = !email; userEmail = email; }

  const nameStr = isGuest ? "Guest" : email.split("@")[0];
  const avatarStr = nameStr.charAt(0).toUpperCase();
  document.getElementById("welcomeName").innerText = isGuest ? "Guest — Cut Clips" : nameStr;
  document.getElementById("drawerName").innerText = nameStr;
  document.getElementById("drawerEmail").innerText = isGuest ? "Not logged in" : email;
  document.getElementById("drawerAvatar").innerText = avatarStr;
}

function openDrawer(){ document.getElementById("drawer").classList.add("active"); document.getElementById("drawerOverlay").classList.add("active"); }
function closeDrawer(){ document.getElementById("drawer").classList.remove("active"); document.getElementById("drawerOverlay").classList.remove("active"); }
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeDrawer(); });

async function logout(){
  try { await fetch("/logout", { method: "POST" }); } catch (e) {}
  localStorage.removeItem("userEmail");
  window.location.href = "/";
}

/* Source, Captions and Generate are always visible — including to
   guests and Free-plan users — so people can explore the product
   (paste a link, play with caption styles) before ever signing up.
   The login/upgrade wall only appears when they actually try to
   generate, as a nudge at the point of value, not a locked door
   up front.

   Referral credits are a special case: a Free-plan user who has
   earned an unused referral clip can generate WITHOUT upgrading —
   that's the whole point of the reward. Once that credit is spent
   (currentReferralCuts drops to 0) they fall back to the normal
   Free-plan wall until they earn another one or upgrade. */
function applyAccessState(){
  const genHint = document.getElementById("genHint");
  const refBanner = document.getElementById("refCreditBanner");
  const refCount = document.getElementById("refCreditCount");
  const refPlural = document.getElementById("refCreditPlural");

  const hasReferralCredit = !isGuest && currentReferralCuts > 0;

  // Referral banner on the dashboard — only visible when there's an
  // unused credit sitting there, so it never distracts a user with 0.
  if (hasReferralCredit) {
    refBanner.style.display = "flex";
    refCount.innerText = currentReferralCuts;
    refPlural.innerText = currentReferralCuts === 1 ? "" : "s";
  } else {
    refBanner.style.display = "none";
  }

  if (isGuest) {
    genHint.classList.remove("ref");
    genHint.innerText = "sign up free to generate";
  } else if (currentPlan === "free") {
    if (hasReferralCredit) {
      genHint.classList.add("ref");
      genHint.innerText = `${currentReferralCuts} free referral clip${currentReferralCuts === 1 ? '' : 's'} available — generate now`;
    } else {
      genHint.classList.remove("ref");
      genHint.innerText = "upgrade to generate";
    }
  } else {
    genHint.classList.remove("ref");
    genHint.innerText = "2–5 min per video";
  }
}

function showAccessWall(){
  const loginWall = document.getElementById("loginWall");
  const loginWallText = document.getElementById("loginWallText");
  const loginWallBtn = document.getElementById("loginWallBtn");
  const wallLabel = document.getElementById("wallLabel");

  if (isGuest) {
    loginWallText.innerText = "Like what you see? Create a free account to generate this clip.";
    loginWallBtn.innerText = "Sign Up Free →";
    loginWallBtn.onclick = () => window.location.href = "/login.html?next=" + encodeURIComponent(location.pathname);
  } else {
    loginWallText.innerText = "Cut Clips generation isn't available on the Free plan. Upgrade to unlock it, or invite a friend to earn a free clip.";
    loginWallBtn.innerText = "Upgrade Plan →";
    loginWallBtn.onclick = () => window.location.href = "/pricing.html";
  }
  wallLabel.style.display = "flex";
  loginWall.style.display = "block";
  loginWall.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function loadUserPlan(){
  if (isGuest) { applyAccessState(); return; }
  try {
    const res = await fetch("/user-plan");
    const data = await res.json();
    if (data.success && data.plan) {
      currentPlan = data.plan;
      currentReferralCuts = data.referralCuts || 0;
      const planLabel = data.plan.charAt(0).toUpperCase() + data.plan.slice(1);
      document.getElementById("statPlan").innerText = planLabel;

      const drawerPlanEl = document.getElementById("drawerPlan");
      const drawerChip = document.getElementById("drawerUpgradeChip");
      drawerPlanEl.innerText = planLabel;

      const badge = document.getElementById("navPlanBadge");
      badge.innerText = planLabel;

      if (data.plan !== "free") {
        badge.classList.add("paid");
        drawerPlanEl.classList.remove("is-free");
        drawerChip.style.display = "none";
      } else {
        drawerPlanEl.classList.add("is-free");
        drawerChip.style.display = "inline-block";
        document.getElementById("upgradeLabel").style.display = "flex";
        document.getElementById("upgradeBanner").style.display = "block";
      }
      if (data.usage) {
        const left = Math.max(0, (data.usage.clipDayLimit || 0) - (data.usage.clipDay || 0));
        const leftStr = data.usage.clipDayLimit ? String(left) : "—";
        document.getElementById("statClipsLeft").innerText = leftStr;
        document.getElementById("meterClipsLeft").innerText = data.usage.clipDayLimit ? `${left} / ${data.usage.clipDayLimit}` : "—";
      }
    }
  } catch (e) {
    document.getElementById("upgradeLabel").style.display = "flex";
    document.getElementById("upgradeBanner").style.display = "block";
  }
  applyAccessState();
}

/* ══════════════ LOG / HISTORY ══════════════ */
let clipHistoryOpen = false;
let clipHistoryLoaded = false;

function toggleClipHistory(){
  clipHistoryOpen = !clipHistoryOpen;
  const list = document.getElementById('clipHistoryList');
  const btn = document.getElementById('histToggle');
  list.style.display = clipHistoryOpen ? 'block' : 'none';
  btn.classList.toggle('open', clipHistoryOpen);
  btn.querySelector('.btn-label').innerText = clipHistoryOpen ? 'Hide' : 'Show';
  if (clipHistoryOpen && !clipHistoryLoaded) { loadClipHistory(); clipHistoryLoaded = true; }
}

/* Delegated download-click handler for history items — avoids
   building inline onclick="" strings out of server data (s3Key),
   which is unsafe if that string ever contains a quote character. */
document.getElementById('clipHistoryList').addEventListener('click', (e) => {
  const link = e.target.closest('a[data-s3key]');
  if (!link) return;
  e.stopPropagation();
  notifyDownload(link.dataset.s3key);
});

async function loadClipHistory(){
  const list = document.getElementById('clipHistoryList');
  const sub = document.getElementById('statClipsHistorySub');
  if (isGuest) {
    list.innerHTML = '<div class="log-empty">Log in to see your clip history.</div>';
    document.getElementById("statClipsHistory").innerText = "0";
    if (sub) sub.innerText = "Log in to see your history";
    return;
  }
  try {
    const res = await fetch(`/clip-history`);
    const data = await res.json();
    if (!data.success || !data.data || data.data.length === 0) {
      list.innerHTML = '<div class="log-empty">No clip history yet.</div>';
      document.getElementById("statClipsHistory").innerText = "0";
      if (sub) sub.innerText = "No videos yet";
      return;
    }
    document.getElementById("statClipsHistory").innerText = data.data.length;
    if (sub) sub.innerText = `${data.data.length} video${data.data.length === 1 ? '' : 's'} in the last 24h`;
    list.innerHTML = '';
    data.data.forEach((job, jobIdx) => {
      const date = new Date(job.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      const title = job.ytTitle || job.ytUrl;
      const item = document.createElement('div');
      item.className = 'log-item';
      item.innerHTML = `
        <div class="log-item-row">
          <span class="log-tc mono">${escapeHtml(date)}</span>
          <span class="log-name">${escapeHtml(title)}</span>
          <span class="log-src">${escapeHtml(String(job.clips.length))} clips</span>
        </div>
        <div class="log-sub" id="historyClips${jobIdx}">
          ${job.clips.map((clip, i) => `
            <div class="log-sub-item">
              <span>${escapeHtml(clip.title || 'Clip ' + (i+1))} · ${escapeHtml(String(clip.duration))}s</span>
              <a href="${escapeHtml(clip.url)}" download="clip_${i+1}.mp4" data-s3key="${escapeHtml(clip.s3Key || '')}">Download</a>
            </div>
          `).join('')}
        </div>`;
      item.addEventListener('click', () => {
        const sub = document.getElementById(`historyClips${jobIdx}`);
        sub.style.display = sub.style.display === 'block' ? 'none' : 'block';
      });
      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = '<div class="log-empty">Could not load your history.</div>';
  }
}

async function notifyDownload(s3Key){
  try { await fetch('/clip-downloaded', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ s3Key }) }); } catch (e) {}
}

/* ══════════════ CAPTION PICKER ══════════════ */
const CP_STYLES = [
  { name: "Podcast Pro",     cls: "style-podcast",  html: '<b>THIS</b> <i>IS</i> <strong>THE</strong> STYLE', tag: "PRO" },
  { name: "Kinetic Mix",     cls: "style-kinetic",  html: '<b>THIS</b> <span>IS</span> <em>FIRE</em>', tag: "TRENDING" },
  { name: "Bold Highlight",  cls: "style-highlight", text: "THIS IS IMPORTANT", tag: "POPULAR" },
  { name: "Editorial Clean", cls: "style-editorial", html: 'this <b>is</b> clean' },
  { name: "Neon Punch",      cls: "style-neon",     html: '<b>THIS</b> <span>STANDS OUT</span>', tag: "PRO" },
  { name: "Mono Focus",      cls: "style-mono",     html: '<b>THIS</b> IS THE POINT' },
  { name: "Classic Bold",    cls: "style-classic",  text: "CLASSIC BOLD", tag: "POPULAR" },
  { name: "Minimal Pro",     cls: "style-minimal",  text: "clean editorial" },
  { name: "Bold Pop",        cls: "style-red",      text: "BOLD" },
  { name: "Gradient",        cls: "style-gradient", text: "FIRE" },
  { name: "Karaoke",         cls: "style-karaoke",  html: '<span class="filled">KAR</span>A' },
  { name: "Outline",         cls: "style-outline",  text: "EDGE" },
  { name: "Boxed",           cls: "style-boxed",    text: "BOX" },
  { name: "Highlight",       cls: "style-highlight", text: "POP" },
  { name: "Minimal",         cls: "style-minimal",  text: "CLEAN" },
  { name: "Cyan Glow",       cls: "style-cyan",     text: "GLOW" },
  { name: "Gold Shine",      cls: "style-gold",     text: "GOLD" },
  { name: "Word Pop Mono",   cls: "style-mono",     text: "MONO" },
  { name: "White Clean",     cls: "style-white",    text: "PLAIN" },
  { name: "Rainbow Pop",     cls: "style-rainbow",  html: '<b>SO</b> <b>I\'M</b> <b>AWARE</b> <b>OF</b>', tag: "NEW" },
];
let cpStyleIdx = 0;

const CP_ANIMS = [
  { name: "Static",     id: "static" },
  { name: "Word Pop",   id: "wordpop",  tag: "Trending" },
  { name: "Karaoke",    id: "karaoke",  tag: "Trending" },
  { name: "Bounce",     id: "bounce",   tag: "Popular" },
  { name: "Shake",      id: "shake" },
  { name: "Typewriter", id: "typewriter", tag: "Trending" },
  { name: "Slide Up",   id: "slideup" },
  { name: "Scale In",   id: "scalein",  tag: "Popular" },
  { name: "Glow Pulse", id: "glowpulse" },
];
let cpAnimIdx = 1;

const CP_RATIOS = [
  { name: "9:16 Reels", cls: "style-white", text: "9:16", tag: "Popular" },
  { name: "1:1 Square", cls: "style-white", text: "1:1" },
  { name: "16:9 Wide",  cls: "style-white", text: "16:9" },
  { name: "4:5 Feed",   cls: "style-white", text: "4:5" },
];
let cpRatioIdx = 0;

const CP_QUALITY = [
  { name: "720p",  cls: "style-white", text: "720p" },
  { name: "1080p", cls: "style-white", text: "1080p", tag: "Trending" },
  { name: "4K",    cls: "style-white", text: "4K" },
];
let cpQualityIdx = 1;

const CP_MODE_DESC = {
  wordpop: "One word highlights at a time as it's spoken.",
  karaoke: "Words fill in colour in sync with the audio.",
  standard: "Chunk-by-chunk traditional captions.",
};
let cpCaptionMode = "standard";
let cpMaxWords = 4;
let cpEmojiOn = true;
let cpEmojiSubpos = "end";
const CP_REACTION_EMOJIS = ["🔥", "😱", "🧠", "🤑", "⚠️", "🏆", "❤️", "😂"];

let cpPosType = "bottom";
let cpMarginFromBottom = 430;

const CP_LANG_DESC = {
  hindi: "Captions in Hindi (Devanagari).",
  english: "Captions translated to English.",
  hinglish: "Captions in Hinglish (Roman script, mixed Hindi-English).",
};
let cpLanguage = "hindi";

function cpRenderStyleGrid(){
  const grid = document.getElementById("cpStyleGrid");
  grid.innerHTML = CP_STYLES.map((s, i) => `
    <div class="cp-tile ${i === cpStyleIdx ? 'selected' : ''}" data-i="${i}">
      ${s.tag ? `<div class="cp-tile-tag">${s.tag}</div>` : ''}
      <div class="cp-swatch ${s.cls}"><span>${s.html || s.text}</span></div>
      <div class="cp-tile-label">${s.name}</div>
    </div>`).join('');
  grid.querySelectorAll(".cp-tile").forEach(t => t.addEventListener("click", () => {
    cpStyleIdx = parseInt(t.dataset.i); cpRenderStyleGrid(); cpRenderLive(); cpUpdateSummary();
  }));
}

function cpRenderAnimGrid(){
  const grid = document.getElementById("cpAnimGrid");
  grid.innerHTML = CP_ANIMS.map((a, i) => `
    <div class="cp-tile ${i === cpAnimIdx ? 'selected' : ''}" data-i="${i}">
      ${a.tag ? `<div class="cp-tile-tag">${a.tag}</div>` : ''}
      <div class="cp-swatch style-white"><span style="font-size:8px">${a.name.toUpperCase()}</span></div>
      <div class="cp-tile-label">${a.name}</div>
    </div>`).join('');
  grid.querySelectorAll(".cp-tile").forEach(t => t.addEventListener("click", () => {
    cpAnimIdx = parseInt(t.dataset.i); cpRenderAnimGrid(); cpRenderLive(); cpUpdateSummary();
  }));
}

function cpRenderSimpleGrid(containerId, items, selectedIdx, onSelect){
  const grid = document.getElementById(containerId);
  grid.innerHTML = items.map((it, i) => `
    <div class="cp-tile ${i === selectedIdx ? 'selected' : ''}" data-i="${i}">
      ${it.tag ? `<div class="cp-tile-tag">${it.tag}</div>` : ''}
      <div class="cp-swatch ${it.cls}"><span>${it.text}</span></div>
      <div class="cp-tile-label">${it.name}</div>
    </div>`).join('');
  grid.querySelectorAll(".cp-tile").forEach(t => t.addEventListener("click", () => onSelect(parseInt(t.dataset.i))));
}
function cpRenderRatioGrid(){ cpRenderSimpleGrid("cpRatioGrid", CP_RATIOS, cpRatioIdx, (i) => { cpRatioIdx = i; cpRenderRatioGrid(); cpUpdateSummary(); }); }
function cpRenderQualityGrid(){ cpRenderSimpleGrid("cpQualityGrid", CP_QUALITY, cpQualityIdx, (i) => { cpQualityIdx = i; cpRenderQualityGrid(); cpUpdateSummary(); }); }

document.getElementById("cpTabbar").addEventListener("click", (e) => {
  const tab = e.target.closest(".cp-tab");
  if (!tab) return;
  document.querySelectorAll(".cp-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".cp-panel").forEach(p => p.classList.remove("active"));
  tab.classList.add("active");
  document.getElementById(`cp-panel-${tab.dataset.tab}`).classList.add("active");
});

document.getElementById("cpModeButtons").addEventListener("click", (e) => {
  const btn = e.target.closest(".opt-btn");
  if (!btn) return;
  cpCaptionMode = btn.dataset.mode;
  document.querySelectorAll("#cpModeButtons .opt-btn").forEach(b => b.classList.toggle("selected", b === btn));
  document.getElementById("cpModeDesc").innerText = CP_MODE_DESC[cpCaptionMode];
  cpRenderLive(); cpUpdateSummary();
});

document.getElementById("cpWordsRow").addEventListener("click", (e) => {
  const btn = e.target.closest(".opt-btn");
  if (!btn) return;
  cpMaxWords = parseInt(btn.dataset.n);
  document.querySelectorAll("#cpWordsRow .opt-btn").forEach(b => b.classList.toggle("selected", b === btn));
  cpRenderLive(); cpUpdateSummary();
});

const cpEmojiToggle = document.getElementById("cpEmojiToggle");
cpEmojiToggle.addEventListener("change", () => {
  cpEmojiOn = cpEmojiToggle.checked;
  document.querySelectorAll("#cpSubposButtons .opt-btn").forEach(b => b.disabled = !cpEmojiOn);
  cpRenderLive(); cpUpdateSummary();
});

document.getElementById("cpSubposButtons").addEventListener("click", (e) => {
  const btn = e.target.closest(".opt-btn");
  if (!btn || !cpEmojiOn) return;
  cpEmojiSubpos = btn.dataset.subpos;
  document.querySelectorAll("#cpSubposButtons .opt-btn").forEach(b => b.classList.toggle("selected", b === btn));
  cpRenderLive(); cpUpdateSummary();
});

document.getElementById("cpLangButtons").addEventListener("click", (e) => {
  const btn = e.target.closest(".opt-btn");
  if (!btn) return;
  cpLanguage = btn.dataset.lang;
  document.querySelectorAll("#cpLangButtons .opt-btn").forEach(b => b.classList.toggle("selected", b === btn));
  document.getElementById("cpLangDesc").innerText = CP_LANG_DESC[cpLanguage];
  cpUpdateSummary();
});

function cpRenderPosButtons(){
  document.querySelectorAll("#cpPosButtons .opt-btn").forEach(b => b.classList.toggle("selected", b.dataset.pos === cpPosType));
  document.getElementById("cpCustomControls").style.display = cpPosType === "custom" ? "block" : "none";
}
document.getElementById("cpPosButtons").addEventListener("click", (e) => {
  const btn = e.target.closest(".opt-btn");
  if (!btn) return;
  cpPosType = btn.dataset.pos;
  cpRenderPosButtons(); cpApplyPosition(); cpUpdateSummary();
});

const cpMarginSlider = document.getElementById("cpMarginSlider");
const cpMarginValueLabel = document.getElementById("cpMarginValue");
function cpUpdateSliderFill(){ const pct = (cpMarginSlider.value / cpMarginSlider.max) * 100; cpMarginSlider.style.setProperty('--fill', pct + '%'); }
cpMarginSlider.addEventListener("input", () => {
  cpMarginFromBottom = parseInt(cpMarginSlider.value);
  cpMarginValueLabel.innerText = `${cpMarginFromBottom}px`;
  cpUpdateSliderFill(); cpApplyPosition(); cpUpdateSummary();
});

function cpApplyPosition(){
  const el = document.getElementById("cpWords");
  el.style.top = "auto"; el.style.bottom = "auto"; el.style.transform = "none";
  if (cpPosType === "top") { el.style.top = "8%"; }
  else if (cpPosType === "center") { el.style.top = "50%"; el.style.transform = "translateY(-50%)"; }
  else if (cpPosType === "bottom") { el.style.bottom = "8%"; }
  else if (cpPosType === "custom") {
    const pct = Math.min(Math.max(cpMarginFromBottom / 960, 0), 1) * 82;
    el.style.bottom = pct + "%";
  }
}

const CP_DEMO_WORDS = ["THIS", "IS", "HOW", "IT", "LOOKS"];
let cpLiveTimer = null;

function cpRenderLive(){
  clearInterval(cpLiveTimer);
  const wrap = document.getElementById("cpWords");
  const style = CP_STYLES[cpStyleIdx];
  const anim = CP_ANIMS[cpAnimIdx];
  let words = CP_DEMO_WORDS.slice(0, Math.max(1, Math.min(cpMaxWords, CP_DEMO_WORDS.length)));
  if (cpEmojiOn && cpEmojiSubpos !== "none") {
    const emoji = CP_REACTION_EMOJIS[cpStyleIdx % CP_REACTION_EMOJIS.length];
    words = cpEmojiSubpos === "start" ? [emoji, ...words] : [...words, emoji];
  }
  wrap.innerHTML = words.map((w, i) => `<span class="cp-word ${style.cls}" data-i="${i}"><span>${w}</span></span>`).join('');
  cpApplyAnimation(anim.id, wrap);
  cpApplyPosition();
}

function cpApplyAnimation(id, wrap){
  const words = [...wrap.children];
  if (id === "static") { words.forEach(w => w.style.opacity = "1"); return; }

  if (id === "wordpop" || id === "karaoke") {
    let active = 0;
    const tick = () => {
      words.forEach((w, i) => {
        const isActive = i === active;
        w.style.transition = "transform .15s, opacity .15s";
        w.style.opacity = (id === "karaoke") ? "1" : (isActive ? "1" : "0.35");
        w.style.transform = isActive ? "scale(1.12)" : "scale(1)";
        if (id === "karaoke") w.querySelector("span").style.color = i <= active ? "#fff" : "rgba(255,255,255,0.3)";
      });
      active = (active + 1) % words.length;
    };
    tick(); cpLiveTimer = setInterval(tick, 420); return;
  }

  if (id === "typewriter") {
    words.forEach(w => w.style.opacity = "0");
    let shown = 0;
    const tick = () => { words.forEach((w, i) => { w.style.opacity = i < shown ? "1" : "0"; }); shown = shown >= words.length ? 0 : shown + 1; };
    tick(); cpLiveTimer = setInterval(tick, 380); return;
  }

  if (id === "bounce") { words.forEach((w, i) => { w.style.opacity = "1"; w.style.animation = `cpBounce 1.1s ease-in-out ${i * 0.1}s infinite`; }); return; }
  if (id === "shake") { words.forEach((w, i) => { w.style.opacity = "1"; w.style.animation = `cpShake 0.32s ease-in-out ${i * 0.05}s infinite`; }); return; }

  if (id === "slideup") {
    let idx = 0;
    words.forEach(w => { w.style.opacity = "0"; w.style.transform = "translateY(10px)"; w.style.transition = "transform .25s, opacity .25s"; });
    cpLiveTimer = setInterval(() => {
      words.forEach(w => { w.style.opacity = "0"; w.style.transform = "translateY(10px)"; });
      words[idx].style.opacity = "1"; words[idx].style.transform = "translateY(0)";
      idx = (idx + 1) % words.length;
    }, 450); return;
  }

  if (id === "scalein") {
    let idx = 0;
    words.forEach(w => { w.style.opacity = "0.3"; w.style.transform = "scale(0.85)"; w.style.transition = "transform .2s, opacity .2s"; });
    cpLiveTimer = setInterval(() => {
      words.forEach(w => { w.style.opacity = "0.3"; w.style.transform = "scale(0.85)"; });
      words[idx].style.opacity = "1"; words[idx].style.transform = "scale(1.15)";
      idx = (idx + 1) % words.length;
    }, 420); return;
  }

  if (id === "glowpulse") { words.forEach((w, i) => { w.style.opacity = "1"; w.style.animation = `cpGlow 1.4s ease-in-out ${i * 0.15}s infinite`; }); return; }
}

let cpCaptionsOn = true;

function cpGetSettings(){
  if (!cpCaptionsOn) return { captionsEnabled: false };
  return {
    captionsEnabled: true,
    style: CP_STYLES[cpStyleIdx].name,
    language: cpLanguage,
    animation: CP_ANIMS[cpAnimIdx].name,
    captionMode: cpCaptionMode,
    maxWordsPerLine: cpMaxWords,
    emojiReactions: cpEmojiOn,
    emojiPosition: cpEmojiOn ? cpEmojiSubpos : "none",
    position: cpPosType === "custom" ? { type: "custom", marginFromBottom: cpMarginFromBottom } : { type: cpPosType },
    aspectRatio: CP_RATIOS[cpRatioIdx].text,
    quality: CP_QUALITY[cpQualityIdx].text,
  };
}

function cpUpdateSummary(){
  const s = cpGetSettings();
  document.getElementById("cpSummary").innerHTML = s.captionsEnabled === false
    ? `Applying to next clip: <strong>No captions</strong>`
    : `Applying to next clip: <strong>${s.style}</strong> · <strong>${s.language[0].toUpperCase()}${s.language.slice(1)}</strong> · <strong>${s.animation}</strong> · <strong>${s.aspectRatio}</strong> · <strong>${s.quality}</strong>`;
}

document.getElementById("cpCaptionsToggle").addEventListener("change", (e) => {
  cpCaptionsOn = e.target.checked;
  document.getElementById("cpBody").classList.toggle("disabled", !cpCaptionsOn);
  cpUpdateSummary();
});

function cpInit(){
  cpRenderStyleGrid(); cpRenderAnimGrid(); cpRenderRatioGrid(); cpRenderQualityGrid();
  cpRenderPosButtons(); cpUpdateSliderFill(); cpRenderLive(); cpUpdateSummary();
}
cpInit();

/* ══════════════ VIDEO PREVIEW ══════════════
   Uses YouTube's public oEmbed endpoint (no API key, CORS-enabled)
   to show a thumbnail/title/channel before the user commits to
   generating — catches wrong links early instead of after a
   2-5 minute wait. Text is inserted via innerText, never innerHTML,
   so no escaping gap even though the title comes from YouTube. */
const YT_URL_REGEX = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/;
let vpDebounceTimer = null;

function clearVideoPreview(){
  document.getElementById('videoPreviewCard').style.display = 'none';
}

async function fetchVideoPreview(url){
  const card = document.getElementById('videoPreviewCard');
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (!res.ok) throw new Error('lookup failed');
    const data = await res.json();
    document.getElementById('vpThumb').src = data.thumbnail_url || '';
    document.getElementById('vpTitle').innerText = data.title || 'Untitled video';
    document.getElementById('vpChannel').innerText = data.author_name ? `by ${data.author_name}` : '';
    card.style.display = 'flex';
  } catch (e) {
    clearVideoPreview();
  }
}

document.getElementById('clipUrl').addEventListener('input', (e) => {
  clearTimeout(vpDebounceTimer);
  const val = e.target.value.trim();
  if (!YT_URL_REGEX.test(val)) { clearVideoPreview(); return; }
  vpDebounceTimer = setTimeout(() => fetchVideoPreview(val), 500);
});

/* ══════════════ DOWNLOAD ALL ══════════════
   Browsers commonly block more than one or two simultaneous
   programmatic downloads, so clips are triggered one at a time
   with a short stagger. This is a reasonable default without
   pulling in a zip library / fetching cross-origin blobs. */
let lastGeneratedClips = [];

async function downloadAllClips(){
  if (!lastGeneratedClips.length) return;
  const btn = document.getElementById('downloadAllBtn');
  btn.disabled = true;
  btn.innerText = 'Downloading…';
  for (let i = 0; i < lastGeneratedClips.length; i++) {
    const clip = lastGeneratedClips[i];
    try {
      const res = await fetch(clip.url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `clip_${i + 1}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      notifyDownload(clip.s3Key);
    } catch (e) { console.error('Download failed for clip', i, e); }
    await new Promise(r => setTimeout(r, 400));
  }
  btn.disabled = false;
  btn.innerText = 'Download All';
}


/* ══════════════ GENERATE / PROCESS / RESULTS ══════════════ */
let procTimer = null;

function startProcAnimation(){
  const fill = document.getElementById('scrubFill');
  const tc = document.getElementById('procTc');
  const steps = ['step1','step2','step3','step4'];
  let t = 0, stepIdx = 0;
  clearInterval(procTimer);
  procTimer = setInterval(() => {
    t += 0.35 + Math.random() * 0.4;
    const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * 30);
    tc.textContent = String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0') + ':' + String(f).padStart(2,'0') + ':' + String(f % 30).padStart(2,'0');
    fill.style.width = Math.min(96, (t / 45) * 100) + '%';
    const newIdx = Math.min(3, Math.floor(t / 12));
    if (newIdx !== stepIdx) {
      document.getElementById(steps[stepIdx]).classList.remove('active');
      document.getElementById(steps[stepIdx]).classList.add('done');
      stepIdx = newIdx;
      document.getElementById(steps[stepIdx]).classList.add('active');
    }
  }, 300);
}
function stopProcAnimation(finish){
  clearInterval(procTimer);
  if (finish) {
    document.getElementById('scrubFill').style.width = '100%';
    ['step1','step2','step3','step4'].forEach(id => { document.getElementById(id).classList.remove('active'); document.getElementById(id).classList.add('done'); });
  }
}

async function generateClips(){
  const url = document.getElementById("clipUrl").value.trim();
  if (!url) { alert("Please paste a YouTube URL!"); return; }
  // Free plan can proceed ONLY if they still have an unused referral
  // credit — this is what lets a referral reward be used without
  // requiring an upgrade. Once the credit is spent, this falls back
  // to the normal wall (handled by loadUserPlan() re-syncing
  // currentReferralCuts after generation finishes).
  if (isGuest || (currentPlan === "free" && currentReferralCuts <= 0)) { showAccessWall(); return; }

  const usingReferralCredit = (currentPlan === "free" && currentReferralCuts > 0);

  const genBtn = document.getElementById("genBtn");
  const procLabel = document.getElementById("procLabel");
  const procCard = document.getElementById("procCard");
  const outLabel = document.getElementById("outLabel");
  const resultsSection = document.getElementById("resultsSection");
  const sheetScroll = document.getElementById("sheetScroll");

  genBtn.disabled = true;
  outLabel.style.display = "none";
  resultsSection.style.display = "none";
  sheetScroll.innerHTML = "";
  document.getElementById('downloadAllBtn').style.display = "none";
  document.getElementById('procStatus').innerText = "RENDERING";
  document.getElementById('procTitle').innerText = "Analyzing source video";
  document.getElementById('procSub').innerText = usingReferralCredit
    ? "Using your referral credit. Usually takes 2–5 minutes. Keep this tab open."
    : "Usually takes 2–5 minutes. Keep this tab open.";
  ['step1','step2','step3','step4'].forEach((id,i) => { const el = document.getElementById(id); el.classList.remove('done','active'); if(i===0) el.classList.add('active'); });
  document.getElementById('scrubFill').style.width = '0%';
  procLabel.style.display = "flex";
  procCard.style.display = "block";
  startProcAnimation();
  procCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

  function refreshHistoryAfterJob(){ clipHistoryLoaded = false; if (clipHistoryOpen) { loadClipHistory(); clipHistoryLoaded = true; } }

  function showError(msg){
    stopProcAnimation(false);
    document.getElementById('procStatus').innerText = "ERROR";
    document.getElementById('procTitle').innerText = "Something went wrong";
    document.getElementById('procTitle').classList.add('proc-error');
    document.getElementById('procSub').innerText = msg || "Please try again.";
    genBtn.disabled = false;
    refreshHistoryAfterJob();
    // Re-sync plan/referral state in case the error was e.g. "referral
    // cut already used" — keeps the UI (banner, hint, wall) honest.
    loadUserPlan();
  }

  function showClips(clips){
    stopProcAnimation(true);
    lastGeneratedClips = clips || [];
    setTimeout(() => {
      procLabel.style.display = "none";
      procCard.style.display = "none";
      document.getElementById('procTitle').classList.remove('proc-error');
      outLabel.style.display = "flex";
      document.getElementById('outName').innerText = `${clips.length} clip${clips.length === 1 ? '' : 's'} generated`;
      const downloadAllBtn = document.getElementById('downloadAllBtn');
      downloadAllBtn.style.display = clips.length > 1 ? 'block' : 'none';
      downloadAllBtn.disabled = false;
      downloadAllBtn.innerText = 'Download All';
      if (!clips.length) {
        sheetScroll.innerHTML = '<div class="sheet-empty">No clips came back — try a different video.</div>';
      } else {
        // All dynamic fields (title, reason, s3Key, url) are escaped
        // before insertion — YouTube titles are attacker-controllable
        // text and must never be trusted with raw innerHTML.
        sheetScroll.innerHTML = clips.map((clip, i) => `
          <div class="frame-card">
            <div class="frame-thumb">
              <div class="frame-idx">${String(i+1).padStart(2,'0')}</div>
              <div class="frame-dur">${escapeHtml(String(clip.duration))}s</div>
              <div class="play"></div>
            </div>
            <div class="frame-body">
              <div class="frame-title">${escapeHtml(clip.title || 'Clip ' + (i+1))}</div>
              ${clip.reason ? `<div class="frame-reason">${escapeHtml(clip.reason)}</div>` : ''}
              <a href="${escapeHtml(clip.url)}" download="clip_${i+1}.mp4" class="frame-dl" data-s3key="${escapeHtml(clip.s3Key || '')}">Download</a>
            </div>
          </div>`).join('');
        sheetScroll.querySelectorAll('.frame-dl').forEach(a => {
          a.addEventListener('click', () => notifyDownload(a.dataset.s3key));
        });
      }
      resultsSection.style.display = "block";
      genBtn.disabled = false;
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 400);
    refreshHistoryAfterJob();
    // The referral credit (if one was used) has now been consumed
    // server-side. Re-pull /user-plan so currentReferralCuts drops
    // to its real value immediately — this is what stops the user
    // from generating again on the referral credit alone once it's
    // spent, without needing a page refresh.
    loadUserPlan();
  }

  try {
    const res = await fetch("/cut-clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ytUrl: url, captionSettings: cpGetSettings() })
    });
    const data = await res.json();

    if (data.loginRequired) { showAccessWall(); procLabel.style.display = "none"; procCard.style.display = "none"; genBtn.disabled = false; return; }
    if (!data.success || !data.jobId) { showError(data.error); return; }

    const jobId = data.jobId;
    const startTime = Date.now();
    const maxWaitMs = 30 * 60 * 1000;

    const poll = setInterval(async () => {
      if (Date.now() - startTime > maxWaitMs) { clearInterval(poll); showError("Timed out. Please try again."); return; }
      try {
        const statusRes = await fetch(`/clip-status/${jobId}`);
        const statusData = await statusRes.json();
        if (!statusData.success) { clearInterval(poll); showError(statusData.error); return; }
        if (statusData.status === "done") { clearInterval(poll); showClips(statusData.clips || []); }
        else if (statusData.status === "error") { clearInterval(poll); showError(statusData.error); }
      } catch (e) { /* transient — retry next tick */ }
    }, 4000);

  } catch (e) {
    showError("Server error. Please try again.");
  }
}

/* Init — if we arrived here from the main page with a link already
   pasted (Generate button on "/"), prefill it and kick off processing
   automatically as soon as access checks pass. */
(async () => {
  const params = new URLSearchParams(window.location.search);
  const incomingUrl = params.get("ytUrl");
  const autostart = params.get("autostart") === "1";

  if (incomingUrl) {
    document.getElementById("clipUrl").value = incomingUrl;
    if (YT_URL_REGEX.test(incomingUrl)) fetchVideoPreview(incomingUrl);
  }

  await resolveIdentity();
  await loadUserPlan();

  // Preload the history count silently (list itself stays hidden via
  // CSS until the user hits "Show") so the "Videos (24h)" stat is
  // correct on first paint instead of showing "—" indefinitely.
  if (!isGuest) { loadClipHistory(); clipHistoryLoaded = true; }

  if (incomingUrl || autostart) window.history.replaceState({}, document.title, "/clips-dashboard.html");
  if (incomingUrl && autostart && !isGuest && currentPlan !== "free") generateClips();
})();
