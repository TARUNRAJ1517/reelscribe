require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const Groq = require("groq-sdk");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const axios = require("axios");
const https = require("https");
const { YoutubeTranscript } = require("youtube-transcript");

const { uploadToS3 } = require("./services/s3Service");
const ffmpeg = require("./services/ffmpegService");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const Reel = require("./models/Reel");
const User = require("./models/User");
const GuestUsage = require("./models/GuestUsage");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();

// ── UPLOADS FOLDER AUTO-CREATE ──
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log("✅ uploads folder created");
} else {
  console.log("✅ uploads folder already exists");
}

app.use(cors({
  origin: [
    "https://reelscribe.site",
    "https://www.reelscribe.site"
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.static("public"));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

const otpStore = {};

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id)); }
  catch (err) { done(err, null); }
});

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
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
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (key !== process.env.ADMIN_SECRET) return res.status(401).json({ success: false, error: "Unauthorized" });
  next();
}

async function getInstagramVideoUrl(instagramUrl) {
  try {
    const response = await axios.get("https://instagram-reels-downloader-api.p.rapidapi.com/download", {
      params: { url: instagramUrl },
      headers: {
        "x-rapidapi-key": process.env.RAPID_API_KEY,
        "x-rapidapi-host": "instagram-reels-downloader-api.p.rapidapi.com"
      }
    });
    const data = response.data;
    if (data.success && data.data?.medias?.length > 0) return data.data.medias[0].url;
    throw new Error("Video URL nahi mila API response mein");
  } catch (err) {
    console.error("RapidAPI Error:", err.response?.data || err.message);
    throw err;
  }
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
    /youtube\.com\/embed\/([^?]+)/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function checkGuestLimit(req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress;

  let guest = await GuestUsage.findOne({ ip });

  if (!guest) {
    guest = await GuestUsage.create({ ip, previewCount: 0 });
  }

  if (guest.previewCount >= 3) {
    return { allowed: false, previewsUsed: guest.previewCount };
  }

  guest.previewCount += 1;
  await guest.save();

  return { allowed: true, previewsUsed: guest.previewCount };
}

// ── TEST S3 UPLOAD ──
app.post("/test-s3-upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Video required" });
    }

    const key = `videos/${Date.now()}-${req.file.originalname}`;
    const url = await uploadToS3(req.file.path, key);
    fs.unlinkSync(req.file.path);

    res.json({ success: true, url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CREATE RAZORPAY ORDER ──
app.post("/create-order", async (req, res) => {
  try {
    const { plan } = req.body;

    const plans = { starter: 149, pro: 299, agency: 599 };

    if (!plans[plan]) {
      return res.status(400).json({ success: false, error: "Invalid plan" });
    }

    const options = {
      amount: plans[plan] * 100,
      currency: "INR",
      receipt: `receipt_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);

    res.json({ success: true, order, key: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error("Create Order Error:", err);
    res.status(500).json({ success: false, error: "Order create failed" });
  }
});

// ── VERIFY RAZORPAY PAYMENT ──
app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan,
      email
    } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: "Invalid payment signature" });
    }

    const validPlans = ["starter", "pro", "agency"];
    if (!plan || !validPlans.includes(plan)) {
      return res.status(400).json({ success: false, error: "Invalid plan" });
    }

    const planExpiry = new Date();
    planExpiry.setMonth(planExpiry.getMonth() + 1);

    const user = await User.findOneAndUpdate(
      { email },
      {
        plan,
        planExpiresAt: planExpiry,
        transcriptsUsedMonth: 0,
        clipsUsedToday: 0,
        clipsUsedMonth: 0,
        lastTranscriptResetDate: new Date()
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    console.log(`✅ Plan activated: ${email} → ${plan} (expires: ${planExpiry})`);

    res.json({
      success: true,
      message: `${plan} plan activate ho gaya!`,
      plan,
      planExpiresAt: planExpiry
    });
  } catch (err) {
    console.error("Verify Payment Error:", err);
    res.status(500).json({ success: false, error: "Payment verification failed" });
  }
});

app.get("/test", (req, res) => res.send("TEST ROUTE WORKING"));
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("/dashboard.html?email=" + encodeURIComponent(req.user.email))
);

// ── SEND OTP ──
app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email required" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    otpStore[email] = {
      otp,
      expiresAt: Date.now() + 5 * 60 * 1000
    };

    console.log("Sending OTP to:", email);

    await resend.emails.send({
      from: "ReelScribe <noreply@reelscribe.site>",
      to: email,
      subject: "Your ReelScribe OTP",
      html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#09070f;font-family:'Inter',Arial,sans-serif;">
<div style="max-width:480px;margin:0 auto;padding:32px 20px;">
  <div style="background:linear-gradient(135deg,#8b5cf6,#ec4899);border-radius:16px;padding:32px 24px;text-align:center;">
    <h1 style="color:white;font-size:24px;font-weight:900;margin:0 0 8px;letter-spacing:-0.5px;">ReelScribe</h1>
    <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:0 0 28px;">Transcribe · Repurpose · Scale</p>
    <div style="background:rgba(255,255,255,0.1);border-radius:12px;padding:24px;margin-bottom:24px;">
      <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:0 0 12px;">Your One-Time Password</p>
      <div style="background:white;border-radius:10px;padding:16px;display:inline-block;">
        <span style="font-size:36px;font-weight:900;letter-spacing:8px;color:#8b5cf6;">${otp}</span>
      </div>
      <p style="color:rgba(255,255,255,0.6);font-size:12px;margin:12px 0 0;">Valid for 5 minutes only</p>
    </div>
    <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:0;">If you didn't request this OTP, ignore this email.</p>
  </div>
  <p style="color:#3d3660;font-size:11px;text-align:center;margin-top:16px;">© 2026 ReelScribe. All rights reserved.</p>
</div>
</body>
</html>
`
    });

    console.log("OTP sent");
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── VERIFY OTP ──
app.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const record = otpStore[email];

    if (!record) {
      return res.status(400).json({ success: false, message: "OTP not found" });
    }

    if (Date.now() > record.expiresAt) {
      delete otpStore[email];
      return res.status(400).json({ success: false, message: "OTP expired" });
    }

    if (record.otp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    delete otpStore[email];

    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        name: email.split("@")[0],
        email,
        credits: 5
      });
    }

    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── TRANSCRIBE FILE ──
app.post("/transcribe", upload.single("video"), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: "Email required" });

    // ── FILE CHECK ──
    if (!req.file) {
      console.error("❌ req.file is undefined — Multer ne file receive nahi ki");
      return res.status(400).json({ success: false, error: "File nahi mili. Upload dobara try karo." });
    }

    console.log("✅ File received:", req.file.originalname, `(${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

    const user = await User.findOne({ email });
    const isGuest = !user;

    if (isGuest) {
      const { allowed } = await checkGuestLimit(req);
      if (!allowed) {
        if (req.file?.path) fs.unlinkSync(req.file.path);
        return res.status(403).json({
          success: false,
          loginRequired: true,
          forceLogin: true,
          error: "Aapke 3 free previews khatam ho gaye. Full transcript ke liye login karein."
        });
      }
    }

    if (!isGuest && user.credits < 2) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: "Credits khatam ho gaye! Admin se contact karein." });
    }

    const filePath = req.file.path;

    console.log("⏳ Groq transcription shuru...");
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3-turbo"
    });
    console.log("✅ Transcription complete");

    const fullTranscript = transcription.text;

    if (!isGuest) {
      user.credits -= 2;
      await user.save();
      await Reel.create({ userEmail: email, reelUrl: req.file.originalname, transcript: fullTranscript });
    }

    fs.unlinkSync(filePath);

    const words = fullTranscript.split(/\s+/);
    const previewTranscript = words.slice(0, 100).join(" ");
    const isPreview = isGuest && words.length > 100;

    res.json({
      success: true,
      transcript: isGuest ? previewTranscript : fullTranscript,
      isGuest,
      isPreview,
      totalWords: words.length,
      creditsLeft: user ? user.credits : 0
    });

  } catch (error) {
    console.error("❌ TRANSCRIBE ERROR:", error.message);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── TRANSCRIBE URL ──
app.post("/transcribe-url", async (req, res) => {
  const { email, url } = req.body;

  if (!email || !url) return res.status(400).json({ success: false, error: "Email aur URL required hai" });

  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  const isInstagram = url.includes("instagram.com");

  if (!isYouTube && !isInstagram) {
    return res.status(400).json({ success: false, error: "Sirf YouTube aur Instagram URLs supported hain" });
  }

  const user = await User.findOne({ email });
  const isGuest = !user;

  if (isGuest) {
    const { allowed } = await checkGuestLimit(req);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        loginRequired: true,
        forceLogin: true,
        error: "Aapke 3 free previews khatam ho gaye. Full transcript ke liye login karein."
      });
    }
  }

  if (!isGuest && user.credits < 2) {
    return res.status(400).json({ success: false, error: "Credits khatam ho gaye! Admin se contact karein." });
  }

  function buildResponse(fullTranscript, source) {
    const words = fullTranscript.split(/\s+/);
    const isPreview = isGuest && words.length > 100;
    return {
      success: true,
      transcript: isGuest ? words.slice(0, 100).join(" ") : fullTranscript,
      isGuest,
      isPreview,
      totalWords: words.length,
      creditsLeft: isGuest ? 0 : user.credits,
      source
    };
  }

  // ── YOUTUBE ──
  if (isYouTube) {
    try {
      console.log("⏳ YouTube transcript fetch kar raha hoon...");
      const videoId = getYouTubeVideoId(url);
      if (!videoId) return res.status(400).json({ success: false, error: "Invalid YouTube URL" });

      const transcriptArr = await YoutubeTranscript.fetchTranscript(videoId);
      if (!transcriptArr || transcriptArr.length === 0) {
        return res.status(400).json({ success: false, error: "Is video mein transcript available nahi hai." });
      }

      const transcript = transcriptArr.map(item => item.text).join(" ").replace(/\s+/g, " ").trim();
      console.log("✅ YouTube transcript ready");

      if (!isGuest) {
        user.credits -= 2;
        await user.save();
        await Reel.create({ userEmail: email, reelUrl: url, transcript });
      }

      return res.json(buildResponse(transcript, "youtube-captions"));
    } catch (error) {
      console.error("YouTube Transcript Error:", error.message);
      let errorMsg = "YouTube transcript fetch nahi hua.";
      if (error.message.includes("disabled")) errorMsg = "Is video mein captions disabled hain.";
      return res.status(500).json({ success: false, error: errorMsg });
    }
  }

  // ── INSTAGRAM ──
  const outputPath = path.join(__dirname, "uploads", `${Date.now()}_insta.mp4`);

  try {
    console.log("⏳ RapidAPI se video URL la raha hoon...");
    const videoUrl = await getInstagramVideoUrl(url);
    console.log("✅ Video URL mila");

    console.log("⏳ Video download ho rahi hai...");
    await downloadVideo(videoUrl, outputPath);
    console.log("✅ Video download complete");

    if (!fs.existsSync(outputPath)) return res.status(500).json({ success: false, error: "Video download nahi hua" });

    console.log("⏳ Transcribing...");
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(outputPath),
      model: "whisper-large-v3-turbo"
    });
    console.log("✅ Transcript ready");

    if (!isGuest) {
      user.credits -= 2;
      await user.save();
      await Reel.create({ userEmail: email, reelUrl: url, transcript: transcription.text });
    }

    fs.unlinkSync(outputPath);

    return res.json(buildResponse(transcription.text, "groq-whisper"));
  } catch (error) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    console.error("Instagram Transcribe Error:", error.message);
    let errorMsg = "URL se video nahi mil saka.";
    if (error.message.includes("private")) errorMsg = "Yeh video private hai! Public reel ka URL daalo.";
    else if (error.message.includes("Video URL nahi mila")) errorMsg = "Reel nahi mili. Sahi public URL daalo.";
    else if (error.response?.status === 429) errorMsg = "RapidAPI limit khatam ho gayi. Thodi der baad try karo.";
    return res.status(500).json({ success: false, error: errorMsg });
  }
});

app.get("/user-plan/:email", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true, plan: user.plan || "free", planExpiresAt: user.planExpiresAt });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/ffmpeg-test", (req, res) => {
  res.json({ success: true, message: "FFmpeg is working 🚀" });
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
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
