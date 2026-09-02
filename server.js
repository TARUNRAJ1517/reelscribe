// ═══════════════════════════════════════════════════════
//  RENDER SERVER — server.js
//  Handles: auth, OTP, payment, transcription, routing
//  Clips: forwarded to EC2
// ═══════════════════════════════════════════════════════
require("dotenv").config();

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required. Refusing to start with an insecure session configuration.");
}

const express    = require("express");
const mongoose   = require("mongoose");
const multer     = require("multer");
const path       = require("path");
const fs         = require("fs");
const cors       = require("cors");
const Groq       = require("groq-sdk");
const session    = require("express-session");
const passport   = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const axios      = require("axios");
const https      = require("https");
const { YoutubeTranscript } = require("youtube-transcript");
const { Resend }            = require("resend");
const Reel        = require("./models/Reel");
const User        = require("./models/User");
const GuestUsage  = require("./models/GuestUsage");
const Referral     = require("./models/Referral");
const ClipJob     = require("./models/Clip");
const AdminLog    = require("./models/AdminLog");
const Payment     = require("./models/Payment");
const Coupon      = require("./models/Coupon");
const CouponRedemption = require("./models/CouponRedemption");
const Razorpay    = require("razorpay");
const crypto      = require("crypto");
const FormData    = require("form-data");

const resend  = new Resend(process.env.RESEND_API_KEY);
const app     = express();
const groq    = new Groq({ apiKey: process.env.GROQ_API_KEY });
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const EC2_URL       = process.env.EC2_URL;
const INTERNAL_KEY  = process.env.INTERNAL_SECRET;

const PLAN_LIMITS = {
  free:    { transcriptDay: 2,  transcriptMonth: 5,   clipDay: 0,  clipMonth: 0,  maxMB: 100,  maxVideoMinutes: 0   },
  starter: { transcriptDay: 5,  transcriptMonth: 30,  clipDay: 2,  clipMonth: 10, maxMB: 500,  maxVideoMinutes: 40  },
  pro:     { transcriptDay: 10, transcriptMonth: 60,  clipDay: 5,  clipMonth: 15, maxMB: 1024, maxVideoMinutes: 70  },
  agency:  { transcriptDay: 20, transcriptMonth: 150, clipDay: 15, clipMonth: 60, maxMB: 2048, maxVideoMinutes: 120 },
};

app.set("trust proxy", 1);

// Lightweight security headers without introducing another dependency.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(cors({
  origin: ["https://reelscribe.site", "https://www.reelscribe.site"],
  credentials: true,
}));
app.use(express.json());
app.use(express.static("public"));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));
app.use(passport.initialize());
app.use(passport.session());

function getSessionEmail(req) {
  return (req.user && req.user.email) || req.session?.userEmail || null;
}

async function requireAuth(req, res, next) {
  const email = getSessionEmail(req);
  if (!email) return res.status(401).json({ success: false, loginRequired: true, error: "Please log in to continue." });
  try {
    const user = await User.findOne({ email }).select("_id email isSuspended lastActiveAt");
    if (!user) return res.status(401).json({ success: false, loginRequired: true, error: "Account not found. Please log in again." });
    if (user.isSuspended) return res.status(403).json({ success: false, suspended: true, error: "Your account is currently suspended. Please contact support." });
    req.authEmail = user.email;
    // Keep activity useful without writing on every single request.
    if (!user.lastActiveAt || Date.now() - new Date(user.lastActiveAt).getTime() > 5 * 60 * 1000) {
      User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Legacy /proxy-upload has been removed. Large uploads should go through the
// authenticated transcript flow or the dedicated clip-processing service.

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

const otpStore = {};

const otpSendLimiter   = {};
const otpVerifyAttempts = {};

const OTP_SEND_MAX_PER_WINDOW   = 3;
const OTP_SEND_WINDOW_MS        = 15 * 60 * 1000;
const OTP_VERIFY_MAX_ATTEMPTS   = 5;
const OTP_VERIFY_WINDOW_MS      = 15 * 60 * 1000;

function checkOtpSendLimit(email) {
  const now = Date.now();
  const rec = otpSendLimiter[email];
  if (!rec || now - rec.windowStart > OTP_SEND_WINDOW_MS) {
    otpSendLimiter[email] = { count: 1, windowStart: now };
    return { allowed: true };
  }
  if (rec.count >= OTP_SEND_MAX_PER_WINDOW) {
    const waitMin = Math.ceil((OTP_SEND_WINDOW_MS - (now - rec.windowStart)) / 60000);
    return { allowed: false, error: `Too many OTP requests. Please try again in ${waitMin} minute${waitMin === 1 ? "" : "s"}.` };
  }
  rec.count++;
  return { allowed: true };
}

function checkOtpVerifyLimit(email) {
  const now = Date.now();
  const rec = otpVerifyAttempts[email];
  if (!rec || now - rec.windowStart > OTP_VERIFY_WINDOW_MS) {
    otpVerifyAttempts[email] = { count: 1, windowStart: now };
    return { allowed: true };
  }
  if (rec.count >= OTP_VERIFY_MAX_ATTEMPTS) {
    return { allowed: false, error: "Too many incorrect attempts. Please request a new code." };
  }
  rec.count++;
  return { allowed: true };
}

setInterval(() => {
  const now = Date.now();
  for (const k in otpSendLimiter)    if (now - otpSendLimiter[k].windowStart > OTP_SEND_WINDOW_MS) delete otpSendLimiter[k];
  for (const k in otpVerifyAttempts) if (now - otpVerifyAttempts[k].windowStart > OTP_VERIFY_WINDOW_MS) delete otpVerifyAttempts[k];
}, 10 * 60 * 1000);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id)); } catch (err) { done(err, null); }
});
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL,
  passReqToCallback: true,
}, async (req, accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value.toLowerCase().trim();
    let user = await User.findOne({ email });
    if (!user) {
      const referralCode = req.session.referralCode || null;
      const fp = requestFingerprints(req);
      const emailIdentity = normalizeEmailIdentity(email);
      if (await hasEmailIdentityConflict(email)) return done(null, null);
      user = await User.create({ name: profile.displayName, email, credits: 5, referredBy: referralCode, emailIdentity, signupIpHash: fp.ipHash, signupUaHash: fp.uaHash });
      if (referralCode) await createReferralRecord(referralCode, email, req);
      delete req.session.referralCode;
    }
    return done(null, user);
  } catch (err) { return done(err, null); }
}));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // Groq direct-upload limit used by the UI.


const adminAuthAttempts = {};
const ADMIN_MAX_ATTEMPTS  = 5;
const ADMIN_WINDOW_MS     = 15 * 60 * 1000;
const ADMIN_BLOCK_MS      = 30 * 60 * 1000;

function adminAuth(req, res, next) {
  if (req.session?.isAdmin) return next();

  const ip  = req.ip || "unknown";
  const now = Date.now();
  const rec = adminAuthAttempts[ip];

  if (rec?.blockedUntil && now < rec.blockedUntil) {
    const waitMin = Math.ceil((rec.blockedUntil - now) / 60000);
    return res.status(429).json({ success: false, error: `Too many incorrect attempts. Please try again in ${waitMin} minute${waitMin === 1 ? "" : "s"}.` });
  }

  if (!process.env.ADMIN_SECRET || req.headers["x-admin-key"] !== process.env.ADMIN_SECRET) {
    if (!rec || now - rec.windowStart > ADMIN_WINDOW_MS) {
      adminAuthAttempts[ip] = { count: 1, windowStart: now, blockedUntil: null };
    } else {
      rec.count++;
      if (rec.count >= ADMIN_MAX_ATTEMPTS) rec.blockedUntil = now + ADMIN_BLOCK_MS;
    }
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  delete adminAuthAttempts[ip];
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const k in adminAuthAttempts) {
    const r = adminAuthAttempts[k];
    if ((!r.blockedUntil || now > r.blockedUntil) && now - r.windowStart > ADMIN_WINDOW_MS) delete adminAuthAttempts[k];
  }
}, 10 * 60 * 1000);

function internalAuth(req, res, next) {
  if (!INTERNAL_KEY || req.headers["x-internal-key"] !== INTERNAL_KEY)
    return res.status(401).json({ success: false, error: "Unauthorized" });
  next();
}

function isValidEmail(email) {
  return typeof email === "string" &&
    email.length > 0 && email.length < 255 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── REFERRAL SECURITY HELPERS ──────────────────────────────
// Store one-way request fingerprints; never store raw IP addresses.
function getRequestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").trim();
}

function fingerprint(value) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET || "referral-fingerprint")
    .update(String(value || "unknown"))
    .digest("hex");
}

function requestFingerprints(req) {
  const ip = getRequestIp(req);
  const ua = String(req.get("user-agent") || "unknown");
  return { ipHash: fingerprint(ip), uaHash: fingerprint(ua) };
}

function normalizeEmailIdentity(email) {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at < 1) return raw;
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.split("+")[0].replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

async function hasEmailIdentityConflict(email) {
  const identity = normalizeEmailIdentity(email);
  // Exact/canonical identities are cheap to check through the indexed field.
  if (await User.findOne({ emailIdentity: identity }).select("_id").lean()) return true;
  // Backward compatibility: users created before this field existed have no identity.
  // Only scan Gmail-family accounts, then normalize in application code.
  const domain = identity.split("@")[1];
  if (domain !== "gmail.com") return false;
  const legacy = await User.find({ email: /@(gmail\.com|googlemail\.com)$/i }).select("email").lean();
  return legacy.some(u => normalizeEmailIdentity(u.email) === identity);
}

