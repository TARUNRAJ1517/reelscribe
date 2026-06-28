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
const Razorpay    = require("razorpay");
const crypto      = require("crypto");
const FormData    = require("form-data"); // FIX: needed for multipart forward to EC2

const resend  = new Resend(process.env.RESEND_API_KEY);
const app     = express();
const groq    = new Groq({ apiKey: process.env.GROQ_API_KEY });
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// FIX: EC2_URL / INTERNAL_KEY moved up — must exist before any route uses them
const EC2_URL       = process.env.EC2_URL;         // e.g. http://13.206.252.122:4000
const INTERNAL_KEY  = process.env.INTERNAL_SECRET; // shared secret with EC2

// ── Plan limits (same as EC2) ──
const PLAN_LIMITS = {
  free:    { transcriptDay: 2,  transcriptMonth: 5,  clipDay: 0,  clipMonth: 0,  maxMB: 100  },
  starter: { transcriptDay: 5,  transcriptMonth: 20, clipDay: 3,  clipMonth: 15, maxMB: 500  },
  pro:     { transcriptDay: 10, transcriptMonth: 50, clipDay: 8,  clipMonth: 40, maxMB: 1024 },
  agency:  { transcriptDay: 20, transcriptMonth: 100,clipDay: 15, clipMonth: 80, maxMB: 2048 },
};

// ════════════════════════════════
//  MIDDLEWARE — must be registered before any route
//  FIX: cors() + express.json() were previously defined AFTER
//  /proxy-upload, so that route never got CORS headers
// ════════════════════════════════
app.use(cors({
  origin: ["https://reelscribe.site", "https://www.reelscribe.site"],
  credentials: true,
}));
app.use(express.json());
app.use(express.static("public"));
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

// ════════════════════════════════
//  PROXY UPLOAD ROUTE — forwards large video uploads to EC2
//  FIX: duplicate `const multer = require('multer')` removed —
//  reusing the single top-level `multer` import instead.
// ════════════════════════════════
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

// ── Uploads folder ──
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ── MongoDB ──
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

const otpStore = {};

// ── Passport ──
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

// ── Multer (for transcription only — small files) ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB for transcription

// ── Admin auth ──
function adminAuth(req, res, next) {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_SECRET)
    return res.status(401).json({ success: false, error: "Unauthorized" });
  next();
}

// ── Internal auth (EC2 ↔ Render) ──
function internalAuth(req, res, next) {
  if (req.headers["x-internal-key"] !== INTERNAL_KEY)
    return res.status(401).json({ success: false, error: "Unauthorized" });
  next();
}

// ════════════════════════════════
//  HELPERS
// ════════════════════════════════

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
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
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
  throw new Error("Video URL nahi mila");
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

// ── Check transcript limits ──
async function checkTranscriptLimit(user) {
  const plan   = user.plan || "free";
  const limits = PLAN_LIMITS[plan];

  let usedDay   = user.transcriptsUsedToday  || 0;
  let usedMonth = user.transcriptsUsedMonth  || 0;

  if (isNewDay(user.lastTranscriptDate))       usedDay   = 0;
  if (isNewMonth(user.lastTranscriptResetDate)) usedMonth = 0;

  if (usedDay >= limits.transcriptDay)
    return { allowed: false, error: `Daily limit reached (${limits.transcriptDay}/day). Kal aao ya upgrade karo!` };
  if (usedMonth >= limits.transcriptMonth)
    return { allowed: false, error: `Monthly limit reached (${limits.transcriptMonth}/month). Plan upgrade karo!` };

  return { allowed: true };
}

// ── Update transcript usage ──
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

// ════════════════════════════════
//  INTERNAL ROUTES (EC2 ↔ Render)
// ════════════════════════════════

