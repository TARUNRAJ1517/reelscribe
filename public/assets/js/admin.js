/* ══════════════════════════════════════════════════════════
   TOASTS & CONFIRM MODAL
   ══════════════════════════════════════════════════════════ */
function toast(msg, type){
  const stack = document.getElementById("toastStack");
  const el = document.createElement("div");
  el.className = "toast " + (type || "");
  el.innerText = msg;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

let confirmCallback = null;
function askConfirm(title, text, onConfirm){
  document.getElementById("confirmTitle").innerText = title;
  document.getElementById("confirmText").innerText = text;
  confirmCallback = onConfirm;
  document.getElementById("confirmModal").classList.add("active");
}
function closeConfirm(){
  document.getElementById("confirmModal").classList.remove("active");
  confirmCallback = null;
}
document.getElementById("confirmActionBtn").onclick = () => {
  if (confirmCallback) confirmCallback();
  closeConfirm();
};
document.getElementById("confirmModal").addEventListener("click", (e) => {
  if (e.target.id === "confirmModal") closeConfirm();
});

/* ══════════════════════════════════════════════════════════
   AUTH — session-based; the key itself is only sent once at
   /admin/login. Every request after that rides the session cookie.
   ══════════════════════════════════════════════════════════ */
async function unlock(){
  const key = document.getElementById("adminKey").value.trim();
  if(!key){ showResult("loginResult", "Please enter the admin key first.", false); return; }

  try {
    const res = await fetch("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key })
    });
    const data = await res.json();
    if(data.success){
      document.getElementById("lockScreen").style.display = "none";
      document.getElementById("adminScreen").style.display = "block";
      document.getElementById("adminKey").value = "";
      initPanel();
    } else {
      showResult("loginResult", data.error || "Incorrect key — access denied.", false);
    }
  } catch(e){
    showResult("loginResult", "Server error. Please try again.", false);
  }
}

async function doLogout(){
  try { await fetch("/admin/logout", { method: "POST" }); } catch(e){}
  document.getElementById("adminScreen").style.display = "none";
  document.getElementById("lockScreen").style.display = "flex";
}

/* ══════════════════════════════════════════════════════════
   TABS
   ══════════════════════════════════════════════════════════ */