// Referral-code probing is deliberately rate-limited separately from login/OTP.
const referralCodeAttempts = {};
const REFERRAL_CODE_MAX = 20;
const REFERRAL_CODE_WINDOW_MS = 10 * 60 * 1000;
function checkReferralCodeLimit(req) {
  const key = getRequestIp(req);
  const now = Date.now();
  const rec = referralCodeAttempts[key];
  if (!rec || now - rec.windowStart > REFERRAL_CODE_WINDOW_MS) {
    referralCodeAttempts[key] = { count: 1, windowStart: now };
    return { allowed: true };
  }
  if (rec.count >= REFERRAL_CODE_MAX) return { allowed: false };
  rec.count++;
  return { allowed: true };
}

function isNewDay(lastDate) {
  if (!lastDate) return true;
  return new Date(lastDate).toDateString() !== new Date().toDateString();
}

function isNewMonth(lastDate) {
  if (!lastDate) return true;
  const l = new Date(lastDate), n = new Date();
  return l.getMonth() !== n.getMonth() || l.getFullYear() !== n.getFullYear();
}

async function checkGuestLimit(req) {
  const ipHash = fingerprint(getRequestIp(req));
  // Atomically consume one of the three previews. If several requests arrive
  // together, MongoDB still cannot let the counter exceed the limit.
  const guest = await GuestUsage.findOneAndUpdate(
    { ipHash, previewCount: { $lt: 3 } },
    { $inc: { previewCount: 1 }, $set: { updatedAt: new Date() }, $setOnInsert: { ipHash } },
    { new: true, upsert: false }
  );
  if (guest) return { allowed: true };

  try {
    const created = await GuestUsage.create({ ipHash, previewCount: 1 });
    return { allowed: !!created };
  } catch (err) {
    if (err?.code === 11000) return { allowed: false };
    throw err;
  }
}

async function getInstagramVideoUrl(instagramUrl) {
  const response = await axios.get(
    "https://instagram-downloader-scraper-reels-igtv-posts-stories.p.rapidapi.com/scraper",
    {
      params:  { url: instagramUrl },
      headers: {
        "x-rapidapi-key":  process.env.RAPID_API_KEY,
        "x-rapidapi-host": "instagram-downloader-scraper-reels-igtv-posts-stories.p.rapidapi.com",
      },
    }
  );
  if (response.data?.data?.length > 0 && response.data.data[0].media)
    return response.data.data[0].media;
  throw new Error("Couldn't find a video at that URL.");
}

function downloadVideo(videoUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https.get(videoUrl, (response) => {
      response.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => { fs.unlink(outputPath, () => {}); reject(err); });
  });
}

function getEffectivePlan(user) {
  const plan = user.plan || "free";
  if (plan === "free") return "free";
  if (!user.planExpiresAt || new Date(user.planExpiresAt) < new Date()) return "free";
  return plan;
}

// ── REFERRALS ─────────────────────────────────────────────
// One verified new signup through a referral gives the referrer
// one Starter-equivalent clip cut. Referral cuts are separate from
// paid-plan clip limits and request a watermark from the EC2 renderer.
function makeReferralCode() {
  return crypto.randomBytes(6).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
}

async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  for (let i = 0; i < 8; i++) {
    const code = makeReferralCode();
    try {
      const updated = await User.findOneAndUpdate(
        { _id: user._id, $or: [{ referralCode: { $exists: false } }, { referralCode: null }, { referralCode: "" }] },
        { $set: { referralCode: code } },
        { new: true }
      );
      if (updated?.referralCode) return updated.referralCode;
      const fresh = await User.findById(user._id);
      if (fresh?.referralCode) return fresh.referralCode;
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  throw new Error("Could not create a referral code. Please try again.");
}

async function createReferralRecord(referralCode, newUserEmail, req) {
  const code = String(referralCode || "").trim().toUpperCase();
  if (!code || !isValidEmail(newUserEmail)) return null;
  const referrer = await User.findOne({ referralCode: code });
  if (!referrer) return null;
  if (referrer.email.toLowerCase() === newUserEmail.toLowerCase()) return null;

  const fp = requestFingerprints(req);
  const knownReferrerIp = referrer.signupIpHash || referrer.lastSeenIpHash;
  const knownReferrerUa = referrer.signupUaHash || referrer.lastSeenUaHash;
  const sameIp = !!knownReferrerIp && knownReferrerIp === fp.ipHash;
  const sameUa = !!knownReferrerUa && knownReferrerUa === fp.uaHash;
  const status = sameIp ? "pending_review" : "pending";
  const riskReason = sameIp ? (sameUa ? "same_ip_and_device_signal" : "same_ip") : null;

  return Referral.findOneAndUpdate(
    { referredEmail: newUserEmail.toLowerCase() },
    {
      $setOnInsert: {
        referrerEmail: referrer.email.toLowerCase(),
        referredEmail: newUserEmail.toLowerCase(),
        referralCode: code,
        status,
        referredIpHash: fp.ipHash,
        referredUaHash: fp.uaHash,
        referrerIpHash: referrer.signupIpHash || null,
        referrerUaHash: referrer.signupUaHash || null,
        riskReason
      }
    },
    { upsert: true, new: true }
  );
}

async function creditReferralAfterFirstTranscript(user, qualifyingWords = 0) {
  if (!user?.referredBy) return false;
  // A referral reward requires a meaningful first transcript, not a tiny caption stub.
  if (Number(qualifyingWords || 0) < 50) return false;
  // Give the new account a short cooling-off period before it can generate a reward.
  if (user.createdAt && Date.now() - new Date(user.createdAt).getTime() < 10 * 60 * 1000) return false;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const referrer = await User.findOne({ referralCode: String(user.referredBy).toUpperCase() }).select("email signupIpHash signupUaHash lastSeenIpHash lastSeenUaHash").lean();
  const referrerEmail = referrer?.email?.toLowerCase();
  if (!referrerEmail) return false;

  const monthlyEarned = await Referral.countDocuments({
    referrerEmail,
    status: "credited",
    creditedAt: { $gte: monthStart }
  });
  if (monthlyEarned >= 5) return false;

  const referral = await Referral.findOneAndUpdate(
    { referredEmail: user.email.toLowerCase(), status: "pending" },
    { $set: { status: "credited", creditedAt: new Date() } },
    { new: true }
  );
  if (!referral) return false;

  await User.findOneAndUpdate(
    { email: referral.referrerEmail },
    { $inc: { referralCuts: 1, referralsCount: 1 } }
  );
  return true;
}


app.get("/ref/:code", async (req, res) => {
  const limit = checkReferralCodeLimit(req);
  if (!limit.allowed) return res.status(429).send("Too many referral-link attempts. Please try again later.");
  const code = String(req.params.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return res.redirect("/login.html");
  const referrer = await User.findOne({ referralCode: code }).select("_id").lean();
  if (!referrer) return res.redirect("/login.html");
  req.session.referralCode = code;
  req.session.referralLandingFp = requestFingerprints(req);
  res.redirect("/login.html?ref=" + encodeURIComponent(code));
});

app.get("/referral", requireAuth, async (req, res) => {
  try {
    const user = await User.findOne({ email: req.authEmail });
    if (!user) return res.status(404).json({ success: false, error: "User not found." });
    const fp = requestFingerprints(req);
    await User.updateOne({ _id: user._id }, { $set: { lastSeenIpHash: fp.ipHash, lastSeenUaHash: fp.uaHash } });
    const code = await ensureReferralCode(user);
    const base = process.env.PUBLIC_SITE_URL || "https://reelscribe.site";
    const activity = await Referral.find({ referrerEmail: user.email.toLowerCase() })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthlyEarned = await Referral.countDocuments({
      referrerEmail: user.email.toLowerCase(), status: "credited", creditedAt: { $gte: monthStart }
    });
    res.json({
      success: true,
      referralCode: code,
      referralLink: `${base.replace(/\/$/, "")}/ref/${code}`,
      referralsCount: user.referralsCount || 0,
      referralCuts: user.referralCuts || 0,
      pending: activity.filter(r => r.status !== "credited").length,
      earned: activity.filter(r => r.status === "credited").length,
      monthlyEarned,
      monthlyCap: 5,
      activity: activity.map(r => ({
        name: r.referredEmail.split("@")[0],
        date: new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
        status: r.status === "credited" ? "done" : r.status === "rejected" ? "rejected" : "pending"
      }))
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

function getYouTubeVideoId(url) {
  const patterns = [
    /youtube\.com\/watch\?v=([^&]+)/,
    /youtu\.be\/([^?]+)/,
    /youtube\.com\/shorts\/([^?]+)/,
    /youtube\.com\/embed\/([^?]+)/,
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

function isValidYouTubeUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return /^\/[A-Za-z0-9_-]{6,20}$/.test(u.pathname);
    if (host !== "youtube.com" && host !== "m.youtube.com") return false;
    if (u.pathname === "/watch") return /^[A-Za-z0-9_-]{6,20}$/.test(u.searchParams.get("v") || "");
    return /^\/(shorts|embed)\/[A-Za-z0-9_-]{6,20}$/.test(u.pathname);
  } catch { return false; }
}

function isValidInstagramUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!["instagram.com", "m.instagram.com"].includes(host)) return false;
    return /^\/(reel|reels|p|tv)\/[A-Za-z0-9_-]+/.test(u.pathname);
  } catch { return false; }
}

async function getYouTubeDurationSeconds(url) {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) return null;
  try {
    const { data: html } = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    });
    const match = html.match(/"lengthSeconds":"(\d+)"/);
    return match ? parseInt(match[1], 10) : null;
  } catch (e) {
    console.error("YouTube duration fetch failed:", e.message);
    return null;
  }
}

async function checkTranscriptLimit(user) {
  const plan   = getEffectivePlan(user);
  const limits = PLAN_LIMITS[plan];

  let usedDay   = user.transcriptsUsedToday  || 0;
  let usedMonth = user.transcriptsUsedMonth  || 0;

  if (isNewDay(user.lastTranscriptDate))       usedDay   = 0;
  if (isNewMonth(user.lastTranscriptResetDate)) usedMonth = 0;

  if (usedDay >= limits.transcriptDay)
    return { allowed: false, error: `Daily limit reached (${limits.transcriptDay}/day). Come back tomorrow or upgrade your plan.` };
  if (usedMonth >= limits.transcriptMonth)
    return { allowed: false, error: `Monthly limit reached (${limits.transcriptMonth}/month). Upgrade your plan for more.` };

  return { allowed: true };
}

async function updateTranscriptUsage(user) {
  const now = new Date();
  const resetDay   = isNewDay(user.lastTranscriptDate);
  const resetMonth = isNewMonth(user.lastTranscriptResetDate);

  await User.findByIdAndUpdate(user._id, {
    transcriptsUsedToday:    resetDay   ? 1 : (user.transcriptsUsedToday || 0) + 1,
    transcriptsUsedMonth:    resetMonth ? 1 : (user.transcriptsUsedMonth || 0) + 1,
    lastTranscriptDate:      now,
    lastTranscriptResetDate: resetMonth ? now : user.lastTranscriptResetDate,
  });
}

app.get("/internal/user-limits/:email", internalAuth, async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true, user, effectivePlan: getEffectivePlan(user) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/internal/update-usage", internalAuth, async (req, res) => {
  try {
    const { email, type } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Invalid email" });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false });

    const now        = new Date();
    const resetDay   = isNewDay(user.lastClipDate);
    const resetMonth = isNewMonth(user.lastClipDate);

    if (type === "clip") {
      await User.findByIdAndUpdate(user._id, {
        clipsUsedToday:  resetDay   ? 1 : (user.clipsUsedToday || 0) + 1,
        clipsUsedMonth:  resetMonth ? 1 : (user.clipsUsedMonth || 0) + 1,
        lastClipDate:    now,
      });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/auth/google", (req, res, next) => {
  const next_ = req.query.next;
  const dest = (typeof next_ === "string" && next_.startsWith("/")) ? next_ : "/dashboard.html";
  const referralCode = req.session.referralCode || "";
  const state = JSON.stringify({ dest, referralCode });
  passport.authenticate("google", { scope: ["profile", "email"], state })(req, res, next);
});
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  async (req, res) => {
    req.session.userEmail = req.user.email;
    User.updateOne({ _id: req.user._id }, { $set: { lastActiveAt: new Date(), lastSeenIpHash: requestFingerprints(req).ipHash, lastSeenUaHash: requestFingerprints(req).uaHash } }).catch(() => {});
    let dest = "/dashboard.html";
    try {
      const parsed = JSON.parse(String(req.query.state || "{}"));
      if (typeof parsed.dest === "string" && parsed.dest.startsWith("/")) dest = parsed.dest;
    } catch (e) {
      const state_ = req.query.state;
      if (typeof state_ === "string" && state_.startsWith("/")) dest = state_;
    }
    delete req.session.referralCode;
    const sep = dest.includes("?") ? "&" : "?";
    res.redirect(dest + sep + "email=" + encodeURIComponent(req.user.email));
  }
);

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/me", (req, res) => {
  const email = getSessionEmail(req);
  res.json({ success: true, loggedIn: !!email, email: email || null });
});