// EC2 pulls user data for plan check
app.get("/internal/user-limits/:email", internalAuth, async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// EC2 updates usage after processing
app.post("/internal/update-usage", internalAuth, async (req, res) => {
  try {
    const { email, type } = req.body;
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

// ════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════

app.get("/test", (req, res) => res.send("TEST ROUTE WORKING"));
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("/dashboard.html?email=" + encodeURIComponent(req.user.email))
);

// ── Send OTP ──
app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email required" });

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

// ── Verify OTP ──
app.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const record = otpStore[email];
    if (!record)                    return res.status(400).json({ success: false, message: "OTP not found" });
    if (Date.now() > record.expiresAt) { delete otpStore[email]; return res.status(400).json({ success: false, message: "OTP expired" }); }
    if (record.otp !== otp)         return res.status(400).json({ success: false, message: "Invalid OTP" });

    delete otpStore[email];
    let user = await User.findOne({ email });
    if (!user) user = await User.create({ name: email.split("@")[0], email, credits: 5 });

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════
//  TRANSCRIPTION ROUTES
// ════════════════════════════════

// ── Transcribe uploaded file ──
app.post("/transcribe", upload.single("video"), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email)    return res.status(400).json({ success: false, error: "Email required" });
    if (!req.file) return res.status(400).json({ success: false, error: "File nahi mili" });

    const user    = await User.findOne({ email });
    const isGuest = !user;

    if (isGuest) {
      const { allowed } = await checkGuestLimit(req);
      if (!allowed) {
        if (req.file?.path) fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, loginRequired: true, forceLogin: true, error: "3 free previews khatam. Login karo!" });
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

// ── Transcribe URL (YouTube captions / Instagram) ──
app.post("/transcribe-url", async (req, res) => {
  const { email, url } = req.body;
  if (!email || !url) return res.status(400).json({ success: false, error: "Email aur URL required" });

  const isYouTube   = url.includes("youtube.com") || url.includes("youtu.be");
  const isInstagram = url.includes("instagram.com");
  if (!isYouTube && !isInstagram)
    return res.status(400).json({ success: false, error: "Sirf YouTube aur Instagram URLs supported hain" });

  const user    = await User.findOne({ email });
  const isGuest = !user;

  if (isGuest) {
    const { allowed } = await checkGuestLimit(req);
    if (!allowed) return res.status(403).json({ success: false, loginRequired: true, forceLogin: true, error: "3 free previews khatam. Login karo!" });
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

  // ── YouTube captions ──
  if (isYouTube) {
    try {
      const videoId = getYouTubeVideoId(url);
      if (!videoId) return res.status(400).json({ success: false, error: "Invalid YouTube URL" });

      const transcriptArr = await YoutubeTranscript.fetchTranscript(videoId);
      if (!transcriptArr?.length)
        return res.status(400).json({ success: false, error: "Is video mein transcript nahi hai" });

      const transcript = transcriptArr.map(i => i.text).join(" ").replace(/\s+/g, " ").trim();

      if (!isGuest) {
        await updateTranscriptUsage(user);
        await Reel.create({ userEmail: email, reelUrl: url, transcript });
      }

      return res.json(buildResponse(transcript, "youtube-captions"));
    } catch (error) {
      return res.status(500).json({ success: false, error: "YouTube transcript fetch nahi hua: " + error.message });
    }
  }

  // ── Instagram ──
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
    return res.status(500).json({ success: false, error: "Instagram video nahi mila: " + error.message });
  }
});

// ════════════════════════════════
//  CLIPS ROUTE — Forward to EC2
// ════════════════════════════════

app.post("/cut-clips", async (req, res) => {
  const { email, fcmToken } = req.body;

  if (!email) return res.status(401).json({ success: false, loginRequired: true, error: "Login required" });

  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ success: false, loginRequired: true, error: "User not found" });

  // Plan check on Render side
  const plan   = user.plan || "free";
  const limits = PLAN_LIMITS[plan];

  if (plan === "free")
    return res.status(403).json({ success: false, error: "Free plan mein clips available nahi. Upgrade karo!" });

  // Return EC2 upload URL + auth token to frontend
  // Frontend will directly upload to EC2
  res.json({
    success:      true,
    uploadUrl:    `${EC2_URL}/process-upload`,
    userEmail:    email,
    fcmToken:     fcmToken || null,
    maxMB:        limits.maxMB,
    plan,
  });
});

// ── Clip downloaded notification ──
app.post("/clip-downloaded", async (req, res) => {
  try {
    const { s3Key } = req.body;
    await axios.post(`${EC2_URL}/clip-downloaded`, { s3Key });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ════════════════════════════════
//  PAYMENT ROUTES
// ════════════════════════════════

app.post("/create-order", async (req, res) => {
  try {
    const { plan } = req.body;
    const plans = { starter: 149, pro: 299, agency: 599 };
    if (!plans[plan]) return res.status(400).json({ success: false, error: "Invalid plan" });

    const order = await razorpay.orders.create({
      amount:   plans[plan] * 100,
      currency: "INR",
      receipt:  `receipt_${Date.now()}`,
    });
    res.json({ success: true, order, key: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    res.status(500).json({ success: false, error: "Order create failed" });
  }
});

app.post("/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan, email } = req.body;

    const expectedSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expectedSig !== razorpay_signature)
      return res.status(400).json({ success: false, error: "Invalid payment signature" });

    const validPlans = ["starter", "pro", "agency"];
    if (!validPlans.includes(plan))
      return res.status(400).json({ success: false, error: "Invalid plan" });

    const planExpiry = new Date();
    planExpiry.setMonth(planExpiry.getMonth() + 1);

    const user = await User.findOneAndUpdate(
      { email },
      {
        plan,
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

    res.json({ success: true, message: `${plan} plan activate ho gaya!`, plan, planExpiresAt: planExpiry });
  } catch (err) {
    res.status(500).json({ success: false, error: "Payment verification failed" });
  }
});

// ════════════════════════════════
//  MISC ROUTES
// ════════════════════════════════

app.get("/user-plan/:email", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ success: false });

    const plan   = user.plan || "free";
    const limits = PLAN_LIMITS[plan];

    // Reset if new day/month
    const transcriptDay   = isNewDay(user.lastTranscriptDate)       ? 0 : (user.transcriptsUsedToday || 0);
    const transcriptMonth = isNewMonth(user.lastTranscriptResetDate) ? 0 : (user.transcriptsUsedMonth || 0);
    const clipDay         = isNewDay(user.lastClipDate)              ? 0 : (user.clipsUsedToday || 0);
    const clipMonth       = isNewMonth(user.lastClipDate)            ? 0 : (user.clipsUsedMonth || 0);

    res.json({
      success: true,
      plan,
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

app.get("/history/:email", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    const reels = await Reel.find({ userEmail: req.params.email }).sort({ createdAt: -1 });
    res.json({ success: true, data: reels });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/admin/users", adminAuth, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ success: true, data: users });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/admin/add-credit", adminAuth, async (req, res) => {
  try {
    const { email, credits } = req.body;
    if (!email || !credits) return res.status(400).json({ success: false, error: "Email aur credits required" });
    const user = await User.findOneAndUpdate({ email }, { $inc: { credits: parseInt(credits) } }, { new: true });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, message: `${credits} credits add kiye`, user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Render server running on ${PORT}`));