function switchTab(name){
  ["overview","users","payments","usage","marketing","actions","logs"].forEach(t => {
    document.getElementById("tab" + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle("active", t === name);
    document.getElementById("section-" + t).classList.toggle("active", t === name);
  });
  if (name === "users") {
    if (usersState.data.length === 0) loadUsers();
    loadReferralReview();
  }
  if (name === "payments" && paymentsState.data.length === 0) loadPayments();
  if (name === "usage") loadUsage();
  if (name === "marketing") { loadMarketing(); renderTemplateDropdown(); }
  if (name === "logs" && logsState.data.length === 0) loadLogs();
}

function initPanel(){
  loadStats();
  loadRevenue();
  loadUsers();
}

/* ══════════════════════════════════════════════════════════
   OVERVIEW / STATS
   ══════════════════════════════════════════════════════════ */
async function loadStats(){
  try {
    const res = await fetch("/admin/stats");
    const data = await res.json();
    if(!data.success) return;

    const cards = document.querySelectorAll("#statsGrid .stat-num");
    cards[0].innerText = data.totalUsers;
    cards[1].innerText = data.newToday;
    cards[2].innerText = data.newThisWeek;
    cards[3].innerText = (data.byPlan.starter||0) + (data.byPlan.pro||0) + (data.byPlan.agency||0);

    document.getElementById("planBreakdown").innerHTML = `
      <div class="plan-chip">Free: <b>${data.byPlan.free||0}</b></div>
      <div class="plan-chip">Starter: <b>${data.byPlan.starter||0}</b></div>
      <div class="plan-chip">Pro: <b>${data.byPlan.pro||0}</b></div>
      <div class="plan-chip">Agency: <b>${data.byPlan.agency||0}</b></div>
    `;
  } catch(e){ toast("Could not load stats.", "error"); }
}

async function loadRevenue(){
  try {
    const res = await fetch("/admin/revenue");
    const data = await res.json();
    if(!data.success) return;

    const fmt = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");
    const cards = document.querySelectorAll("#revenueGrid .stat-num");
    cards[0].innerText = fmt(data.totalRevenue);
    cards[1].innerText = fmt(data.monthRevenue);
    cards[2].innerText = fmt(data.todayRevenue);
    cards[3].innerText = data.paidToFreeConversions;
  } catch(e){ toast("Could not load revenue.", "error"); }
}


/* ══════════════════════════════════════════════════════════
   PAYMENTS TABLE — search + status filter + pagination
   ══════════════════════════════════════════════════════════ */
const paymentsState = { page: 1, totalPages: 1, search: "", status: "", data: [], total: 0 };
let paymentSearchDebounceTimer = null;
function debouncedPaymentSearch(){
  clearTimeout(paymentSearchDebounceTimer);
  paymentSearchDebounceTimer = setTimeout(() => {
    paymentsState.search = document.getElementById("paymentSearch").value.trim();
    paymentsState.page = 1;
    loadPayments();
  }, 350);
}
function applyPaymentFilter(){
  paymentsState.status = document.getElementById("paymentStatusFilter").value;
  paymentsState.page = 1;
  loadPayments();
}
async function loadPayments(){
  const tbody = document.getElementById("paymentsTableBody");
  const stateEl = document.getElementById("paymentsState");
  stateEl.style.display = "none";
  try {
    const params = new URLSearchParams({ page: paymentsState.page, limit: 25 });
    if(paymentsState.search) params.set("search", paymentsState.search);
    if(paymentsState.status) params.set("status", paymentsState.status);
    const res = await fetch("/admin/payments?" + params.toString());
    const data = await res.json();
    if(!data.success){ stateEl.style.display = "block"; stateEl.innerText = data.error || "Could not load payments."; tbody.innerHTML = ""; return; }

    paymentsState.data = data.data;
    paymentsState.totalPages = data.totalPages;
    paymentsState.total = data.total;

    if(data.data.length === 0){
      tbody.innerHTML = "";
      stateEl.style.display = "block";
      stateEl.innerText = paymentsState.search || paymentsState.status ? "No payments match your filters." : "No payments recorded yet.";
    } else {
      const fmt = n => "₹" + Number(n || 0).toLocaleString("en-IN");
      tbody.innerHTML = data.data.map(p => {
        const status = escapeHtml(p.status || "paid");
        const plan = escapeHtml(p.plan || "—");
        const billing = p.billingCycle ? ` · ${escapeHtml(p.billingCycle)}` : "";
        return `
          <tr>
            <td class="email-cell">${escapeHtml(p.userEmail)}</td>
            <td><span class="plan-badge ${p.plan && p.plan !== 'free' ? 'paid' : ''}">${plan}${billing}</span></td>
            <td>${fmt(p.amount)}</td>
            <td><span class="status-badge ${status}">${status}</span></td>
            <td>${p.createdAt ? new Date(p.createdAt).toLocaleString("en-IN") : "—"}</td>
          </tr>`;
      }).join("");
    }

    document.getElementById("paymentsPageInfo").innerText = `Page ${data.page} of ${data.totalPages} · ${data.total} payments`;
    document.getElementById("paymentsPrevBtn").disabled = data.page <= 1;
    document.getElementById("paymentsNextBtn").disabled = data.page >= data.totalPages;
  } catch(e){
    stateEl.style.display = "block";
    stateEl.innerText = "Could not load payments.";
  }
}
function changePaymentsPage(delta){
  const next = paymentsState.page + delta;
  if(next < 1 || next > paymentsState.totalPages) return;
  paymentsState.page = next;
  loadPayments();
}

/* ══════════════════════════════════════════════════════════
   USAGE ANALYTICS
   ══════════════════════════════════════════════════════════ */
async function loadUsage(){
  try {
    const res = await fetch("/admin/usage");
    const data = await res.json();
    if(!data.success) return;
    const cards = document.querySelectorAll("#usageGrid .stat-num");
    cards[0].innerText = Number(data.totalClipJobs || 0).toLocaleString("en-IN");
    cards[1].innerText = Number(data.todayProcessed || 0).toLocaleString("en-IN");
    cards[2].innerText = Number(data.transcriptsThisMonth || 0).toLocaleString("en-IN");
    cards[3].innerText = Number(data.clipsThisMonth || 0).toLocaleString("en-IN");
    const max = Math.max(1, ...data.daily.map(d => d.total));
    document.getElementById("usageChart").innerHTML = data.daily.map(d => {
      const h = Math.max(6, Math.round((d.total / max) * 145));
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;"><span style="font-size:11px;">${d.total}</span><div title="${d.label}: ${d.total} processed" style="width:100%;height:${h}px;border-radius:6px 6px 2px 2px;background:var(--accent,#7c5cff);opacity:.85;"></div><span style="font-size:10px;opacity:.7;">${d.label}</span></div>`;
    }).join("");
    document.getElementById("usageDetails").innerHTML = `<div class="plan-chip" style="margin-bottom:10px;">Most-used clip platform: <b>${data.mostUsedPlatform}</b></div><div class="plan-chip" style="margin-bottom:10px;">7-day processed: <b>${data.sevenDayProcessed}</b></div><div class="plan-chip">Credits consumed: <b>Not tracked historically</b></div>`;
  } catch(e){ toast("Could not load usage analytics.", "error"); }
}

/* ══════════════════════════════════════════════════════════
   MARKETING / COUPONS
   ══════════════════════════════════════════════════════════ */
async function loadMarketing(){
  try {
    const [cRes, rRes] = await Promise.all([fetch("/admin/coupons"), fetch("/admin/coupon-redemptions")]);
    const c = await cRes.json(), r = await rRes.json();
    const state = document.getElementById("couponsState");
    if(!c.success){ state.style.display="block"; state.innerText=c.error||"Could not load coupons."; return; }
    state.style.display="none";

    const couponSelect=document.getElementById("marketingCoupon");
    const previous=couponSelect.value;
    couponSelect.innerHTML='<option value="">No coupon</option>'+c.data.filter(x=>x.active && new Date(x.expiresAt)>new Date()).map(x=>
      `<option value="${escapeHtml(x.code)}">${escapeHtml(x.code)} — ${x.percent}% off ${escapeHtml(x.plan)}</option>`).join("");
    if(c.data.some(x=>x.code===previous && x.active && new Date(x.expiresAt)>new Date())) couponSelect.value=previous;

    document.getElementById("couponsTableBody").innerHTML = c.data.length ? c.data.map(x => {
      const expired = new Date(x.expiresAt) < new Date();
      const active = x.active && !expired;
      return `<tr><td><b>${escapeHtml(x.code)}</b></td><td>${x.percent}%</td><td>${escapeHtml(x.plan)}</td><td>${x.usedCount}${x.maxUses ? " / "+x.maxUses : " / ∞"}</td><td>${new Date(x.expiresAt).toLocaleString("en-IN")}</td><td><span class="status-badge ${active?'paid':'failed'}">${active?'Active':'Inactive'}</span></td><td><button class="btn btn-ghost btn-sm" onclick="toggleCoupon('${escapeHtml(x.code)}')">${active?'Disable':'Enable'}</button></td></tr>`;
    }).join("") : `<tr><td colspan="7">No coupons yet.</td></tr>`;
    document.getElementById("redemptionsTableBody").innerHTML = r.success && r.data.length ? r.data.map(x => `<tr><td>${escapeHtml(x.code)}</td><td>${escapeHtml(x.email)}</td><td>${escapeHtml(x.plan)}</td><td>₹${Number(x.discount||0).toLocaleString('en-IN')}</td><td>₹${Number(x.finalAmount||0).toLocaleString('en-IN')}</td><td>${new Date(x.createdAt).toLocaleString('en-IN')}</td></tr>`).join("") : `<tr><td colspan="6">No redemptions yet.</td></tr>`;
    updateMarketingDefaults();
  } catch(e){ toast("Could not load marketing data.", "error"); }
}

function toggleTargetEmail(){
  const specific=document.getElementById("marketingAudience").value==="specific";
  document.getElementById("targetEmailWrap").style.display=specific?"block":"none";
}

function updateMarketingDefaults(){
  const tpl=document.getElementById("marketingTemplate").value;

  // Custom template selected — hide the plan/billing/coupon fields (not relevant), pull subject from saved template
  if(tpl.startsWith("custom:")){
    ["planFieldWrap","billingFieldWrap","couponFieldWrap"].forEach(id=>document.getElementById(id).style.display="none");
    const t=getCustomTemplates().find(x=>x.id===tpl.slice(7));
    const subject=document.getElementById("marketingSubject");
    if(t && (!subject.dataset.edited || !subject.value.trim())) subject.value=t.subject;
    document.getElementById("marketingOfferInfo").innerHTML = t
      ? `🧩 Custom template: <b>${escapeHtml(t.name)}</b> · sent exactly as saved, no checkout link.`
      : `Template not found — it may have been deleted.`;
    return;
  }
  ["planFieldWrap","billingFieldWrap","couponFieldWrap"].forEach(id=>document.getElementById(id).style.display="block");

  const plan=document.getElementById("marketingPlan").value;
  const billing=document.getElementById("marketingBilling").value;
  const couponCode=document.getElementById("marketingCoupon").value;
  const couponOpt=document.querySelector(`#marketingCoupon option[value="${CSS.escape(couponCode)}"]`);
  const pct=couponOpt && couponCode ? (couponOpt.textContent.match(/—\s*(\d+)%/)||[])[1] : "0";
  const prices={starter:{m:149,y:124},pro:{m:299,y:249},agency:{m:599,y:499}};
  const original=billing==="yearly"?prices[plan].y*12:prices[plan].m;
  const final=Math.max(1,Math.round((original-(original*Number(pct)/100))*100)/100);
  const labels={starter:"Starter",pro:"Pro",agency:"Agency"};
  const subjects={discount:`🔥 Special Offer: Get ${pct}% OFF ReelScribe ${labels[plan]}`,upgrade:"🚀 Upgrade ReelScribe and unlock more",expiry:"⏰ Your ReelScribe subscription is expiring soon",announcement:"🚀 New from ReelScribe"};
  const subject=document.getElementById("marketingSubject");
  if(!subject.dataset.edited || !subject.value.trim()) subject.value=subjects[tpl];
  document.getElementById("marketingOfferInfo").innerHTML = tpl==="discount" && couponCode
    ? `🎁 <b>${escapeHtml(couponCode)}</b> — ${pct}% off ${labels[plan]} · ₹${original.toLocaleString('en-IN')} → <b>₹${final.toLocaleString('en-IN')}</b> · button will apply it automatically`
    : `Template: <b>${escapeHtml(subjects[tpl])}</b> · CTA will open the selected ${labels[plan]} checkout.`;
}

function markSubjectEdited(){ document.getElementById("marketingSubject").dataset.edited="1"; }
document.addEventListener("input", e=>{ if(e.target.id==="marketingSubject") markSubjectEdited(); });

async function createCoupon(){
  const body={code:document.getElementById("couponCode").value.trim(),percent:Number(document.getElementById("couponPercent").value),plan:document.getElementById("couponPlan").value,expiresAt:document.getElementById("couponExpiry").value,maxUses:Number(document.getElementById("couponMaxUses").value||0)};
  const box=document.getElementById("couponResult");
  try{ const res=await fetch("/admin/coupons",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); const d=await res.json(); box.innerText=d.success?`Coupon ${d.coupon.code} created successfully.`:(d.error||"Could not create coupon."); box.className="resultBox "+(d.success?"success":"error"); if(d.success){document.getElementById("couponCode").value="";document.getElementById("couponPercent").value="";loadMarketing();}}catch(e){box.innerText="Server error.";box.className="resultBox error";}
}
async function toggleCoupon(code){
  try{const res=await fetch("/admin/coupons/toggle",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})});const d=await res.json();if(!d.success)toast(d.error||"Could not update coupon.","error");else loadMarketing();}catch(e){toast("Server error.","error");}
}