app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Valid email required" });

    const sendLimit = checkOtpSendLimit(email);
    if (!sendLimit.allowed) return res.status(429).json({ success: false, message: sendLimit.error });

    const otp = crypto.randomInt(100000, 1000000).toString();
    otpStore[email] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

    await resend.emails.send({
      from:    "ReelScribe <noreply@reelscribe.site>",
      to:      email,
      subject: "Your ReelScribe OTP",
      html: `
      <div style="font-family:Inter,sans-serif;background:#09070f;padding:32px;border-radius:16px;max-width:480px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#8b5cf6,#ec4899);border-radius:16px;padding:32px;text-align:center;">
          <h1 style="color:white;font-size:24px;font-weight:900;margin:0 0 8px;">ReelScribe</h1>
          <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:0 0 28px;">Your One-Time Password</p>
          <div style="background:white;border-radius:10px;padding:16px;display:inline-block;">
            <span style="font-size:36px;font-weight:900;letter-spacing:8px;color:#8b5cf6;">${otp}</span>
          </div>
          <p style="color:rgba(255,255,255,0.6);font-size:12px;margin:12px 0 0;">Valid for 5 minutes only</p>
        </div>
      </div>`,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Valid email required" });

    const verifyLimit = checkOtpVerifyLimit(email);
    if (!verifyLimit.allowed) return res.status(429).json({ success: false, message: verifyLimit.error });

    const record = otpStore[email];
    if (!record)                    return res.status(400).json({ success: false, message: "OTP not found" });
    if (Date.now() > record.expiresAt) { delete otpStore[email]; return res.status(400).json({ success: false, message: "OTP expired" }); }
    if (record.otp !== otp)         return res.status(400).json({ success: false, message: "Invalid OTP" });

    delete otpStore[email];
    delete otpVerifyAttempts[email];
    let user = await User.findOne({ email });
    if (!user) {
      const referralCode = req.session.referralCode || null;
      const fp = requestFingerprints(req);
      const emailIdentity = normalizeEmailIdentity(email);
      // Prevent Gmail dot/plus aliases from creating a second referral-eligible account.
      if (await hasEmailIdentityConflict(email)) return res.status(409).json({ success: false, message: "An account already exists for this email identity. Please log in instead." });
      user = await User.create({ name: email.split("@")[0], email, credits: 5, referredBy: referralCode, emailIdentity, signupIpHash: fp.ipHash, signupUaHash: fp.uaHash });
      if (referralCode) await createReferralRecord(referralCode, email, req);
      delete req.session.referralCode;
    }

    req.session.userEmail = email;
    const fp = requestFingerprints(req);
    await User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date(), lastSeenIpHash: fp.ipHash, lastSeenUaHash: fp.uaHash } });

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/transcribe", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file was uploaded." });

    const email   = getSessionEmail(req);
    const user    = email ? await User.findOne({ email }) : null;
    const isGuest = !user;

    if (isGuest) {
      const { allowed } = await checkGuestLimit(req);
      if (!allowed) {
        if (req.file?.path) fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, loginRequired: true, forceLogin: true, error: "You've used all 3 free previews. Please log in to continue." });
      }
    } else {
      const limitCheck = await checkTranscriptLimit(user);
      if (!limitCheck.allowed) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, error: limitCheck.error });
      }
    }

    const transcription = await groq.audio.transcriptions.create({
      file:  fs.createReadStream(req.file.path),
      model: "whisper-large-v3-turbo",
    });

    if (!isGuest) {
      await updateTranscriptUsage(user);
      await creditReferralAfterFirstTranscript(user, transcription.text.split(/\s+/).filter(Boolean).length);
      await Reel.create({ userEmail: email, reelUrl: req.file.originalname, transcript: transcription.text });
    }

    fs.unlinkSync(req.file.path);

    const words    = transcription.text.split(/\s+/);
    const isPreview = isGuest && words.length > 100;

    res.json({
      success:     true,
      transcript:  isGuest ? words.slice(0, 100).join(" ") : transcription.text,
      isGuest,
      isPreview,
      totalWords:  words.length,
      creditsLeft: user ? user.credits : 0,
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/transcribe-url", async (req, res) => {
  const { url } = req.body;
  if (typeof url !== "string" || !url)
    return res.status(400).json({ success: false, error: "Please provide a video URL." });

  const isYouTube = isValidYouTubeUrl(url);
  const isInstagram = isValidInstagramUrl(url);
  if (!isYouTube && !isInstagram)
    return res.status(400).json({ success: false, error: "Only valid YouTube and Instagram URLs are supported." });

  const email   = getSessionEmail(req);
  const user    = email ? await User.findOne({ email }) : null;
  const isGuest = !user;

  if (isGuest) {
    const { allowed } = await checkGuestLimit(req);
    if (!allowed) return res.status(403).json({ success: false, loginRequired: true, forceLogin: true, error: "You've used all 3 free previews. Please log in to continue." });
  } else {
    const limitCheck = await checkTranscriptLimit(user);
    if (!limitCheck.allowed) return res.status(403).json({ success: false, error: limitCheck.error });
  }

  function buildResponse(fullTranscript, source) {
    const words     = fullTranscript.split(/\s+/);
    const isPreview = isGuest && words.length > 100;
    return {
      success:     true,
      transcript:  isGuest ? words.slice(0, 100).join(" ") : fullTranscript,
      isGuest, isPreview,
      totalWords:  words.length,
      creditsLeft: isGuest ? 0 : user.credits,
      source,
    };
  }

  if (isYouTube) {
    try {
      const videoId = getYouTubeVideoId(url);
      if (!videoId) return res.status(400).json({ success: false, error: "Invalid YouTube URL" });

      const transcriptArr = await YoutubeTranscript.fetchTranscript(videoId);
      if (!transcriptArr?.length)
        return res.status(400).json({ success: false, error: "This video doesn't have any captions available." });

      const transcript = transcriptArr.map(i => i.text).join(" ").replace(/\s+/g, " ").trim();

      if (!isGuest) {
        await updateTranscriptUsage(user);
        await creditReferralAfterFirstTranscript(user, transcript.split(/\s+/).filter(Boolean).length);
        await Reel.create({ userEmail: email, reelUrl: url, transcript });
      }

      return res.json(buildResponse(transcript, "youtube-captions"));
    } catch (error) {
      return res.status(500).json({ success: false, error: "Couldn't fetch the YouTube transcript: " + error.message });
    }
  }

  const outputPath = path.join(__dirname, "uploads", `${Date.now()}_insta.mp4`);
  try {
    const videoUrl = await getInstagramVideoUrl(url);
    await downloadVideo(videoUrl, outputPath);

    const transcription = await groq.audio.transcriptions.create({
      file:  fs.createReadStream(outputPath),
      model: "whisper-large-v3-turbo",
    });

    if (!isGuest) {
      await updateTranscriptUsage(user);
      await creditReferralAfterFirstTranscript(user, transcription.text.split(/\s+/).filter(Boolean).length);
      await Reel.create({ userEmail: email, reelUrl: url, transcript: transcription.text });
    }

    fs.unlinkSync(outputPath);
    return res.json(buildResponse(transcription.text, "groq-whisper"));
  } catch (error) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return res.status(500).json({ success: false, error: "Couldn't fetch that Instagram video: " + error.message });
  }
});

