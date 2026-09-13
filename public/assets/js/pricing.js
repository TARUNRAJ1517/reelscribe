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
  renderPlanCards();
}

const ctaLabels = {
  starter: { m: 'Start with ₹1 offer', y: 'Get starter' },
  pro:     { m: 'Start with ₹1 offer', y: 'Get pro' },
  agency:  { m: 'Start with ₹1 offer', y: 'Get agency' }
};

// Renders the public pricing presentation. Monthly subscriptions use a ₹1
// introductory offer while the regular monthly price remains clearly visible.
// Avoid time-relative wording on the marketing page; billing terms are explained
// in checkout/account screens where they are operationally relevant.
function renderPlanCards() {
  [['s', 'starter'], ['p', 'pro'], ['a', 'agency']].forEach(([k, plan]) => {
    const p = prices[plan];
    const priceEl = document.getElementById(k + '-price');
    const cycleEl = document.getElementById(k + '-cycle');
    const oldEl   = document.getElementById(k + '-old');
    const noteEl  = document.getElementById(k + '-note');
    const badgeEl = document.getElementById(k + '-badge');

    if (yearly) {
      priceEl.textContent = '₹' + p.y;
      cycleEl.textContent = '/month, billed annually';
      oldEl.textContent = '₹' + p.m;
      oldEl.style.display = 'inline';
      if (noteEl) noteEl.textContent = 'One-time payment, no autopay.';
      if (badgeEl) badgeEl.style.display = 'none';
    } else {
      priceEl.textContent = '₹1';
      cycleEl.textContent = 'intro offer';
      oldEl.textContent = '₹' + p.m + '/month';
      oldEl.style.display = 'inline';
      if (noteEl) noteEl.textContent = `Introductory offer • Regular plan price ₹${p.m}/month`;
      if (badgeEl) { badgeEl.style.display = 'inline-flex'; badgeEl.lastChild.textContent = 'Introductory offer'; }
    }

    const btn = document.getElementById(k === 's' ? 'starterCta' : k === 'p' ? 'proCta' : 'agencyCta');
    if (btn && !btn.disabled) btn.textContent = yearly ? ctaLabels[plan].y : ctaLabels[plan].m;
  });
}

async function buyPlan(plan) {
  let loggedIn = false, email = "";
  try {
    const me = await fetch("/me").then(r => r.json());
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
  const couponCode = offerCoupon || "";

  // Monthly = AutoPay subscription with the ₹1 introductory offer.
  // Yearly = one-time payment, same as before.
  if (billing === "monthly") {
    return buySubscription(plan, email);
  }

  try {
    const res = await fetch("/create-order", {
      method: "POST",
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
      billing === "yearly" ? "Yearly" : "Monthly"
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

      modal: {
        ondismiss: function() {
          alert("Payment cancelled. You haven't been charged. You can try again anytime.");
        }
      },

      theme: { color: "#ff3b30" }
    };

    // Show the applied offer before Razorpay opens.
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

// AutoPay flow (monthly plans): ₹1 introductory activation charge,
// followed by the selected regular monthly subscription price.
async function buySubscription(plan, email) {
  let checkoutSucceeded = false;
  try {
    const res = await fetch("/create-subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan })
    });

    const data = await res.json();

    if (!data.success) {
      alert(data.error || "Could not start the subscription. Please try again.");
      return;
    }

    const fullPrice = prices[plan]?.m || 0;
    const subscriptionId = data.subscriptionId;
    const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
    const options = {
      key: data.key,
      subscription_id: data.subscriptionId,
      name: "ReelScribe",
      description: `${planLabel} Plan • ₹1 introductory offer • ₹${fullPrice}/month regular price`,
      prefill: { email },

      handler: async function (response) {
        checkoutSucceeded = true;
        try {
          const verify = await fetch("/verify-subscription", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_subscription_id: response.razorpay_subscription_id,
              razorpay_signature: response.razorpay_signature
            })
          });
          const result = await verify.json();

          if (result.success) {
            alert(`Payment successful. Your ${planLabel} plan is active now. Your regular subscription price is ₹${fullPrice}/month.`);
            location.href = "/dashboard.html";
          } else {
            alert(result.error || "Payment verification is still processing. Please open your dashboard in a few seconds.");
            location.href = "/dashboard.html";
          }
        } catch (e) {
          console.error("Subscription verification failed:", e);
          alert("Payment received. Your plan is being activated. Please open your dashboard in a few seconds.");
          location.href = "/dashboard.html";
        }
      },

      modal: {
        ondismiss: async function () {
          if (checkoutSucceeded) return;
          try {
            await fetch("/cancel-subscription", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscriptionId }) });
          } catch (e) {
            console.error("Cleanup after cancelled checkout failed:", e);
          }
          alert("Subscription cancelled. You haven't been charged. You can try again anytime.");
        }
      },

      theme: { color: "#ff3b30" }
    };

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
    const planIds = { starter: 'starterCta', pro: 'proCta', agency: 'agencyCta' };
    Object.entries(planIds).forEach(([p, id]) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = false; btn.className = 'cta ' + (p === 'pro' ? 'cta-fill' : 'cta-outline');
    });
    renderPlanCards(); // sets the ₹1/Get-X label correctly for the current billing toggle

    const freeCard = document.getElementById('freeCard');
    const freeStatus = document.getElementById('freeStatus');
    freeCard.classList.remove('is-current'); freeStatus.classList.remove('active');
    freeStatus.textContent = 'AVAILABLE';

    if (plan === 'free') {
      freeCard.classList.add('is-current');
      freeStatus.classList.add('active');
      freeStatus.textContent = '✓ CURRENT PLAN';
    } else if (planIds[plan]) {
      const card = document.querySelector(`[data-plan-card="${plan}"]`);
      const btn = document.getElementById(planIds[plan]);
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
  renderPlanCards();
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
