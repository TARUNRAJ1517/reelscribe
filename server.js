// ═══════════════════════════════════════════════════════
//  RENDER SERVER — server.js
//  Handles: auth, OTP, payment, transcription, routing
//  Clips: forwarded to EC2
// ═══════════════════════════════════════════════════════
require("dotenv").config();

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
const { uploadToS3 }        = require("./services/s3Service");
const { Resend }            = require("resend");
const Reel        = require("./models/Reel");
const User        = require("./models/User");
const GuestUsage  = require("./models/GuestUsage");
const ClipJob     = require("./models/Clip");
const AdminLog    = require("./models/AdminLog");
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

function requireAuth(req, res, next) {
  const email = getSessionEmail(req);
  if (!email) return res.status(401).json({ success: false, loginRequired: true, error: "Please log in to continue." });
  req.authEmail = email;
  next();
}

const uploadProxy = multer({ dest: "/tmp/", limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

app.post("/proxy-upload", uploadProxy.single("video"), async (req, res) => {
  const { userEmail, fcmToken } = req.body;

  const formData = new FormData();
  formData.append("video", fs.createReadStream(req.file.path), req.file.originalname);
  formData.append("userEmail", userEmail);
  formData.append("fcmToken", fcmToken || "");

  try {
    const response = await axios.post(`${EC2_URL}/process-upload`, formData, {
      headers: formData.getHeaders(),
      timeout: 600000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    fs.unlinkSync(req.file.path);
    res.json(response.data);
  } catch (err) {
    if (fs.existsSync(req.file?.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

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
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    let user = await User.findOne({ email });
    if (!user) user = await User.create({ name: profile.displayName, email, credits: 5 });
    return done(null, user);
  } catch (err) { return done(err, null); }
}));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

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

  if (req.headers["x-admin-key"] !== process.env.ADMIN_SECRET) {
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
  if (req.headers["x-internal-key"] !== INTERNAL_KEY)
    return res.status(401).json({ success: false, error: "Unauthorized" });
  next();
}

function isValidEmail(email) {
  return typeof email === "string" &&
    email.length > 0 && email.length < 255 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
  const ip = req.ip;
  let guest = await GuestUsage.findOne({ ip });
  if (!guest) guest = await GuestUsage.create({ ip, previewCount: 0 });
  if (guest.previewCount >= 3) return { allowed: false };
  guest.previewCount += 1;
  await guest.save();
  return { allowed: true };
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

app.get("/test", (req, res) => res.send("TEST ROUTE WORKING"));
app.get("/auth/google", (req, res, next) => {
  const next_ = req.query.next;
  const state = (typeof next_ === "string" && next_.startsWith("/")) ? next_ : "/dashboard.html";
  passport.authenticate("google", { scope: ["profile", "email"], state })(req, res, next);
});
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    req.session.userEmail = req.user.email;
    const state_ = req.query.state;
    const dest = (typeof state_ === "string" && state_.startsWith("/")) ? state_ : "/dashboard.html";
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

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
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
    if (!user) user = await User.create({ name: email.split("@")[0], email, credits: 5 });

    req.session.userEmail = email;

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

  const isYouTube   = url.includes("youtube.com") || url.includes("youtu.be");
  const isInstagram = url.includes("instagram.com");
  if (!isYouTube && !isInstagram)
    return res.status(400).json({ success: false, error: "Only YouTube and Instagram URLs are supported." });

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
      await Reel.create({ userEmail: email, reelUrl: url, transcript: transcription.text });
    }

    fs.unlinkSync(outputPath);
    return res.json(buildResponse(transcription.text, "groq-whisper"));
  } catch (error) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return res.status(500).json({ success: false, error: "Couldn't fetch that Instagram video: " + error.message });
  }
});

app.get("/debug-version", (req, res) => {
  res.json({
    version: "clips-fix-v4-plan-aware-analysis",
    ec2Url: EC2_URL,
    hasInternalKey: !!INTERNAL_KEY,
    time: new Date().toISOString(),
  });
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

app.get("/clip-status/:jobId", (req, res) => {
  const job = clipJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: "Job not found or expired" });
  res.json({ success: true, ...job });
});

app.post("/cut-clips", requireAuth, async (req, res) => {
  const { ytUrl, fcmToken, captionSettings } = req.body;
  const email = req.authEmail;

  if (typeof ytUrl !== "string" || !ytUrl) return res.status(400).json({ success: false, error: "Please provide a YouTube URL." });

  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ success: false, loginRequired: true, error: "Account not found. Please log in again." });

  const plan = getEffectivePlan(user);
  if (plan === "free")
    return res.status(403).json({ success: false, error: "Clips aren't available on the free plan. Please upgrade to continue." });

  const limitCheck = await checkClipLimit(user);
  if (!limitCheck.allowed)
    return res.status(403).json({ success: false, error: limitCheck.error });

  const maxMinutes = PLAN_LIMITS[plan].maxVideoMinutes;
  const durationSec = await getYouTubeDurationSeconds(ytUrl);
  if (durationSec !== null && durationSec > maxMinutes * 60) {
    const videoMinutes = Math.ceil(durationSec / 60);
    return res.status(403).json({
      success: false,
      error: `This video is ${videoMinutes} min long. The ${plan} plan supports videos up to ${maxMinutes} min. Try a shorter video or upgrade your plan.`,
    });
  }

  const jobId = crypto.randomUUID();
  clipJobs.set(jobId, { status: "processing" });
  res.json({ success: true, jobId });

  (async () => {
    try {
      const ec2Response = await axios.post(
        `${EC2_URL}/analyze-video`,
        { url: ytUrl, captionSettings, plan },
        { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 900000 }
      );

      if (!ec2Response.data?.success) {
        clipJobs.set(jobId, { status: "error", error: ec2Response.data?.error || "Clip generation failed. Please try again." });
        return scheduleJobCleanup(jobId);
      }

      await updateClipUsage(user);
      const clips = ec2Response.data.clips || [];
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

const PLAN_PRICING = {
  starter: { m: 149, y: 124 },
  pro:     { m: 299, y: 249 },
  agency:  { m: 599, y: 499 }
};

app.post("/create-order", requireAuth, async (req, res) => {
  try {
    const { plan, billing } = req.body;
    const email = req.authEmail;
    if (!PLAN_PRICING[plan]) return res.status(400).json({ success: false, error: "Invalid plan." });

    const isYearly = billing === "yearly";
    const amountRupees = isYearly ? PLAN_PRICING[plan].y * 12 : PLAN_PRICING[plan].m;

    const order = await razorpay.orders.create({
      amount:   amountRupees * 100,
      currency: "INR",
      receipt:  `receipt_${Date.now()}`,
      notes:    { plan, billing: isYearly ? "yearly" : "monthly", email },
    });
    res.json({ success: true, order, key: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not create the order. Please try again." });
  }
});

app.post("/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (typeof razorpay_order_id !== "string" || typeof razorpay_payment_id !== "string" || typeof razorpay_signature !== "string")
      return res.status(400).json({ success: false, error: "We could not verify this payment. Please contact support." });

    const expectedSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expectedSig !== razorpay_signature)
      return res.status(400).json({ success: false, error: "Payment verification failed. Please contact support if the amount was deducted." });

    const order = await razorpay.orders.fetch(razorpay_order_id);
    if (!order || order.status !== "paid")
      return res.status(400).json({ success: false, error: "This order has not been paid yet." });

    const plan    = order.notes?.plan;
    const billing = order.notes?.billing;
    const email   = order.notes?.email;

    if (!isValidEmail(email))
      return res.status(400).json({ success: false, error: "We could not verify who this order belongs to. Please contact support." });

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

    const user = await User.findOneAndUpdate(
      { email },
      {
        plan,
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

  if (req.body?.key !== process.env.ADMIN_SECRET) {
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
      User.aggregate([{ $group: { _id: { $ifNull: ["$plan", "free"] }, count: { $sum: 1 } } }]),
    ]);

    const byPlan = { free: 0, starter: 0, pro: 0, agency: 0 };
    planCounts.forEach(p => { if (byPlan[p._id] !== undefined) byPlan[p._id] = p.count; });

    res.json({ success: true, totalUsers, newToday, newThisWeek, byPlan });
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

    const filter = search ? { email: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {};

    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      User.countDocuments(filter),
    ]);

    res.json({ success: true, data: users, page, totalPages: Math.max(1, Math.ceil(total / limit)), total });
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
    if (plan !== "free") {
      const days = parseInt(durationDays) || 30;
      planExpiry = new Date();
      planExpiry.setDate(planExpiry.getDate() + days);
    }

    const user = await User.findOneAndUpdate(
      { email },
      {
        plan,
        planExpiresAt:           planExpiry,
        billingCycle:            plan === "free" ? null : "manual",
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
    logAdminAction("set-plan", email, `Set plan to ${plan}${planExpiry ? ` (expires ${planExpiry.toISOString().slice(0,10)})` : ""}`, req);
    res.json({ success: true, message: `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan assigned successfully.`, user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Render server running on ${PORT}`));