async function checkClipLimit(user) {
  const plan   = getEffectivePlan(user);
  const limits = PLAN_LIMITS[plan];

  let usedDay   = user.clipsUsedToday || 0;
  let usedMonth = user.clipsUsedMonth || 0;

  if (isNewDay(user.lastClipDate))   usedDay   = 0;
  if (isNewMonth(user.lastClipDate)) usedMonth = 0;

  if (usedDay >= limits.clipDay)
    return { allowed: false, error: `Daily clip limit reached (${limits.clipDay}/day). Come back tomorrow or upgrade your plan.` };
  if (usedMonth >= limits.clipMonth)
    return { allowed: false, error: `Monthly clip limit reached (${limits.clipMonth}/month). Upgrade your plan for more.` };

  return { allowed: true };
}

async function updateClipUsage(user) {
  const now        = new Date();
  const resetDay   = isNewDay(user.lastClipDate);
  const resetMonth = isNewMonth(user.lastClipDate);

  await User.findByIdAndUpdate(user._id, {
    clipsUsedToday: resetDay   ? 1 : (user.clipsUsedToday || 0) + 1,
    clipsUsedMonth: resetMonth ? 1 : (user.clipsUsedMonth || 0) + 1,
    lastClipDate:   now,
  });
}

const clipJobs = new Map();

function scheduleJobCleanup(jobId) {
  setTimeout(() => clipJobs.delete(jobId), 30 * 60 * 1000);
}

app.get("/clip-status/:jobId", requireAuth, (req, res) => {
  const job = clipJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: "Job not found or expired" });
  if (job.email !== req.authEmail) return res.status(403).json({ success: false, error: "You do not have access to this job." });
  const { email, ...safeJob } = job;
  res.json({ success: true, ...safeJob });
});

app.post("/cut-clips", requireAuth, async (req, res) => {
  const { ytUrl, fcmToken, captionSettings } = req.body;
  const email = req.authEmail;

  if (!isValidYouTubeUrl(ytUrl)) return res.status(400).json({ success: false, error: "Please provide a valid YouTube URL." });

  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ success: false, loginRequired: true, error: "Account not found. Please log in again." });

  const plan = getEffectivePlan(user);
  const referralAvailable = (user.referralCuts || 0) > 0;
  let useReferral = false;

  if (plan === "free") {
    if (!referralAvailable)
      return res.status(403).json({ success: false, error: "Clips aren't available on the free plan. Refer a friend to earn 1 free cut, or upgrade to continue." });
    useReferral = true;
  } else {
    const limitCheck = await checkClipLimit(user);
    if (!limitCheck.allowed) {
      if (!referralAvailable) return res.status(403).json({ success: false, error: limitCheck.error });
      useReferral = true;
    }
  }

  const processingPlan = useReferral ? "starter" : plan;
  const maxMinutes = PLAN_LIMITS[processingPlan].maxVideoMinutes;
  const durationSec = await getYouTubeDurationSeconds(ytUrl);
  if (durationSec !== null && durationSec > maxMinutes * 60) {
    const videoMinutes = Math.ceil(durationSec / 60);
    return res.status(403).json({
      success: false,
      error: `This video is ${videoMinutes} min long. The ${useReferral ? "referral cut" : processingPlan + " plan"} supports videos up to ${maxMinutes} min. Try a shorter video or upgrade your plan.`,
    });
  }

  const jobId = crypto.randomUUID();
  clipJobs.set(jobId, { status: "processing", email });
  res.json({ success: true, jobId });

  (async () => {
    try {
      const ec2Response = await axios.post(
        `${EC2_URL}/analyze-video`,
        { url: ytUrl, captionSettings, plan: processingPlan, referralCut: useReferral, watermark: useReferral },
        { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 900000 }
      );

      if (!ec2Response.data?.success) {
        clipJobs.set(jobId, { status: "error", error: ec2Response.data?.error || "Clip generation failed. Please try again." });
        return scheduleJobCleanup(jobId);
      }

      const clips = ec2Response.data.clips || [];
      if (useReferral && clips.length > 0) {
        const consumed = await User.findOneAndUpdate(
          { _id: user._id, referralCuts: { $gt: 0 } },
          { $inc: { referralCuts: -1 } },
          { new: true }
        );
        if (!consumed) {
          // A concurrent request used the last reward; don't silently grant a free cut.
          await axios.post(`${EC2_URL}/delete-clips`, { keys: clips.map(c => c.s3Key).filter(Boolean) },
            { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 30000 }).catch(() => {});
          clipJobs.set(jobId, { status: "error", error: "Your referral cut was already used. Please try again." });
          return scheduleJobCleanup(jobId);
        }
      } else if (!useReferral) {
        await updateClipUsage(user);
      }
      clipJobs.set(jobId, { status: "done", clips });
      scheduleJobCleanup(jobId);

      if (clips.length > 0) {
        await ClipJob.create({
          userEmail: email,
          ytUrl,
          ytTitle: ec2Response.data.videoTitle || "",
          clips: clips.map(c => ({
            title: c.title, reason: c.reason, duration: c.duration,
            url: c.url, s3Key: c.s3Key
          }))
        });
      }
    } catch (err) {
      const errMsg = err.response?.data?.error || err.message;
      clipJobs.set(jobId, { status: "error", error: "Clip generation failed: " + errMsg });
      scheduleJobCleanup(jobId);
    }
  })();
});

app.get("/clip-history", requireAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const jobs = await ClipJob.find({
      userEmail: req.authEmail,
      createdAt: { $gte: since }
    }).sort({ createdAt: -1 });

    const data = jobs
      .map(j => ({
        _id: j._id,
        ytUrl: j.ytUrl,
        ytTitle: j.ytTitle,
        createdAt: j.createdAt,
        clips: j.clips.filter(c => !c.deleted)
      }))
      .filter(j => j.clips.length > 0);

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/clip-downloaded", requireAuth, async (req, res) => {
  const { s3Key } = req.body;
  if (!s3Key) return res.status(400).json({ success: false, error: "Missing clip reference." });

  const owned = await ClipJob.findOne({ userEmail: req.authEmail, "clips.s3Key": s3Key });
  if (!owned) return res.status(404).json({ success: false, error: "Clip not found." });

  res.json({ success: true });

  try {
    await ClipJob.updateOne(
      { "clips.s3Key": s3Key },
      { $set: { "clips.$.downloaded": true, "clips.$.downloadedAt": new Date() } }
    );
  } catch (e) {}

  setTimeout(async () => {
    try {
      await axios.post(`${EC2_URL}/delete-clips`, { keys: [s3Key] },
        { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 30000 });
      await ClipJob.updateOne(
        { "clips.s3Key": s3Key },
        { $set: { "clips.$.deleted": true } }
      );
    } catch (e) {}
  }, 5 * 60 * 1000);
});

async function runClipCleanupSweep() {
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

    const jobs = await ClipJob.find({
      $or: [
        { createdAt: { $lt: dayAgo } },
        { "clips.downloaded": true, "clips.downloadedAt": { $lt: fiveMinAgo }, "clips.deleted": { $ne: true } }
      ]
    });

    const keysToDelete = [];
    for (const job of jobs) {
      const jobExpired = job.createdAt < dayAgo;
      for (const clip of job.clips) {
        if (clip.deleted) continue;
        const downloadExpired = clip.downloaded && clip.downloadedAt && clip.downloadedAt < fiveMinAgo;
        if (jobExpired || downloadExpired) keysToDelete.push(clip.s3Key);
      }
    }

    if (keysToDelete.length > 0) {
      await axios.post(`${EC2_URL}/delete-clips`, { keys: keysToDelete },
        { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 60000 });

      await ClipJob.updateMany(
        { "clips.s3Key": { $in: keysToDelete } },
        { $set: { "clips.$[c].deleted": true } },
        { arrayFilters: [{ "c.s3Key": { $in: keysToDelete } }] }
      );
    }

    await ClipJob.deleteMany({ createdAt: { $lt: dayAgo } });
  } catch (e) {
    console.error("Clip cleanup sweep failed:", e.message);
  }
}
setInterval(runClipCleanupSweep, 15 * 60 * 1000);


