/* ══════════════ SECURITY HELPER ══════════════
   Escape any text that comes from user/server data before it's
   placed into innerHTML (transcript previews, URLs, etc). */
function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

const params = new URLSearchParams(window.location.search);
const googleEmail = params.get("email");
if (googleEmail) localStorage.setItem("userEmail", googleEmail);

/* ══════════════ AUTH / IDENTITY ══════════════
   Identity comes from the server session (/me), not localStorage.
   localStorage is kept only to show the email instantly on load —
   it carries no authentication weight. */
let email = localStorage.getItem("userEmail") || "";
let isGuest = true;

async function resolveIdentity() {
  try {
    const res = await fetch("/me");
    const data = await res.json();
    isGuest = !data.loggedIn;
    email = data.email || "";
    if (email) localStorage.setItem("userEmail", email);
    else localStorage.removeItem("userEmail");
  } catch (e) { isGuest = !email; }

  const nameStr = isGuest ? "Guest" : email.split("@")[0];
  const avatarStr = nameStr.charAt(0).toUpperCase();
  document.getElementById("welcomeName").innerText = isGuest ? "Guest — Dashboard" : nameStr;
  document.getElementById("drawerName").innerText = nameStr;
  document.getElementById("drawerEmail").innerText = isGuest ? "Not logged in" : email;
  document.getElementById("drawerAvatar").innerText = avatarStr;
}

function openDrawer(){ document.getElementById("drawer").classList.add("active"); document.getElementById("drawerOverlay").classList.add("active"); }
function closeDrawer(){ document.getElementById("drawer").classList.remove("active"); document.getElementById("drawerOverlay").classList.remove("active"); }
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeDrawer(); });

let historyOpen = false;
let historyLoaded = false;

async function loadUserPlan() {
  if (isGuest) {
    document.getElementById("statCredits").innerText = "3";
    document.getElementById("statPlan").innerText = "Free";
    document.getElementById("drawerPlan").innerText = "Free";
    document.getElementById("upgradeLabel").style.display = "flex";
    document.getElementById("upgradeBanner").style.display = "block";
    return;
  }
  try {
    const res = await fetch("/user-plan");
    const data = await res.json();
    if (data.success && data.plan) {
      const plan = data.plan.charAt(0).toUpperCase() + data.plan.slice(1);
      document.getElementById("statPlan").innerText = plan;
      document.getElementById("drawerPlan").innerText = plan;
      const left = Math.max(0, (data.usage.transcriptDayLimit || 0) - (data.usage.transcriptDay || 0));
      document.getElementById("statCredits").innerText = left;
      const badge = document.getElementById("navPlanBadge");
      badge.innerText = plan;
      if (data.plan !== "free") {
        badge.classList.add("paid");
      } else {
        document.getElementById("upgradeLabel").style.display = "flex";
        document.getElementById("upgradeBanner").style.display = "block";
      }
    }
  } catch (e) {
    document.getElementById("upgradeLabel").style.display = "flex";
    document.getElementById("upgradeBanner").style.display = "block";
  }
}

async function loadLatestTranscript() {
  const body = document.getElementById("transcriptBody");
  const actions = document.getElementById("transcriptActions");
  const badge = document.getElementById("transcriptBadge");
  const previewBanner = document.getElementById("previewBanner");

  if (isGuest) {
    const guestT = localStorage.getItem("latestTranscript");
    const isPreview = localStorage.getItem("isPreview") === "true";
    if (guestT) {
      body.innerText = guestT;
      actions.style.display = "flex";
      badge.innerText = isPreview ? "Preview" : "Latest";
      badge.classList.toggle("latest", !isPreview);
      if (isPreview) {
        previewBanner.innerHTML = `
          <div class="preview-banner">
            <p>This is a 100-word preview. Log in for the full transcript.</p>
            <button class="preview-login-btn" onclick="window.location.href='/login.html'">Log In — It's Free</button>
          </div>`;
      }
    } else {
      body.innerHTML = '<div class="tc-empty">No transcript yet. Create one to get started.</div>';
      badge.innerText = "Empty";
    }
    return;
  }

  try {
    const res = await fetch("/history");
    const data = await res.json();
    if (data.success && data.data && data.data.length > 0) {
      const latest = data.data[0];
      body.innerText = latest.transcript;
      actions.style.display = "flex";
      badge.innerText = "Latest";
      badge.classList.add("latest");
      document.getElementById("statHistory").innerText = data.data.length;
      localStorage.setItem("latestTranscript", latest.transcript);
    } else {
      body.innerHTML = '<div class="tc-empty">No transcript yet. Create one to get started.</div>';
      badge.innerText = "Empty";
      document.getElementById("statHistory").innerText = "0";
    }
  } catch (e) {
    body.innerHTML = '<div class="tc-empty">Could not load your transcript.</div>';
    badge.innerText = "Error";
  }
}

async function loadHistory() {
  const list = document.getElementById("historyList");
  if (isGuest) {
    list.innerHTML = '<div class="log-empty">Log in to see your transcript history.</div>';
    return;
  }
  try {
    const res = await fetch("/history");
    const data = await res.json();
    if (data.success && data.data && data.data.length > 0) {
      list.innerHTML = "";
      data.data.forEach(item => {
        const date = new Date(item.createdAt).toLocaleDateString("en-IN", {
          day: "numeric", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit"
        });
        const source = item.reelUrl?.includes("youtube") ? "YouTube" :
                       item.reelUrl?.includes("instagram") ? "Instagram" : "File";
        const div = document.createElement("div");
        div.className = "log-item";
        div.innerHTML = `
          <div class="log-item-top">
            <div class="log-item-date mono">${escapeHtml(date)}</div>
            <div class="log-item-source">${escapeHtml(source)}</div>
          </div>
          <div class="log-item-preview">${escapeHtml(item.transcript.substring(0, 90))}...</div>
          <div class="log-item-url">${escapeHtml((item.reelUrl || "File upload").substring(0, 50))}</div>
        `;
        div.addEventListener("click", () => {
          document.getElementById("transcriptBody").innerText = item.transcript;
          document.getElementById("transcriptActions").style.display = "flex";
          localStorage.setItem("latestTranscript", item.transcript);
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
        list.appendChild(div);
      });
    } else {
      list.innerHTML = '<div class="log-empty">No history yet.</div>';
    }
  } catch (e) {
    list.innerHTML = '<div class="log-empty">Could not load history.</div>';
  }
}

function toggleHistory() {
  historyOpen = !historyOpen;
  const list = document.getElementById("historyList");
  const btn = document.getElementById("historyToggle");
  list.style.display = historyOpen ? "block" : "none";
  btn.classList.toggle("open", historyOpen);
  btn.querySelector(".btn-label").innerText = historyOpen ? "Hide" : "Show";
  if (historyOpen && !historyLoaded) {
    loadHistory();
    historyLoaded = true;
  }
}

function copyTranscript() {
  const text = document.getElementById("transcriptBody").innerText;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector(".btn-copy");
    const original = btn.innerHTML;
    btn.innerText = "Copied";
    setTimeout(() => { btn.innerHTML = original; }, 2000);
  }).catch(() => { alert("Copy failed — please select and copy the text manually."); });
}

function newTranscript() {
  localStorage.removeItem("latestTranscript");
  window.location.href = "/";
}

async function logout() {
  try { await fetch("/logout", { method: "POST" }); } catch (e) {}
  localStorage.removeItem("userEmail");
  localStorage.removeItem("latestTranscript");
  window.location.href = "/";
}

// Init
(async () => {
  await resolveIdentity();
  loadUserPlan();
  loadLatestTranscript();
})();