async function previewMarketingEmail(){
  const tpl=document.getElementById("marketingTemplate").value;

  if(tpl.startsWith("custom:")){
    const t=getCustomTemplates().find(x=>x.id===tpl.slice(7));
    if(!t){toast("Template not found.","error");return;}
    document.getElementById("marketingPreviewFrame").srcdoc=t.html;
    document.getElementById("marketingPreviewModal").classList.add("active");
    return;
  }

  const body={templateId:tpl,plan:document.getElementById("marketingPlan").value,billing:document.getElementById("marketingBilling").value,couponCode:document.getElementById("marketingCoupon").value};
  try{
    const res=await fetch("/admin/marketing/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const d=await res.json();
    if(!d.success){toast(d.error||"Could not preview email.","error");return;}
    document.getElementById("marketingPreviewFrame").srcdoc=d.html;
    document.getElementById("marketingPreviewModal").classList.add("active");
  }catch(e){toast("Server error.","error");}
}
function closeMarketingPreview(){ document.getElementById("marketingPreviewModal").classList.remove("active"); }

async function sendMarketingEmail(){
  const audience=document.getElementById("marketingAudience").value;
  const targetEmail=document.getElementById("marketingTargetEmail").value.trim();
  const templateId=document.getElementById("marketingTemplate").value;
  const subject=document.getElementById("marketingSubject").value.trim();
  const box=document.getElementById("marketingResult");
  if(audience==="specific" && !targetEmail){box.innerText="Enter the target user's email.";box.className="resultBox error";return;}
  if(!subject){box.innerText="Subject is required.";box.className="resultBox error";return;}
  const targetText=audience==="specific"?targetEmail:`the selected ${audience} audience`;

  // Custom template — send the saved HTML as-is, tagged templateId:"custom"
  if(templateId.startsWith("custom:")){
    const t=getCustomTemplates().find(x=>x.id===templateId.slice(7));
    if(!t){box.innerText="Template not found.";box.className="resultBox error";return;}
    if(!confirm(`Send "${t.name}" email to ${targetText}?`)) return;
    try{
      const res=await fetch("/admin/marketing/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({audience,targetEmail,templateId:"custom",subject,html:t.html})});
      const d=await res.json();
      box.innerText=d.success?`Sent ${d.sent}/${d.attempted} emails${d.capped?' (100 recipient cap reached).':'.'}`:(d.error||"Could not send emails.");
      box.className="resultBox "+(d.success?"success":"error");
    }catch(e){box.innerText="Server error.";box.className="resultBox error";}
    return;
  }

  const plan=document.getElementById("marketingPlan").value;
  const billing=document.getElementById("marketingBilling").value;
  const couponCode=document.getElementById("marketingCoupon").value;
  if(!confirm(`Send this styled ${templateId} email to ${targetText}?`)) return;
  try{
    const res=await fetch("/admin/marketing/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({audience,targetEmail,templateId,subject,plan,billing,couponCode})});
    const d=await res.json();
    box.innerText=d.success?`Sent ${d.sent}/${d.attempted} emails${d.capped?' (100 recipient cap reached).':'.'}`:(d.error||"Could not send emails.");
    box.className="resultBox "+(d.success?"success":"error");
  }catch(e){box.innerText="Server error.";box.className="resultBox error";}
}

/* ══════════════════════════════════════════════════════════
   CUSTOM TEMPLATES — stored in this browser, no code edits needed
   ══════════════════════════════════════════════════════════ */
const CUSTOM_TEMPLATES_KEY="reelscribe_custom_templates";

const DEFAULT_REFERRAL_TEMPLATE_HTML=`<div style="font-family:Archivo,Helvetica,Arial,sans-serif;background:#0e0d10;padding:32px 16px;">
  <div style="max-width:520px;margin:0 auto;background:#161418;border:1px solid #2a262b;border-radius:12px;overflow:hidden;">
    <div style="padding:28px 28px 0;">
      <div style="display:flex;align-items:center;gap:7px;font-weight:700;font-size:16px;color:#f5f2ee;margin-bottom:22px;">
        <span style="width:7px;height:7px;border-radius:50%;background:#ff3b30;display:inline-block;"></span> ReelScribe
      </div>
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#ff3b30;font-weight:700;margin-bottom:10px;">🎁 New — Invite & Earn</div>
      <h1 style="font-size:22px;line-height:1.3;color:#f5f2ee;margin:0 0 14px;">Invite a friend, earn a free clip.</h1>
      <p style="font-size:14px;line-height:1.7;color:#a39d95;margin:0 0 22px;">
        You can now invite friends to ReelScribe and earn free clip-generation credits — no purchase needed.
        When your friend signs up and completes their first transcript, you get 1 free clip credit. It works even on the Free plan.
      </p>
    </div>
    <div style="padding:0 28px 28px;">
      <a href="https://reelscribe.site/referral.html" style="display:inline-block;background:#ff3b30;color:#1a0a08;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:0.3px;text-transform:uppercase;padding:13px 22px;border-radius:6px;">Get my referral link →</a>
    </div>
    <div style="padding:18px 28px;border-top:1px solid #2a262b;">
      <p style="font-size:11.5px;line-height:1.6;color:#665f5c;margin:0;">
        1. Share your link &nbsp;·&nbsp; 2. Friend signs up &amp; transcribes &nbsp;·&nbsp; 3. You earn 1 clip credit.
      </p>
    </div>
  </div>
</div>`;

function getCustomTemplates(){
  try{
    const raw=localStorage.getItem(CUSTOM_TEMPLATES_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  // First run — seed with a ready-made referral announcement template
  const seeded=[{
    id:"referral-launch",
    name:"Referral Program Launch",
    subject:"🎁 Invite friends, earn free clips on ReelScribe",
    html:DEFAULT_REFERRAL_TEMPLATE_HTML
  }];
  saveCustomTemplates(seeded);
  return seeded;
}
function saveCustomTemplates(arr){ localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(arr)); }

function renderTemplateDropdown(){
  const group=document.getElementById("customTemplateGroup");
  const current=document.getElementById("marketingTemplate").value;
  group.innerHTML = getCustomTemplates().map(t=>`<option value="custom:${escapeAttr(t.id)}">🧩 ${escapeHtml(t.name)}</option>`).join("");
  if(current) document.getElementById("marketingTemplate").value=current;
}

function openTemplateManager(){
  renderTemplateManagerList();
  document.getElementById("templateManagerModal").classList.add("active");
}
function closeTemplateManager(){ document.getElementById("templateManagerModal").classList.remove("active"); }

function renderTemplateManagerList(){
  const list=document.getElementById("templateManagerList");
  const templates=getCustomTemplates();
  if(!templates.length){ list.innerHTML=`<div class="state-msg">No custom templates yet. Create your first one below.</div>`; return; }
  list.innerHTML=templates.map(t=>`
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--s2);border:1px solid var(--border2);border-radius:8px;padding:10px 12px;">
      <div style="min-width:0;">
        <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.name)}</div>
        <div style="font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.subject)}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn btn-ghost btn-sm" onclick="openTemplateEditor('${escapeAttr(t.id)}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteCustomTemplate('${escapeAttr(t.id)}')">Delete</button>
      </div>
    </div>
  `).join("");
}

function deleteCustomTemplate(id){
  if(!confirm("Delete this template? This can't be undone.")) return;
  saveCustomTemplates(getCustomTemplates().filter(t=>t.id!==id));
  renderTemplateManagerList();
  renderTemplateDropdown();
  toast("Template deleted.","success");
}

function openTemplateEditor(id){
  document.getElementById("tplEditId").value=id||"";
  document.getElementById("tplEditResult").style.display="none";
  if(id){
    const t=getCustomTemplates().find(x=>x.id===id);
    document.getElementById("templateEditorTitle").innerText="Edit Template";
    document.getElementById("tplEditName").value=t?.name||"";
    document.getElementById("tplEditSubject").value=t?.subject||"";
    document.getElementById("tplEditHtml").value=t?.html||"";
  } else {
    document.getElementById("templateEditorTitle").innerText="New Template";
    document.getElementById("tplEditName").value="";
    document.getElementById("tplEditSubject").value="";
    document.getElementById("tplEditHtml").value="";
  }
  document.getElementById("templateManagerModal").classList.remove("active");
  document.getElementById("templateEditorModal").classList.add("active");
}
function closeTemplateEditor(){
  document.getElementById("templateEditorModal").classList.remove("active");
  document.getElementById("templateManagerModal").classList.add("active");
  renderTemplateManagerList();
}

function previewTemplateEditor(){
  const html=document.getElementById("tplEditHtml").value.trim();
  if(!html){ toast("Write some HTML first.","error"); return; }
  document.getElementById("marketingPreviewFrame").srcdoc=html;
  document.getElementById("marketingPreviewModal").classList.add("active");
}

function saveTemplateFromEditor(){
  const id=document.getElementById("tplEditId").value;
  const name=document.getElementById("tplEditName").value.trim();
  const subject=document.getElementById("tplEditSubject").value.trim();
  const html=document.getElementById("tplEditHtml").value.trim();
  const box=document.getElementById("tplEditResult");
  if(!name || !subject || !html){
    box.style.display="block"; box.className="resultBox error"; box.innerText="Name, subject and HTML body are all required.";
    return;
  }
  const templates=getCustomTemplates();
  if(id){
    const t=templates.find(x=>x.id===id);
    if(t){ t.name=name; t.subject=subject; t.html=html; }
  } else {
    templates.push({ id:"tpl-"+Date.now(), name, subject, html });
  }
  saveCustomTemplates(templates);
  renderTemplateDropdown();
  toast("Template saved.","success");
  closeTemplateEditor();
}


/* ══════════════════════════════════════════════════════════
   USERS TABLE — search + filters + pagination + CSV export
   ══════════════════════════════════════════════════════════ */
const usersState = { page: 1, totalPages: 1, search: "", planFilter: "", statusFilter: "", joinedFilter: "", quickFilter: "all", data: [], total: 0 };
let searchDebounceTimer = null;
function debouncedSearch(){
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    usersState.search = document.getElementById("userSearch").value.trim();
    usersState.page = 1;
    loadUsers();
  }, 350);
}

/*
  NOTE on "Win-back" / churned detection:
  This relies on the user object having a `planExpiresAt` field even after
  the plan reverts to "free" (i.e. the backend should NOT wipe planExpiresAt
  on downgrade — just leave the last expiry timestamp there, and optionally
  a `lastPaidPlan` field so we know WHICH plan they had). If your backend
  currently clears these fields on downgrade, this filter will undercount —
  ask your backend dev to preserve `lastPaidPlan` + `planExpiresAt` on churn
  for accurate results. Until then, this does best-effort detection with
  whatever the /admin/users response already contains.
*/
function isChurned(u){
  const plan = (u.plan || "free").toLowerCase();
  if (plan !== "free") return false;
  const hadPlan = u.lastPaidPlan || null;
  const expiry = u.planExpiresAt ? new Date(u.planExpiresAt) : null;
  if (hadPlan) return true;
  if (expiry && expiry.getTime() < Date.now()) return true;
  return false;
}
function isExpiringSoon(u, days){
  const plan = (u.plan || "free").toLowerCase();
  if (plan === "free") return false;
  if (!u.planExpiresAt) return false;
  const diffDays = (new Date(u.planExpiresAt).getTime() - Date.now()) / 86400000;
  return diffDays >= 0 && diffDays <= days;
}

function applyFilter(type){
  if (type === "plan"){
    usersState.planFilter = document.getElementById("planFilter").value;
    usersState.quickFilter = "all";
  } else if (type === "status") {
    usersState.statusFilter = document.getElementById("statusFilter").value;
    usersState.quickFilter = "all";
  } else if (type === "joined") {
    usersState.joinedFilter = document.getElementById("joinedFilter").value;
    usersState.quickFilter = "all";
  } else {
    usersState.quickFilter = type;
    if (type !== "all") {
      document.getElementById("planFilter").value = "";
      document.getElementById("statusFilter").value = "";
      document.getElementById("joinedFilter").value = "";
      usersState.planFilter = usersState.statusFilter = usersState.joinedFilter = "";
    }
  }
  ["all","paid","free","expiring","churned"].forEach(f => {
    document.getElementById("chip-" + f).classList.toggle("active", f === usersState.quickFilter);
  });
  usersState.page = 1;
  loadUsers();
}

async function loadReferralReview(){
  const box = document.getElementById("referralReviewList");
  if (!box) return;
  try {
    const res = await fetch("/admin/referrals?status=pending_review");
    const data = await res.json();
    if (!data.success || !data.data.length) { box.innerHTML = '<div class="state-msg">No referrals waiting for review.</div>'; return; }
    box.innerHTML = data.data.map(r => `
      <div class="review-row">
        <div class="review-main">
          <b>${escapeHtml(r.referredEmail)}</b>
          <span>Referrer: ${escapeHtml(r.referrerEmail)} · Risk: ${escapeHtml(r.riskReason || "manual review")}</span>
        </div>
        <div class="review-actions">
          <button class="btn btn-sm" onclick="reviewReferral('${escapeAttr(r._id)}','approve')">Approve</button>
          <button class="btn btn-danger btn-sm" onclick="reviewReferral('${escapeAttr(r._id)}','reject')">Reject</button>
        </div>
      </div>`).join("");
  } catch(e) { box.innerHTML = '<div class="state-msg">Could not load referral review queue.</div>'; }
}

async function reviewReferral(id, action){
  try {
    const res = await fetch("/admin/referrals/" + encodeURIComponent(id) + "/review", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action}) });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Review failed.");
    toast(data.message || "Referral updated.", "success");
    loadReferralReview();
    loadUsers();
    loadStats();
  } catch(e) { toast(e.message || "Review failed.", "error"); }
}