function normalizeCoupon(c) {
  if (!c) return null;
  return {
    code: c.code,
    percent: Number(c.discountPercent || c.percent || 0),
    plan: Array.isArray(c.appliesToPlans) && c.appliesToPlans.includes("all")
      ? "all" : (c.appliesToPlans?.[0] || "all"),
    expiresAt: c.expiresAt,
    active: !!c.active,
    maxUses: Number(c.maxUses || 0),
    usedCount: Number(c.usedCount || 0)
  };
}

async function getValidCoupon(code, email, plan) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return { coupon: null, discount: 0 };

  const coupon = await Coupon.findOne({ code: clean });
  if (!coupon) throw new Error("Invalid coupon code.");
  if (!coupon.active) throw new Error("This coupon is no longer active.");
  if (coupon.expiresAt && new Date(coupon.expiresAt) <= new Date()) throw new Error("This coupon has expired.");
  if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses) throw new Error("This coupon has reached its usage limit.");

  const plans = Array.isArray(coupon.appliesToPlans) ? coupon.appliesToPlans : ["all"];
  if (!plans.includes("all") && !plans.includes(plan)) throw new Error(`This coupon is not valid for the ${plan} plan.`);

  if (coupon.singleUsePerUser) {
    const already = await CouponRedemption.exists({ code: clean, email: String(email).toLowerCase() });
    if (already) throw new Error("You have already used this coupon.");
  }
  return { coupon, discount: Number(coupon.discountPercent || 0) };
}

const PLAN_PRICING = {
  starter: { m: 149, y: 124 },
  pro:     { m: 299, y: 249 },
  agency:  { m: 599, y: 499 }
};

app.post("/validate-coupon", requireAuth, async (req, res) => {
  try {
    const { code, plan, billing } = req.body;
    if (!PLAN_PRICING[plan]) return res.status(400).json({ success: false, error: "Invalid plan." });
    const originalAmount = billing === "yearly" ? PLAN_PRICING[plan].y * 12 : PLAN_PRICING[plan].m;
    const { coupon, discount } = await getValidCoupon(code, req.authEmail, plan);
    const discountAmount = coupon ? Math.round(originalAmount * discount) / 100 : 0;
    const finalAmount = Math.max(1, Math.round((originalAmount - discountAmount) * 100) / 100);
    res.json({ success: true, coupon: normalizeCoupon(coupon), originalAmount, discountAmount, finalAmount });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || "Invalid coupon." });
  }
});

