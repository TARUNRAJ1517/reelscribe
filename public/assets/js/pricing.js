const offerParams = new URLSearchParams(window.location.search);
const offerCoupon = (offerParams.get('coupon') || '').trim().toUpperCase();
const offerPlan = (offerParams.get('plan') || '').trim().toLowerCase();
const offerBilling = (offerParams.get('billing') || '').trim().toLowerCase();

let yearly = offerBilling === 'yearly';
const prices = {
  starter: { m: 149, y: 124 },
  pro:     { m: 299, y: 249 },
  agency:  { m: 599, y: 499 }
};

function toggleBilling() {
  yearly = !yearly;
  document.getElementById('sw').classList.toggle('on', yearly);
  document.getElementById('lbl-m').classList.toggle('active', !yearly);
  document.getElementById('lbl-y').classList.toggle('active', yearly);
  [['s','starter'],['p','pro'],['a','agency']].forEach(([k,plan]) => {
    const p = prices[plan];
    document.getElementById(k+'-price').textContent = '₹' + (yearly ? p.y : p.m);
    document.getElementById(k+'-cycle').textContent = yearly ? '/month, billed annually' : '/month';
    const old = document.getElementById(k+'-old');
    old.textContent = yearly ? '₹'+p.m : '';
    old.style.display = yearly ? 'inline' : 'none';
  });
}

async function buyPlan(plan) {
  let loggedIn = false, email = "";
  try {
    const me = await fetch("/me", { credentials: "include" }).then(r => r.json());
    loggedIn = !!me.loggedIn;
    email = me.email || "";
  } catch (e) {}

  if (!loggedIn) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    alert("Please log in before purchasing a plan.");
    window.location.href = "/login.html?next=" + next;
    return;
  }

  const billing = yearly ? "yearly" : "monthly";

  try {
    // Monthly plans use the real Razorpay Subscription + AutoPay flow.
    // Yearly plans continue using the existing one-time Order flow.
    if (billing === "monthly") {
      const res = await fetch("/create-subscription", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan })
      });

      const data = await res.json();
      if (!data.success) {
        alert(data.error || "Could not start AutoPay. Please try again.");
        return;
      }

      const monthlyPrice = prices[plan].m;
      const options = {
        key: data.key,
        subscription_id: data.subscriptionId,
        name: "ReelScribe",
        description: "₹1 today • 24-hour access • ₹" + monthlyPrice + "/month from tomorrow",
        prefill: { email },
        theme: { color: "#ff3b30" },

        handler: async function (response) {
          try {
            const verify = await fetch("/verify-subscription", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_subscription_id: response.razorpay_subscription_id || data.subscriptionId,
                razorpay_signature: response.razorpay_signature
              })
            });

            const result = await verify.json();
            if (result.success) {
              alert("₹1 successful. Your " + plan.toUpperCase() + " access is active for 24 hours. AutoPay will charge ₹" + monthlyPrice + " tomorrow.");
              location.href = "/dashboard.html";
            } else {
              alert(result.error || "AutoPay verification failed. Please contact support.");
            }
          } catch (e) {
            console.error(e);
            alert("Verification error. Please contact support.");
          }
        },

        modal: {
          ondismiss: function() {
            console.log("Subscription checkout closed");
          }
        }
      };

      const rzp = new Razorpay(options);
      rzp.on("payment.failed", function (response) {
        console.error("Razorpay subscription authorization failed:", response.error);
        alert(response.error?.description || "AutoPay authorization failed. Please try again.");
      });
      rzp.open();
      return;
    }

    // Existing yearly one-time payment flow.
    const couponCode = offerCoupon || "";
    const res = await fetch("/create-order", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, billing, couponCode })
    });

    const data = await res.json();
    if (!data.success) {
      alert(data.error || "Could not create the order. Please try again.");
      return;
    }

    const pricing = data.pricing || {};
    const descriptionParts = [
      plan.charAt(0).toUpperCase() + plan.slice(1) + " Plan",
      "Yearly"
    ];

    if (data.coupon && data.coupon.code) {
      descriptionParts.push("Coupon " + data.coupon.code + " applied");
    }

    const options = {
      key: data.key,
      amount: data.order.amount,
      currency: data.order.currency,
      name: "ReelScribe",
      description: descriptionParts.join(" • "),
      order_id: data.order.id,
      prefill: { email },
      handler: async function (response) {
        try {
          const verify = await fetch("/verify-payment", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...response })
          });
          const result = await verify.json();
          if (result.success) {
            alert("Payment successful! Your " + plan.toUpperCase() + " plan is now active.");
            location.href = "/dashboard.html";
          } else {
            alert(result.error || "Payment verification failed. Please contact support.");
          }
        } catch (e) {
          alert("Verification error. Please contact support.");
        }
      },
      modal: { ondismiss: function() { console.log("Payment modal closed"); } },
      theme: { color: "#ff3b30" }
    };

    if (data.coupon && pricing.discountAmount > 0) {
      const saved = Number(pricing.discountAmount).toFixed(2);
      const finalAmount = Number(pricing.finalAmount).toFixed(2);
      console.log("Coupon " + data.coupon.code + " applied. Saved ₹" + saved + ". Pay ₹" + finalAmount);
    }

    const rzp = new Razorpay(options);
    rzp.open();
  } catch (err) {
    console.error(err);
    alert("Something went wrong. Please try again.");
  }
}