async function loadUsers(){
  const tbody = document.getElementById("usersTableBody");
  const stateEl = document.getElementById("usersState");
  stateEl.style.display = "none";

  try {
    const params = new URLSearchParams({ page: usersState.page, limit: 20, search: usersState.search });
    if (usersState.planFilter) params.set("plan", usersState.planFilter);
    if (usersState.statusFilter) params.set("status", usersState.statusFilter);
    if (usersState.joinedFilter) params.set("joined", usersState.joinedFilter);
    if (usersState.quickFilter !== "all") params.set("quick", usersState.quickFilter);
    const res = await fetch("/admin/users?" + params.toString());
    const data = await res.json();

    if(!data.success){ stateEl.style.display = "block"; stateEl.innerText = "Could not load users."; tbody.innerHTML = ""; return; }

    // Quick filters are applied server-side so pagination and totals stay accurate.
    const rows = data.data;
    usersState.data = rows;
    usersState.rawPageData = data.data;
    usersState.totalPages = data.totalPages;
    usersState.total = data.total;

    if(rows.length === 0){
      tbody.innerHTML = "";
      stateEl.style.display = "block";
      stateEl.innerText = usersState.quickFilter !== "all"
        ? "No users on this page match that filter — try Next page, or Export All to check the full base."
        : (usersState.search ? "No users match that search." : "No users yet.");
    } else {
      tbody.innerHTML = rows.map(u => `
        <tr class="user-row" onclick="openUserDetail('${escapeAttr(u.email)}')">
          <td class="email-cell">${escapeHtml(u.email)}</td>
          <td><span class="plan-badge ${isChurned(u) ? 'churned' : ((u.plan && u.plan !== 'free') ? 'paid' : '')}">${isChurned(u) ? 'churned' : (u.plan || 'free')}</span></td>
          <td>${u.credits ?? 0}</td>
          <td>${u.isSuspended ? '<span class="plan-badge churned">suspended</span>' : '<span class="plan-badge">active</span>'}</td>
          <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString("en-IN") : "—"}</td>
          <td>
            <div class="row-actions">
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); prefillActions('${escapeAttr(u.email)}')">Manage</button>
            </div>
          </td>
        </tr>
      `).join("");
    }

    document.getElementById("usersPageInfo").innerText = `Page ${data.page} of ${data.totalPages} · ${data.total} users total`;
    document.getElementById("usersPrevBtn").disabled = data.page <= 1;
    document.getElementById("usersNextBtn").disabled = data.page >= data.totalPages;
  } catch(e){
    stateEl.style.display = "block";
    stateEl.innerText = "Could not load users.";
  }
}

