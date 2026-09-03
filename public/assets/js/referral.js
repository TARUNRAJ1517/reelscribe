const $=id=>document.getElementById(id), toast=m=>{let t=$("toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200)};
function showLoginPrompt(){
  $("refLink").value="Log in to get your link";
  $("copy").disabled=true;
  document.querySelectorAll(".share").forEach(el=>el.classList.add("disabled"));
  $("activity").innerHTML='<div class="empty" style="padding:24px;text-align:center">Log in to see your referral activity.</div>';
  const box=document.createElement("div");
  box.className="loginbox";
  box.innerHTML='<span>You need to be logged in to get your referral link.</span><a href="/login.html?next=/referral.html" class="btn" style="text-decoration:none;padding:9px 16px;display:inline-block">Log in</a>';
  const card=$("refLink").closest(".card");
  card.parentElement.insertBefore(box,card);
}
async function load(){
 try{
  const r=await fetch("/referral",{credentials:"same-origin"});
  if(r.status===401){showLoginPrompt();return}
  const d=await r.json();
  if(!d.success)throw Error();
  const code=d.referralCode||"",url=d.referralLink||(code?location.origin+"/ref/"+encodeURIComponent(code):"");
  $("refLink").value=url||"Log in to get your link";
  $("invited").textContent=d.invited??0;$("earned").textContent=d.earned??0;$("pending").textContent=d.pending??0;
  const earned=Number(d.monthlyEarned ?? d.earned)||0,cap=Number(d.monthlyCap)||5,p=Math.min(earned/cap,1);
  $("pc").textContent=earned+" / "+cap;$("fill").style.width=(p*100)+"%";
  const text="Try ReelScribe — instant video transcripts + AI-cut clips.";
  $("wa").href="https://wa.me/?text="+encodeURIComponent(text+" "+url);
  $("tg").href="https://t.me/share/url?url="+encodeURIComponent(url)+"&text="+encodeURIComponent(text);
  $("qrimg").src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data="+encodeURIComponent(url);
  const rows=Array.isArray(d.activity)?d.activity:[];
  $("activity").innerHTML=rows.length?rows.map(x=>`<div class="row"><div class="avatar">${String(x.name||"F").trim().charAt(0).toUpperCase()}</div><div class="who"><strong>${esc(x.name||"Friend")}</strong><small>${esc(x.date||"")}</small></div><span class="status ${x.status==="done"?"done":x.status==="rejected"?"rejected":"pending"}">${x.status==="done"?"Credited":x.status==="rejected"?"Rejected":"Pending"}</span></div>`).join(""):'<div class="empty" style="padding:24px;text-align:center">No referrals yet — share your link to get started.</div>';
 }catch(e){$("refLink").value="Could not load your link";$("activity").innerHTML='<div class="empty" style="padding:24px;text-align:center">Could not load referral activity.</div>'}
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
$("copy").onclick=()=>navigator.clipboard?.writeText($("refLink").value).then(()=>toast("Referral link copied")).catch(()=>{ $("refLink").select();toast("Copy the selected link")});
$("qr").onclick=()=>{let q=$("qrbox");q.style.display=q.style.display==="none"?"block":"none"};
document.querySelectorAll(".faqitem button").forEach(b=>b.onclick=()=>b.parentElement.classList.toggle("open"));
load();