async function loadCurrentPlan() {
  const banner = document.getElementById('currentPlanBanner');
  const nameEl = document.getElementById('currentPlanName');
  const expiryEl = document.getElementById('currentPlanExpiry');
  try {
    const res = await fetch('/user-plan', { credentials: 'include' });
    const data = await res.json();
    if (!res.ok || !data.success) { banner.style.display = 'none'; return; }

    const plan = (data.plan || 'free').toLowerCase();
    const labels = { free:'Free', starter:'Starter', pro:'Pro', agency:'Agency' };
    const label = labels[plan] || 'Free';
    nameEl.textContent = label;
    expiryEl.textContent = plan !== 'free' && data.planExpiresAt
      ? 'Active until ' + new Date(data.planExpiresAt).toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'})
      : 'Free plan';
    banner.style.display = 'flex';

    // Reset all cards/buttons first.
    document.querySelectorAll('[data-plan-card]').forEach(card => card.classList.remove('is-current'));
    const configs = {
      starter: ['starterCta','Get starter'],
      pro: ['proCta','Get pro'],
      agency: ['agencyCta','Get agency']
    };
    Object.entries(configs).forEach(([p,[id,text]]) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = false; btn.className = 'cta ' + (p === 'pro' ? 'cta-fill' : 'cta-outline');
      btn.textContent = text;
    });

    const freeCard = document.getElementById('freeCard');
    const freeStatus = document.getElementById('freeStatus');
    freeCard.classList.remove('is-current'); freeStatus.classList.remove('active');
    freeStatus.textContent = 'AVAILABLE';

    if (plan === 'free') {
      freeCard.classList.add('is-current');
      freeStatus.classList.add('active');
      freeStatus.textContent = '✓ CURRENT PLAN';
    } else if (configs[plan]) {
      const card = document.querySelector(`[data-plan-card="${plan}"]`);
      const btn = document.getElementById(configs[plan][0]);
      if (card) card.classList.add('is-current');
      if (btn) {
        btn.disabled = true;
        btn.className = 'cta cta-outline';
        btn.textContent = '✓ Current plan';
      }
    }
  } catch (e) {
    banner.style.display = 'none';
    console.warn('Could not load current plan:', e);
  }
}

// Marketing offer links can open this page with ?plan=pro&billing=monthly&coupon=CODE.
// Keep the normal pricing page UI, but automatically use those values when the user clicks a plan.
window.addEventListener("DOMContentLoaded", () => {
  loadCurrentPlan();
  if (offerBilling === "yearly") {
    yearly = false;
    toggleBilling();
  }

  if (offerPlan && ["starter", "pro", "agency"].includes(offerPlan)) {
    const card = document.querySelector(".plan." + offerPlan) ||
                 Array.from(document.querySelectorAll(".plan")).find(el =>
                   (el.querySelector(".plan-name")?.textContent || "").trim().toLowerCase() === offerPlan
                 );
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.style.boxShadow = "0 0 0 2px rgba(255,59,48,.55)";
      setTimeout(() => card.style.boxShadow = "", 2500);
    }
  }

  if (offerCoupon) {
    const banner = document.createElement("div");
    banner.textContent = "🎁 Offer " + offerCoupon + " will be applied automatically at checkout";
    banner.style.cssText =
      "position:fixed;left:16px;right:16px;bottom:16px;z-index:100;" +
      "padding:13px 16px;border:1px solid rgba(255,59,48,.5);" +
      "border-radius:8px;background:#161418;color:#f5f2ee;" +
      "font:600 13px Archivo,sans-serif;text-align:center;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.35)";
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 5000);
  }
});


/* ── Premium ₹1 intro-offer preview ─────────────────── */
let rsIntroStage = 0;

function openIntroOffer(){
  rsIntroStage = 0;
  const modal = document.getElementById("rsOfferModal");
  if (!modal) return;
  renderIntroStage();
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden","false");
  document.body.style.overflow = "hidden";
}

function closeIntroOffer(){
  const modal = document.getElementById("rsOfferModal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden","true");
  document.body.style.overflow = "";
}

function renderIntroStage(){
  const step = document.getElementById("rsModalStep");
  const icon = document.getElementById("rsModalIcon");
  const title = document.getElementById("rsModalTitle");
  const text = document.getElementById("rsModalText");
  const cta = document.getElementById("rsModalCta");
  if (!step || !icon || !title || !text || !cta) return;

  const stages = [
    {
      step:"STEP 01 · INTRO OFFER", icon:"₹", title:"Start for ₹1",
      text:"The checkout collects the ₹1 upfront amount and asks the customer to authorize the recurring subscription.",
      cta:"Continue →"
    },
    {
      step:"STEP 02 · AUTOPAY MANDATE", icon:"↻", title:"Authorize AutoPay",
      text:"The customer approves the recurring mandate. The selected plan will be collected automatically from tomorrow.",
      cta:"Continue →"
    },
    {
      step:"STEP 03 · 2 DAYS PRO", icon:"2D", title:"Full access for 1 day",
      text:"ReelScribe grants the selected plan for 24 hours. The recurring billing date is scheduled for tomorrow.",
      cta:"See renewal →"
    },
    {
      step:"STEP 04 · RECURRING", icon:"₹599", title:"Then the selected plan price/month",
      text:"At the scheduled renewal, Razorpay automatically attempts the selected plan charge. If payment fails, the backend handles the subscription state.",
      cta:"Done"
    }
  ];
  const s = stages[rsIntroStage];
  step.textContent=s.step; icon.textContent=s.icon; title.textContent=s.title; text.textContent=s.text; cta.textContent=s.cta;
}

function advanceIntroOffer(){
  if (rsIntroStage >= 3) { closeIntroOffer(); return; }
  rsIntroStage += 1;
  renderIntroStage();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeIntroOffer();
});