function changeUsersPage(delta){
  const next = usersState.page + delta;
  if(next < 1 || next > usersState.totalPages) return;
  usersState.page = next;
  loadUsers();
}

function prefillActions(email){
  switchTab("actions");
  document.getElementById("email").value = email;
  document.getElementById("planEmail").value = email;
}

/* ── User Detail Modal ── */
let currentDetailUser = null;
async function openUserDetail(email){
  const u = (usersState.rawPageData || usersState.data).find(x => x.email === email);
  if(!u) return;
  currentDetailUser = u;

  document.getElementById("detailEmail").innerText = u.email;
  document.getElementById("detailSub").innerText = u.email;
  document.getElementById("detailPlan").innerText = u.plan || "free";
  document.getElementById("detailCredits").innerText = u.credits ?? 0;
  document.getElementById("detailStatus").innerText = u.isSuspended ? "Suspended" : "Active";
  document.getElementById("suspendUserBtn").innerText = u.isSuspended ? "Unsuspend User" : "Suspend User";
  document.getElementById("detailJoined").innerText = u.createdAt ? new Date(u.createdAt).toLocaleDateString("en-IN") : "—";
  document.getElementById("detailExpiry").innerText = u.planExpiresAt ? new Date(u.planExpiresAt).toLocaleDateString("en-IN") : "—";
  document.getElementById("detailLastActive").innerText = "Loading…";
  document.getElementById("detailTranscriptions").innerText = "Loading…";
  document.getElementById("detailClipJobs").innerText = "Loading…";
  document.getElementById("detailCreditsUsed").innerText = "Not tracked (plan-based usage)";

  const winback = document.getElementById("winbackBanner");
  const expiring = document.getElementById("expiringBanner");
  winback.classList.remove("show");
  expiring.classList.remove("show");

  if (isChurned(u)){
    document.getElementById("winbackPlan").innerText = u.lastPaidPlan || "paid";
    document.getElementById("winbackDate").innerText = u.planExpiresAt ? new Date(u.planExpiresAt).toLocaleDateString("en-IN") : "recently";
    winback.classList.add("show");
  } else if (isExpiringSoon(u, 7)){
    const days = Math.ceil((new Date(u.planExpiresAt).getTime() - Date.now()) / 86400000);
    document.getElementById("expiringDays").innerText = days;
    expiring.classList.add("show");
  }

  document.getElementById("userDetailModal").classList.add("active");

  try {
    const res = await fetch("/admin/users/" + encodeURIComponent(email) + "/details");
    const data = await res.json();
    if(data.success){
      const d = data.details;
      document.getElementById("detailLastActive").innerText = d.lastActive ? new Date(d.lastActive).toLocaleString("en-IN") : "No activity";
      document.getElementById("detailTranscriptions").innerText = d.totalTranscriptions;
      document.getElementById("detailClipJobs").innerText = d.totalClipJobs;
    } else {
      document.getElementById("detailLastActive").innerText = "Unavailable";
      document.getElementById("detailTranscriptions").innerText = "Unavailable";
      document.getElementById("detailClipJobs").innerText = "Unavailable";
    }
  } catch(e) {
    document.getElementById("detailLastActive").innerText = "Unavailable";
    document.getElementById("detailTranscriptions").innerText = "Unavailable";
    document.getElementById("detailClipJobs").innerText = "Unavailable";
  }
}
function closeUserDetail(){
  document.getElementById("userDetailModal").classList.remove("active");
  currentDetailUser = null;
}
document.getElementById("userDetailModal").addEventListener("click", (e) => {
  if (e.target.id === "userDetailModal") closeUserDetail();
});
function manageFromDetail(){
  if(!currentDetailUser) return;
  closeUserDetail();
  prefillActions(currentDetailUser.email);
}
function copyDetailEmail(){
  if(!currentDetailUser) return;
  navigator.clipboard.writeText(currentDetailUser.email).then(() => toast("Email copied.", "success"))
    .catch(() => toast("Could not copy email.", "error"));
}