app.post("/create-order", requireAuth, async (req, res) => {
  try {
    const { plan, billing, couponCode } = req.body;
    const email = req.authEmail;
    if (!PLAN_PRICING[plan]) return res.status(400).json({ success: false, error: "Invalid plan." });

    const isYearly = billing === "yearly";
    const originalAmount = isYearly ? PLAN_PRICING[plan].y * 12 : PLAN_PRICING[plan].m;
    const { coupon, discount } = await getValidCoupon(couponCode, email, plan);
    const discountAmount = coupon ? Math.round(originalAmount * discount) / 100 : 0;
    const finalAmount = Math.max(1, Math.round((originalAmount - discountAmount) * 100) / 100);

    const order = await razorpay.orders.create({
      amount: Math.round(finalAmount * 100),
      currency: "INR",
      receipt: `receipt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      notes: {
        plan,
        billing: isYearly ? "yearly" : "monthly",
        email,
        couponCode: coupon?.code || "",
        originalAmount: String(originalAmount),
        discountAmount: String(discountAmount),
        finalAmount: String(finalAmount)
      },
    });

    res.json({
      success: true,
      order,
      key: process.env.RAZORPAY_KEY_ID,
      pricing: { originalAmount, discountAmount, finalAmount },
      coupon: normalizeCoupon(coupon)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || "Could not create the order." });
  }
});

app.post("/verify-payment", requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (typeof razorpay_order_id !== "string" || typeof razorpay_payment_id !== "string" || typeof razorpay_signature !== "string")
      return res.status(400).json({ success: false, error: "We could not verify this payment. Please contact support." });

    const expectedSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    const receivedBuf = Buffer.from(razorpay_signature, "hex");

    if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf))
      return res.status(400).json({ success: false, error: "Payment verification failed. Please contact support if the amount was deducted." });

    const order = await razorpay.orders.fetch(razorpay_order_id);
    if (!order || order.status !== "paid")
      return res.status(400).json({ success: false, error: "This order has not been paid yet." });

    const plan    = order.notes?.plan;
    const billing = order.notes?.billing;
    const email   = order.notes?.email;

    if (!isValidEmail(email))
      return res.status(400).json({ success: false, error: "We could not verify who this order belongs to. Please contact support." });
    if (email.toLowerCase() !== req.authEmail.toLowerCase())
      return res.status(403).json({ success: false, error: "This payment belongs to a different account." });

    // Payment verification must be idempotent. A second callback for the same
    // Razorpay order should never extend the subscription twice.
    const alreadyPaid = await Payment.findOne({ razorpayOrderId: razorpay_order_id }).lean();
    if (alreadyPaid) {
      // A retry after a transient database failure should still leave the user
      // on the plan that was actually paid for, but must not extend it twice.
      const existingUser = await User.findOne({ email }).select("plan planExpiresAt").lean();
      if (existingUser && (!existingUser.planExpiresAt || new Date(existingUser.planExpiresAt) < new Date(alreadyPaid.createdAt))) {
        const repairedExpiry = new Date(alreadyPaid.createdAt);
        if (alreadyPaid.billingCycle === "yearly") repairedExpiry.setFullYear(repairedExpiry.getFullYear() + 1);
        else repairedExpiry.setMonth(repairedExpiry.getMonth() + 1);
        await User.updateOne({ email }, { $set: { plan: alreadyPaid.plan, lastPaidPlan: alreadyPaid.plan, billingCycle: alreadyPaid.billingCycle, planExpiresAt: repairedExpiry } });
      }
      return res.json({ success: true, alreadyProcessed: true, message: "Payment was already processed.", plan: alreadyPaid.plan });
    }

    const validPlans = ["starter", "pro", "agency"];
    if (!validPlans.includes(plan))
      return res.status(400).json({ success: false, error: "Invalid plan" });

    const isYearly = billing === "yearly";
    const planExpiry = new Date();
    if (isYearly) {
      planExpiry.setFullYear(planExpiry.getFullYear() + 1);
    } else {
      planExpiry.setMonth(planExpiry.getMonth() + 1);
    }
    const originalAmount = isYearly ? PLAN_PRICING[plan].y * 12 : PLAN_PRICING[plan].m;
    const couponCode = String(order.notes?.couponCode || "").trim().toUpperCase();
    const discountAmount = Math.max(0, Number(order.notes?.discountAmount || 0));
    const finalAmount = Math.max(1, Number(order.notes?.finalAmount || originalAmount));

    if (Math.round(Number(order.amount) / 100 * 100) !== Math.round(finalAmount * 100))
      return res.status(400).json({ success: false, error: "Paid amount does not match this order." });

    const existingAccount = await User.findOne({ email }).select("_id").lean();
    if (!existingAccount) return res.status(404).json({ success: false, error: "User account not found. Please log in again." });

    // Record the payment first. The unique order id makes this operation safe
    // against duplicate browser callbacks/races.
    let paymentRecord;
    try {
      paymentRecord = await Payment.create({
        userEmail: email,
        plan,
        billingCycle: isYearly ? "yearly" : "monthly",
        amount: finalAmount,
        originalAmount,
        discountAmount,
        couponCode: couponCode || null,
        status: "paid",
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
      });
    } catch (paymentErr) {
      if (paymentErr?.code === 11000) {
        return res.json({ success: true, alreadyProcessed: true, message: "Payment was already processed.", plan });
      }
      throw paymentErr;
    }

    const user = await User.findOneAndUpdate(
      { email },
      {
        plan,
        lastPaidPlan:            plan,
        billingCycle:            isYearly ? "yearly" : "monthly",
        planExpiresAt:           planExpiry,
        transcriptsUsedToday:    0,
        transcriptsUsedMonth:    0,
        clipsUsedToday:          0,
        clipsUsedMonth:          0,
        lastTranscriptDate:      null,
        lastTranscriptResetDate: null,
        lastClipDate:            null,
      },
      { new: true }
    );

    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    if (couponCode) {
      const existingRedemption = await CouponRedemption.findOne({ orderId: razorpay_order_id });
      if (!existingRedemption) {
        await CouponRedemption.create({
          code: couponCode,
          email: email.toLowerCase(),
          plan,
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          discount: discountAmount,
          originalAmount,
          finalAmount
        });
        await Coupon.updateOne(
          { code: couponCode },
          { $inc: { usedCount: 1 }, $addToSet: { usedBy: email.toLowerCase() } }
        );
      }
    }

    res.json({ success: true, message: `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan activated successfully!`, plan, planExpiresAt: planExpiry });
  } catch (err) {
    res.status(500).json({ success: false, error: "Something went wrong while verifying your payment. Please contact support." });
  }
});

app.get("/user-plan", requireAuth, async (req, res) => {
  try {
    const user = await User.findOne({ email: req.authEmail });
    if (!user) return res.status(404).json({ success: false });

    const plan   = getEffectivePlan(user);
    const limits = PLAN_LIMITS[plan];

    const transcriptDay   = isNewDay(user.lastTranscriptDate)       ? 0 : (user.transcriptsUsedToday || 0);
    const transcriptMonth = isNewMonth(user.lastTranscriptResetDate) ? 0 : (user.transcriptsUsedMonth || 0);
    const clipDay         = isNewDay(user.lastClipDate)              ? 0 : (user.clipsUsedToday || 0);
    const clipMonth       = isNewMonth(user.lastClipDate)            ? 0 : (user.clipsUsedMonth || 0);

    res.json({
      success: true,
      plan,
      rawPlan: user.plan || "free",
      planExpired: (user.plan && user.plan !== "free") && plan === "free",
      planExpiresAt: user.planExpiresAt,
      usage: {
        transcriptDay,   transcriptDayLimit:   limits.transcriptDay,
        transcriptMonth, transcriptMonthLimit: limits.transcriptMonth,
        clipDay,         clipDayLimit:         limits.clipDay,
        clipMonth,       clipMonthLimit:       limits.clipMonth,
      },
      referralCuts: user.referralCuts || 0,
      referralsCount: user.referralsCount || 0,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/history", requireAuth, async (req, res) => {
  try {
    const reels = await Reel.find({ userEmail: req.authEmail }).sort({ createdAt: -1 });
    res.json({ success: true, data: reels });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

function logAdminAction(action, targetEmail, details, req) {
  AdminLog.create({ action, targetEmail: targetEmail || null, details: details || "", ip: req.ip || "" })
    .catch(() => {});
}

app.post("/admin/login", (req, res) => {
  const ip  = req.ip || "unknown";
  const now = Date.now();
  const rec = adminAuthAttempts[ip];

  if (rec?.blockedUntil && now < rec.blockedUntil) {
    const waitMin = Math.ceil((rec.blockedUntil - now) / 60000);
    return res.status(429).json({ success: false, error: `Too many incorrect attempts. Please try again in ${waitMin} minute${waitMin === 1 ? "" : "s"}.` });
  }

  if (!process.env.ADMIN_SECRET || req.body?.key !== process.env.ADMIN_SECRET) {
    if (!rec || now - rec.windowStart > ADMIN_WINDOW_MS) {
      adminAuthAttempts[ip] = { count: 1, windowStart: now, blockedUntil: null };
    } else {
      rec.count++;
      if (rec.count >= ADMIN_MAX_ATTEMPTS) rec.blockedUntil = now + ADMIN_BLOCK_MS;
    }
    return res.status(401).json({ success: false, error: "Incorrect key." });
  }

  delete adminAuthAttempts[ip];
  req.session.isAdmin = true;
  logAdminAction("login", null, "Admin logged in", req);
  res.json({ success: true });
});

app.post("/admin/logout", adminAuth, (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

app.get("/admin/stats", adminAuth, async (req, res) => {
  try {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek   = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [totalUsers, newToday, newThisWeek, planCounts] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfToday } }),
      User.countDocuments({ createdAt: { $gte: startOfWeek } }),
      User.aggregate([
        { $project: { effectivePlan: { $cond: [
          { $or: [
            { $eq: [{ $ifNull: ["$plan", "free"] }, "free"] },
            { $and: [
              { $ne: [{ $ifNull: ["$plan", "free"] }, "free"] },
              { $ne: ["$planExpiresAt", null] },
              { $lt: ["$planExpiresAt", new Date()] }
            ] }
          ] },
          "free", { $ifNull: ["$plan", "free"] }
        ] } } },
        { $group: { _id: "$effectivePlan", count: { $sum: 1 } } }
      ]),
    ]);

    const byPlan = { free: 0, starter: 0, pro: 0, agency: 0 };
    planCounts.forEach(p => { if (byPlan[p._id] !== undefined) byPlan[p._id] = p.count; });

    res.json({ success: true, totalUsers, newToday, newThisWeek, byPlan });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/admin/revenue", adminAuth, async (req, res) => {
  try {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

    const [totalAgg, monthAgg, todayAgg, paidEmails] = await Promise.all([
      Payment.aggregate([{ $match: { status: "paid" } }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
      Payment.aggregate([{ $match: { status: "paid", createdAt: { $gte: startOfMonth } } }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
      Payment.aggregate([{ $match: { status: "paid", createdAt: { $gte: startOfToday } } }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
      Payment.distinct("userEmail", { status: "paid" }),
    ]);

    // "Paid → Free conversions": users who have paid at least once but are
    // currently back on the free plan.
    const paidToFreeConversions = await User.countDocuments({
      email: { $in: paidEmails },
      $or: [
        { plan: "free" },
        { plan: { $in: ["starter", "pro", "agency"] }, planExpiresAt: { $lt: new Date(), $ne: null } }
      ]
    });

    res.json({
      success: true,
      totalRevenue: totalAgg[0]?.sum || 0,
      monthRevenue: monthAgg[0]?.sum || 0,
      todayRevenue: todayAgg[0]?.sum || 0,
      paidToFreeConversions,
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/admin/logs", adminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));

    const [logs, total] = await Promise.all([
      AdminLog.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      AdminLog.countDocuments(),
    ]);

    res.json({ success: true, data: logs, page, totalPages: Math.max(1, Math.ceil(total / limit)), total });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/admin/users", adminAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const search = (req.query.search || "").trim();

    const filter = {};
    if (search) filter.email = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    if (["free","starter","pro","agency"].includes(req.query.plan)) filter.plan = req.query.plan;
    if (req.query.status === "active") filter.isSuspended = false;
    if (req.query.status === "suspended") filter.isSuspended = true;
    const now = new Date();
    if (req.query.joined === "today") { const d = new Date(now); d.setHours(0,0,0,0); filter.createdAt = { $gte: d }; }
    if (req.query.joined === "7d") filter.createdAt = { $gte: new Date(Date.now() - 7*86400000) };
    if (req.query.joined === "30d") filter.createdAt = { $gte: new Date(Date.now() - 30*86400000) };
    if (req.query.quick === "paid") filter.$and = [{ plan: { $in: ["starter","pro","agency"] } }, { planExpiresAt: { $gte: now } }];
    if (req.query.quick === "free") filter.$or = [{ plan: "free" }, { plan: { $in: ["starter","pro","agency"] }, planExpiresAt: { $lt: now, $ne: null } }];
    if (req.query.quick === "expiring") filter.$and = [{ plan: { $in: ["starter","pro","agency"] } }, { planExpiresAt: { $gte: now, $lte: new Date(Date.now()+7*86400000) } }];
    if (req.query.quick === "churned") filter.$and = [{ plan: "free" }, { $or: [{ lastPaidPlan: { $in: ["starter","pro","agency"] } }, { planExpiresAt: { $lt: now, $ne: null } }] }];


    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
    ]);
    const data = users.map(u => ({
      ...u,
      rawPlan: u.plan || "free",
      plan: getEffectivePlan(u)
    }));

    res.json({ success: true, data, page, totalPages: Math.max(1, Math.ceil(total / limit)), total });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/admin/add-credit", adminAuth, async (req, res) => {
  try {
    const { email, credits } = req.body;
    if (!isValidEmail(email) || !credits) return res.status(400).json({ success: false, error: "A valid email and credit amount are required." });
    const user = await User.findOneAndUpdate({ email }, { $inc: { credits: parseInt(credits) } }, { new: true });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    logAdminAction("add-credit", email, `Added ${credits} credits (new total: ${user.credits})`, req);
    res.json({ success: true, message: `${credits} credits added successfully.`, user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/admin/set-plan", adminAuth, async (req, res) => {
  try {
    const { email, plan, durationDays } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Valid email required" });

    const validPlans = ["free", "starter", "pro", "agency"];
    if (!validPlans.includes(plan)) return res.status(400).json({ success: false, error: "Invalid plan" });

    let planExpiry = null;
    const update = {
      plan,
      billingCycle:            plan === "free" ? null : "manual",
        transcriptsUsedToday:    0,
        transcriptsUsedMonth:    0,
        clipsUsedToday:          0,
        clipsUsedMonth:          0,
        lastTranscriptDate:      null,
        lastTranscriptResetDate: null,
        lastClipDate:            null,
      };
    if (plan !== "free") {
      const days = parseInt(durationDays) || 30;
      planExpiry = new Date();
      planExpiry.setDate(planExpiry.getDate() + days);
      update.planExpiresAt = planExpiry;
      update.lastPaidPlan = plan;
    } else {
      // Keep the last expiry/paid plan so churn/win-back analytics remain accurate.
      update.planExpiresAt = undefined;
    }

    const user = await User.findOneAndUpdate(
      { email },
      { $set: update },
      { new: true }
    );

    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    logAdminAction("set-plan", email, `Set plan to ${plan}${planExpiry ? ` (expires ${planExpiry.toISOString().slice(0,10)})` : ""}`, req);
    res.json({ success: true, message: `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan assigned successfully.`, user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});


app.post("/admin/credit", adminAuth, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const action = String(req.body?.action || "add").toLowerCase();
    const amount = Number(req.body?.amount || 0);
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Valid email required." });
    if (!["add", "subtract", "deduct", "set", "reset"].includes(action)) return res.status(400).json({ success: false, error: "Invalid credit action." });
    if (action === "reset") {
      // reset ignores the entered amount.
    } else if (!Number.isInteger(amount) || amount < 0 || amount > 100000 || ((action === "add" || action === "subtract" || action === "deduct") && amount === 0)) {
      return res.status(400).json({ success: false, error: "Enter a whole number between 0 and 100000." });
    }

    let user;
    if (action === "reset") {
      user = await User.findOneAndUpdate({ email }, { $set: { credits: 0 } }, { new: true });
    } else if (action === "add") {
      user = await User.findOneAndUpdate({ email }, { $inc: { credits: amount } }, { new: true });
    } else if (action === "set") {
      user = await User.findOneAndUpdate({ email }, { $set: { credits: amount } }, { new: true });
    } else {
      user = await User.findOneAndUpdate({ email, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
    }
    if (!user) return res.status(404).json({ success: false, error: ["subtract","deduct"].includes(action) ? "User not found or not enough credits." : "User not found." });
    logAdminAction("credit-" + action, email, `${action} ${amount || 0} credits (new total: ${user.credits})`, req);
    res.json({ success: true, message: action === "reset" ? "Credits reset successfully" : `Credits ${action === "add" ? "added" : action === "set" ? "set" : action === "reset" ? "reset" : "subtracted"} successfully`, user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/admin/user-control", adminAuth, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const action = String(req.body?.action || "").toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Valid email required." });
    if (!["suspend", "unsuspend", "delete"].includes(action)) return res.status(400).json({ success: false, error: "Invalid user action." });

    if (action === "delete") {
      const jobs = await ClipJob.find({ userEmail: email }).select("clips.s3Key").lean();
      const keys = jobs.flatMap(j => (j.clips || []).map(c => c.s3Key).filter(Boolean));
      if (keys.length && EC2_URL && INTERNAL_KEY) {
        await axios.post(`${EC2_URL}/delete-clips`, { keys: [...new Set(keys)] }, { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 60000 }).catch(() => {});
      }
      const user = await User.findOneAndDelete({ email });
      if (!user) return res.status(404).json({ success: false, error: "User not found." });
      await Promise.all([
        Reel.deleteMany({ userEmail: email }),
        ClipJob.deleteMany({ userEmail: email }),
        Referral.deleteMany({ $or: [{ referrerEmail: email }, { referredEmail: email }] })
      ]);
      logAdminAction("delete-user", email, "User account and associated transcript/clip/referral data deleted; payment and audit records retained.", req);
      return res.json({ success: true, message: "User account deleted." });
    }

    const user = await User.findOneAndUpdate(
      { email },
      { $set: { isSuspended: action === "suspend" } },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, error: "User not found." });
    logAdminAction(action + "-user", email, `User ${action}d`, req);
    res.json({ success: true, message: action === "suspend" ? "User suspended." : "User unsuspended.", user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/admin/users/:email/details", adminAuth, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Invalid email." });
    const [user, totalTranscriptions, totalClipJobs] = await Promise.all([
      User.findOne({ email }).lean(),
      Reel.countDocuments({ userEmail: email }),
      ClipJob.countDocuments({ userEmail: email })
    ]);
    if (!user) return res.status(404).json({ success: false, error: "User not found." });
    res.json({ success: true, details: { lastActive: user.lastActiveAt, totalTranscriptions, totalClipJobs, creditsUsedTotal: user.creditsUsedTotal || 0 } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/admin/referrals", adminAuth, async (req, res) => {
  try {
    const status = String(req.query.status || "pending_review");
    const allowed = ["pending", "pending_review", "credited", "rejected"];
    const filter = allowed.includes(status) ? { status } : {};
    const data = await Referral.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, data });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/admin/referrals/:id/review", adminAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || "").toLowerCase();
    if (!["approve", "reject"].includes(action)) return res.status(400).json({ success: false, error: "Invalid review action." });

    const referral = await Referral.findById(req.params.id);
    if (!referral) return res.status(404).json({ success: false, error: "Referral not found." });
    if (referral.status !== "pending_review") return res.status(409).json({ success: false, error: "This referral has already been reviewed." });

    if (action === "reject") {
      referral.status = "rejected";
      await referral.save();
      logAdminAction("reject-referral", referral.referredEmail, `Referral from ${referral.referrerEmail} rejected (${referral.riskReason || "review"})`, req);
      return res.json({ success: true, message: "Referral rejected." });
    }

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0,0,0,0);
    const earned = await Referral.countDocuments({ referrerEmail: referral.referrerEmail, status: "credited", creditedAt: { $gte: monthStart } });
    if (earned >= 5) return res.status(409).json({ success: false, error: "This referrer has already reached the 5-referral monthly reward cap." });

    const referrerUser = await User.findOne({ email: referral.referrerEmail }).select("_id").lean();
    if (!referrerUser) return res.status(404).json({ success: false, error: "The referring user no longer exists." });

    const credited = await Referral.findOneAndUpdate(
      { _id: referral._id, status: "pending_review" },
      { $set: { status: "credited", creditedAt: new Date() } },
      { new: true }
    );
    if (!credited) return res.status(409).json({ success: false, error: "Referral was already reviewed." });

    await User.findOneAndUpdate({ email: credited.referrerEmail }, { $inc: { referralCuts: 1, referralsCount: 1 } });
    logAdminAction("approve-referral", credited.referredEmail, `Referral from ${credited.referrerEmail} approved`, req);
    res.json({ success: true, message: "Referral approved and one clip reward credited." });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/admin/payments", adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const filter = {};
    if (search) filter.userEmail = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    if (["paid","failed","refunded"].includes(status)) filter.status = status;
    const [data,total] = await Promise.all([
      Payment.find(filter).sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),
      Payment.countDocuments(filter)
    ]);
    res.json({success:true,data,page,totalPages:Math.max(1,Math.ceil(total/limit)),total});
  } catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.get("/admin/usage", adminAuth, async (req,res)=>{
  try {
    const now=new Date(), startToday=new Date(now); startToday.setHours(0,0,0,0);
    const startMonth=new Date(now.getFullYear(),now.getMonth(),1);
    const [totalClipJobs,todayProcessed,transcriptsThisMonth,clipsThisMonth,platformAgg]=await Promise.all([
      ClipJob.countDocuments(),
      ClipJob.countDocuments({createdAt:{$gte:startToday}}),
      Reel.countDocuments({createdAt:{$gte:startMonth}}),
      ClipJob.countDocuments({createdAt:{$gte:startMonth}}),
      ClipJob.aggregate([{ $group:{_id:{$ifNull:["$platform","Unknown"]},count:{$sum:1}}},{ $sort:{count:-1}},{ $limit:1}])
    ]);
    const daily=[];
    for(let i=6;i>=0;i--){const d=new Date(startToday);d.setDate(d.getDate()-i);const next=new Date(d);next.setDate(next.getDate()+1);
      const [r,c]=await Promise.all([Reel.countDocuments({createdAt:{$gte:d,$lt:next}}),ClipJob.countDocuments({createdAt:{$gte:d,$lt:next}})]);
      daily.push({label:d.toLocaleDateString("en-IN",{weekday:"short"}),total:r+c});
    }
    res.json({success:true,totalClipJobs,todayProcessed,transcriptsThisMonth,clipsThisMonth,mostUsedPlatform:platformAgg[0]?._id||"Unknown",sevenDayProcessed:daily.reduce((a,x)=>a+x.total,0),daily});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/admin/coupons", adminAuth, async (req,res)=>{
  try {
    const rows=await Coupon.find().sort({createdAt:-1}).lean();
    res.json({success:true,data:rows.map(normalizeCoupon)});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/admin/coupons", adminAuth, async (req,res)=>{
  try {
    const {code,percent,plan,expiresAt,maxUses}=req.body;
    const clean=String(code||"").trim().toUpperCase();
    const pct=Number(percent);
    if(!/^[A-Z0-9_-]{3,40}$/.test(clean)) return res.status(400).json({success:false,error:"Coupon code must be 3-40 letters, numbers, _ or -."});
    if(!(pct>0 && pct<=100)) return res.status(400).json({success:false,error:"Discount must be between 1 and 100%."});
    if(!["all","starter","pro","agency"].includes(plan)) return res.status(400).json({success:false,error:"Invalid plan."});
    if(!expiresAt || isNaN(new Date(expiresAt).getTime()) || new Date(expiresAt)<=new Date()) return res.status(400).json({success:false,error:"A future expiry date is required."});
    const coupon=await Coupon.create({code:clean,discountPercent:pct,appliesToPlans:[plan],expiresAt:new Date(expiresAt),maxUses:Math.max(0,parseInt(maxUses)||0)});
    logAdminAction("create-coupon",null,`Created ${clean}: ${pct}% off ${plan}`,req);
    res.json({success:true,coupon:normalizeCoupon(coupon)});
  } catch(e){res.status(400).json({success:false,error:e.code===11000?"Coupon code already exists.":e.message});}
});

app.post("/admin/coupons/toggle", adminAuth, async (req,res)=>{
  try {
    const code=String(req.body.code||"").trim().toUpperCase();
    const coupon=await Coupon.findOne({code});
    if(!coupon) return res.status(404).json({success:false,error:"Coupon not found."});
    coupon.active=!coupon.active;
    await coupon.save();
    logAdminAction("toggle-coupon",null,`${code} set to ${coupon.active?"active":"inactive"}`,req);
    res.json({success:true,coupon:normalizeCoupon(coupon)});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/admin/coupon-redemptions", adminAuth, async (req,res)=>{
  try { res.json({success:true,data:await CouponRedemption.find().sort({createdAt:-1}).limit(200).lean()}); }
  catch(e){res.status(500).json({success:false,error:e.message});}
});

function buildOfferUrl(plan,billing,couponCode) {
  const base = process.env.PUBLIC_SITE_URL || "https://reelscribe.site";
  const u = new URL("/pricing", base);
  u.searchParams.set("plan", plan);
  u.searchParams.set("billing", billing || "monthly");
  if(couponCode) u.searchParams.set("coupon", couponCode);
  return u.toString();
}

const EMAIL_TEMPLATES = {
  discount: {
    subject: "🔥 Special Offer: Get {{percent}}% OFF ReelScribe {{planLabel}}",
    html: ({percent,planLabel,originalPrice,finalPrice,url}) => `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f3ff;font-family:Arial,Helvetica,sans-serif;color:#171329"><tr><td align="center" style="padding:32px 12px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#fff;border-radius:18px;overflow:hidden"><tr><td style="padding:28px 32px;background:#15111f"><div style="font-size:26px;font-weight:800;color:#fff">Reel<span style="color:#8b5cf6">Scribe</span></div><div style="margin-top:6px;font-size:13px;color:#b9b2c9">Transcribe. Create. Cut Clips.</div></td></tr><tr><td style="padding:38px 32px 28px;text-align:center"><div style="display:inline-block;padding:7px 12px;border-radius:999px;background:#eee7ff;color:#6d35d4;font-size:12px;font-weight:700">SPECIAL OFFER</div><h1 style="margin:18px 0 10px;font-size:34px;line-height:1.15">Unlock More With ReelScribe</h1><p style="margin:0 auto;max-width:470px;font-size:16px;line-height:1.6;color:#696276">Get ${planLabel} at an exclusive ${percent}% discount. Your offer is already linked to checkout.</p><div style="margin:26px 0 10px"><span style="font-size:16px;color:#8c8598;text-decoration:line-through">₹${originalPrice}</span><span style="margin-left:10px;font-size:38px;font-weight:800;color:#6d35d4">₹${finalPrice}</span><span style="font-size:15px;color:#6c6478"> total</span></div><div style="font-size:13px;color:#777080">Limited-time offer</div><a href="${url}" style="display:inline-block;margin-top:24px;padding:15px 30px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:10px;font-size:16px;font-weight:700">CLAIM ${percent}% OFF →</a></td></tr><tr><td style="padding:30px 32px;background:#faf9ff;text-align:center;border-top:1px solid #eeeaf6"><h2 style="margin:0 0 8px;font-size:23px">Ready to create more?</h2><p style="margin:0;color:#716a7e;font-size:14px;line-height:1.5">Click above and your coupon will be applied automatically at checkout.</p></td></tr><tr><td style="padding:25px 32px;background:#15111f;text-align:center"><div style="font-size:17px;font-weight:800;color:#fff">Reel<span style="color:#8b5cf6">Scribe</span></div><p style="margin:8px 0;font-size:12px;color:#aaa2b8">Transcribe any video or audio and create clips with AI.</p><a href="${baseUrlSafe()}" style="color:#b18cff;text-decoration:none;font-size:12px">Visit ReelScribe</a></td></tr></table></td></tr></table>`,
  },
  upgrade: {
    subject: "🚀 Upgrade ReelScribe and unlock more",
    html: ({url}) => `<div style="background:#f5f3ff;padding:32px;font-family:Arial;text-align:center"><div style="max-width:600px;margin:auto;background:#fff;border-radius:18px;padding:42px 28px"><div style="font-size:26px;font-weight:800">Reel<span style="color:#8b5cf6">Scribe</span></div><h1 style="font-size:32px;margin:22px 0 10px">Ready for the next level? 🚀</h1><p style="color:#696276;font-size:16px;line-height:1.6">Upgrade your ReelScribe plan and unlock more of your content workflow.</p><a href="${url}" style="display:inline-block;margin-top:20px;padding:15px 30px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">UPGRADE NOW →</a></div></div>`
  },
  expiry: {
    subject: "⏰ Your ReelScribe subscription is expiring soon",
    html: ({url}) => `<div style="background:#f5f3ff;padding:32px;font-family:Arial;text-align:center"><div style="max-width:600px;margin:auto;background:#fff;border-radius:18px;padding:42px 28px"><div style="font-size:26px;font-weight:800">Reel<span style="color:#8b5cf6">Scribe</span></div><h1 style="font-size:30px;margin:22px 0 10px">Don't lose your access ⚡</h1><p style="color:#696276;font-size:16px;line-height:1.6">Renew your subscription and continue creating without interruption.</p><a href="${url}" style="display:inline-block;margin-top:20px;padding:15px 30px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">RENEW MY PLAN →</a></div></div>`
  },
  announcement: {
    subject: "🚀 New from ReelScribe",
    html: ({url}) => `<div style="background:#f5f3ff;padding:32px;font-family:Arial;text-align:center"><div style="max-width:600px;margin:auto;background:#fff;border-radius:18px;padding:42px 28px"><div style="font-size:26px;font-weight:800">Reel<span style="color:#8b5cf6">Scribe</span></div><h1 style="font-size:30px;margin:22px 0 10px">Something new is here 🚀</h1><p style="color:#696276;font-size:16px;line-height:1.6">Check out the latest ReelScribe improvements and keep creating.</p><a href="${url}" style="display:inline-block;margin-top:20px;padding:15px 30px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">CHECK IT OUT →</a></div></div>`
  }
};
function baseUrlSafe(){ return process.env.PUBLIC_SITE_URL || "https://reelscribe.site"; }

app.post("/admin/marketing/preview", adminAuth, async (req,res)=>{
  try {
    const { templateId="discount", plan="pro", billing="monthly", couponCode, percent } = req.body;
    if(!PLAN_PRICING[plan]) return res.status(400).json({success:false,error:"Invalid plan."});
    const tpl=EMAIL_TEMPLATES[templateId] || EMAIL_TEMPLATES.discount;
    let coupon=null;
    if(couponCode) coupon=await Coupon.findOne({code:String(couponCode).trim().toUpperCase()});
    const pct=Number(percent || coupon?.discountPercent || 0);
    const planPrice=PLAN_PRICING[plan][billing==="yearly"?"y":"m"];
    const originalPrice=billing==="yearly" ? planPrice*12 : planPrice;
    const finalPrice=Math.max(1,Math.round((originalPrice-(originalPrice*pct/100))*100)/100);
    const url=buildOfferUrl(plan,billing,coupon?.code);
    const html=tpl.html({percent:pct,planLabel:plan.charAt(0).toUpperCase()+plan.slice(1),originalPrice,finalPrice,url});
    const subject=tpl.subject.replace("{{percent}}",pct).replace("{{planLabel}}",plan.charAt(0).toUpperCase()+plan.slice(1));
    res.json({success:true,subject,html,url,originalPrice,finalPrice,coupon:normalizeCoupon(coupon)});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/admin/marketing/send", adminAuth, async (req,res)=>{
  try {
    const { audience, targetEmail, templateId="discount", subject, html, plan="pro", billing="monthly", couponCode, percent } = req.body;
    let users=[];
    if(audience==="specific"){
      if(!isValidEmail(targetEmail)) return res.status(400).json({success:false,error:"Valid target email required."});
      const u=await User.findOne({email:targetEmail.toLowerCase()});
      if(!u) return res.status(404).json({success:false,error:"User not found."});
      users=[u];
    } else {
      const q={};
      if(["free","starter","pro","agency"].includes(audience)) q.plan=audience;
      if(audience==="expiring") q.planExpiresAt={$gte:new Date(),$lte:new Date(Date.now()+7*86400000)};
      users=await User.find(q).limit(100).lean();
    }
    if(!users.length) return res.status(400).json({success:false,error:"No recipients found."});
    const tpl=EMAIL_TEMPLATES[templateId] || EMAIL_TEMPLATES.discount;
    let coupon=null;
    if(couponCode) coupon=await Coupon.findOne({code:String(couponCode).trim().toUpperCase()});
    const pct=Number(percent || coupon?.discountPercent || 0);
    const planPrice=PLAN_PRICING[plan]?.[billing==="yearly"?"y":"m"] || 0;
    const originalPrice=billing==="yearly"?planPrice*12:planPrice;
    const finalPrice=Math.max(1,Math.round((originalPrice-(originalPrice*pct/100))*100)/100);
    const url=buildOfferUrl(plan,billing,coupon?.code);
    const renderedHtml=html || tpl.html({percent:pct,planLabel:plan.charAt(0).toUpperCase()+plan.slice(1),originalPrice,finalPrice,url});
    const renderedSubject=subject || tpl.subject.replace("{{percent}}",pct).replace("{{planLabel}}",plan.charAt(0).toUpperCase()+plan.slice(1));
    let sent=0, failed=0;
    for(const u of users){
      try{
        await resend.emails.send({from:process.env.EMAIL_FROM||"ReelScribe <noreply@reelscribe.site>",to:u.email,subject:renderedSubject,html:renderedHtml});
        sent++;
      }catch(e){failed++;}
    }
    logAdminAction("marketing-email",audience==="specific"?targetEmail:null,`Template ${templateId}; sent ${sent}/${users.length}`,req);
    res.json({success:true,attempted:users.length,sent,failed,capped:users.length>=100});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// Consistent upload errors (especially the 25 MB direct-upload limit).
app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, error: "File is too large. Direct uploads are limited to 25 MB." });
  next(err);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()), time: new Date().toISOString() });
});

// Friendly pricing route used by marketing email CTA links.
app.get("/pricing", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pricing.html"));
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Render server running on ${PORT}`));