/* ── CSV Export (page or full) ── */
function rowsToCSV(rows){
  const head = ["Email","Plan","Credits","Joined","PlanExpiry","Status"];
  const body = rows.map(u => [
    u.email,
    u.plan || "free",
    u.credits ?? 0,
    u.createdAt ? new Date(u.createdAt).toISOString() : "",
    u.planExpiresAt ? new Date(u.planExpiresAt).toISOString() : "",
    isChurned(u) ? "churned (win-back candidate)" : (u.plan && u.plan !== "free" ? "active paid" : "free")
  ]);
  return [head, ...body].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
}
function downloadCSV(csv, filename){
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function exportUsersCSV(all){
  if (!all){
    if(usersState.data.length === 0){ toast("No users loaded to export yet.", "error"); return; }
    downloadCSV(rowsToCSV(usersState.data), `reelscribe-users-page${usersState.page}.csv`);
    toast("Exported the current page to CSV.", "success");
    return;
  }
  exportAllUsers();
}

async function exportAllUsers(){
  const btn = document.getElementById("exportAllBtn");
  btn.disabled = true;
  btn.innerText = "Exporting…";
  try {
    let page = 1, all = [], totalPages = 1;
    do {
      const params = new URLSearchParams({ page, limit: 100, search: usersState.search });
      if (usersState.planFilter) params.set("plan", usersState.planFilter);
      if (usersState.statusFilter) params.set("status", usersState.statusFilter);
      if (usersState.joinedFilter) params.set("joined", usersState.joinedFilter);
      if (usersState.quickFilter !== "all") params.set("quick", usersState.quickFilter);
      const res = await fetch("/admin/users?" + params.toString());
      const data = await res.json();
      if(!data.success) throw new Error("failed");
      all = all.concat(data.data);
      totalPages = data.totalPages;
      page++;
    } while (page <= totalPages);

    downloadCSV(rowsToCSV(all), `reelscribe-users-all-${usersState.quickFilter}.csv`);
    toast(`Exported ${all.length} users to CSV.`, "success");
  } catch(e){
    toast("Could not export all users. Falling back to current page.", "error");
  } finally {
    btn.disabled = false;
    btn.innerText = "Export All";
  }
}

async function creditAction(action){
  const email = document.getElementById("email").value.trim();
  const amount = Number(document.getElementById("credits").value);
  if(!email){ showResult("addResult", "Please enter a user email.", false); return; }
  if(action !== "reset" && (!Number.isInteger(amount) || amount < 0)){ showResult("addResult", "Enter a whole-number credit amount.", false); return; }
  try{
    const res = await fetch("/admin/credit", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({email, action, amount: action === "reset" ? 0 : amount})});
    const data = await res.json();
    if(!data.success) throw new Error(data.error || "Credit update failed.");
    showResult("addResult", `${data.message}.\n${data.user.email}\nCurrent credits: ${data.user.credits}`, true);
    toast("Credits updated.", "success");
    loadUsers(); loadStats();
    if(currentDetailUser?.email === email) openUserDetail(email);
  }catch(e){ showResult("addResult", e.message || "Server error.", false); toast(e.message || "Server error.", "error"); }
}

async function userControl(action){
  if(!currentDetailUser) return;
  const email = currentDetailUser.email;
  try{
    const res = await fetch("/admin/user-control", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({email, action})});
    const data = await res.json();
    if(!data.success) throw new Error(data.error || "Action failed.");
    if(action === "delete"){ closeUserDetail(); toast("User account deleted.", "success"); loadUsers(); loadStats(); return; }
    toast(action === "suspend" ? "User suspended." : "User unsuspended.", "success");
    loadUsers();
    openUserDetail(email);
  }catch(e){ toast(e.message || "Server error.", "error"); }
}
function toggleSuspendUser(){ userControl(currentDetailUser?.isSuspended ? "unsuspend" : "suspend"); }
function confirmDeleteUser(){
  if(!currentDetailUser) return;
  askConfirm("Delete this account?", `${currentDetailUser.email} will be permanently removed. Payment and audit history will be retained.`, () => userControl("delete"));
}

/* ══════════════════════════════════════════════════════════
   ACTIONS — Add Credits / Set Plan / Cancel Plan
   ══════════════════════════════════════════════════════════ */
async function addCredits(){
  const email = document.getElementById("email").value.trim();
  const credits = document.getElementById("credits").value.trim();
  if(!email || !credits){ showResult("addResult", "Please enter both an email and a credit amount.", false); return; }

  try {
    const res = await fetch("/admin/add-credit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, credits: parseInt(credits) })
    });
    const data = await res.json();
    if(data.success){
      showResult("addResult", `${credits} credits added.\n${data.user.email}\nTotal credits: ${data.user.credits}`, true);
      toast("Credits added successfully.", "success");
      document.getElementById("email").value = "";
      document.getElementById("credits").value = "";
      loadUsers(); loadStats();
    } else {
      showResult("addResult", data.error || "Something went wrong.", false);
      toast(data.error || "Something went wrong.", "error");
    }
  } catch(e){ showResult("addResult", "Server error.", false); toast("Server error.", "error"); }
}

async function setPlan(){
  const email = document.getElementById("planEmail").value.trim();
  const plan = document.getElementById("planSelect").value;
  const durationDays = document.getElementById("planDuration").value.trim();
  if(!email){ showResult("planResult", "Please enter an email first.", false); return; }

  try {
    const res = await fetch("/admin/set-plan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, plan, durationDays: parseInt(durationDays) || 30 })
    });
    const data = await res.json();
    if(data.success){
      const expiryText = data.user.planExpiresAt ? new Date(data.user.planExpiresAt).toLocaleDateString("en-IN") : "N/A (free plan)";
      showResult("planResult", `Plan updated.\n${data.user.email}\nPlan: ${data.user.plan}\nExpires: ${expiryText}`, true);
      toast("Plan updated successfully.", "success");
      document.getElementById("planEmail").value = "";
      loadUsers(); loadStats();
    } else {
      showResult("planResult", data.error || "Something went wrong.", false);
      toast(data.error || "Something went wrong.", "error");
    }
  } catch(e){ showResult("planResult", "Server error.", false); toast("Server error.", "error"); }
}

function confirmCancelPlan(){
  const email = document.getElementById("planEmail").value.trim();
  if(!email){ showResult("planResult", "Please enter an email first.", false); return; }
  askConfirm("Cancel this plan?", `${email} will be reverted to the Free plan immediately. This can't be undone automatically.`, cancelPlan);
}

async function cancelPlan(){
  const email = document.getElementById("planEmail").value.trim();
  try {
    const res = await fetch("/admin/set-plan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, plan: "free" })
    });
    const data = await res.json();
    if(data.success){
      showResult("planResult", `Plan cancelled.\n${data.user.email}\nNow on: Free`, true);
      toast("Plan cancelled.", "success");
      document.getElementById("planEmail").value = "";
      loadUsers(); loadStats();
    } else {
      showResult("planResult", data.error || "Something went wrong.", false);
      toast(data.error || "Something went wrong.", "error");
    }
  } catch(e){ showResult("planResult", "Server error.", false); toast("Server error.", "error"); }
}

/* ══════════════════════════════════════════════════════════
   AUDIT LOG
   ══════════════════════════════════════════════════════════ */
const logsState = { page: 1, totalPages: 1, data: [] };

async function loadLogs(){
  const tbody = document.getElementById("logsTableBody");
  const stateEl = document.getElementById("logsState");
  stateEl.style.display = "none";

  try {
    const params = new URLSearchParams({ page: logsState.page, limit: 25 });
    const res = await fetch("/admin/logs?" + params.toString());
    const data = await res.json();

    if(!data.success){ stateEl.style.display = "block"; stateEl.innerText = "Could not load the audit log."; tbody.innerHTML = ""; return; }

    logsState.data = data.data;
    logsState.totalPages = data.totalPages;

    if(data.data.length === 0){
      tbody.innerHTML = "";
      stateEl.style.display = "block";
      stateEl.innerText = "No admin actions logged yet.";
    } else {
      tbody.innerHTML = data.data.map(l => `
        <tr>
          <td>${new Date(l.createdAt).toLocaleString("en-IN")}</td>
          <td>${escapeHtml(l.action)}</td>
          <td>${l.targetEmail ? escapeHtml(l.targetEmail) : "—"}</td>
          <td>${escapeHtml(l.details || "")}</td>
          <td>${escapeHtml(l.ip || "")}</td>
        </tr>
      `).join("");
    }

    document.getElementById("logsPageInfo").innerText = `Page ${data.page} of ${data.totalPages} · ${data.total} entries`;
    document.getElementById("logsPrevBtn").disabled = data.page <= 1;
    document.getElementById("logsNextBtn").disabled = data.page >= data.totalPages;
  } catch(e){
    stateEl.style.display = "block";
    stateEl.innerText = "Could not load the audit log.";
  }
}

function changeLogsPage(delta){
  const next = logsState.page + delta;
  if(next < 1 || next > logsState.totalPages) return;
  logsState.page = next;
  loadLogs();
}

/* ══════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════ */
function showResult(id, msg, success){
  const el = document.getElementById(id);
  el.style.display = "block";
  el.innerText = msg;
  el.className = "resultBox " + (success ? "success" : "error");
}
function escapeHtml(str){
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
function escapeAttr(str){
  return String(str ?? "").replace(/'/g, "&#39;");
}
