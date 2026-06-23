require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const Groq = require("groq-sdk");
const nodemailer = require("nodemailer");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const axios = require("axios");
const https = require("https");
const { YoutubeTranscript } = require("youtube-transcript");

const Reel = require("./models/Reel");
const User = require("./models/User");
const GuestUsage = require("./models/GuestUsage");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.use(session({ secret: "reelscribe-secret", resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com", port: 587, secure: false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

transporter.verify((error) => {
  if (error) console.log("SMTP ERROR:", error);
  else console.log("SMTP READY");
});

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

  // 3 previews already used → force login
  if (guest.previewCount >= 3) {
    return { allowed: false, previewsUsed: guest.previewCount };
  }

  guest.previewCount += 1;
  await guest.save();

  return { allowed: true, previewsUsed: guest.previewCount };
}

app.get("/test", (req, res) => res.send("TEST ROUTE WORKING"));
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("/dashboard.html?email=" + encodeURIComponent(req.user.email))
);

app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email required" });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };
    await transporter.sendMail({
      from: process.env.EMAIL_USER, to: email,
      subject: "ReelScribe OTP",
      html: `<h2>ReelScribe</h2><p>Your OTP is:</p><h1 style="color:#6d5dfc">${otp}</h1><p>Valid for 5 minutes.</p>`
    });
    res.json({ success: true, message: "OTP Sent" });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const record = otpStore[email];
    if (!record) return res.status(400).json({ success: false, message: "OTP not found. Resend karein." });
    if (Date.now() > record.expiresAt) { delete otpStore[email]; return res.status(400).json({ success: false, message: "OTP expired." }); }
    if (record.otp !== otp) return res.status(400).json({ success: false, message: "Invalid OTP" });
    delete otpStore[email];
    let user = await User.findOne({ email });
    if (!user) user = await User.create({ name: email.split("@")[0], email, credits: 5 });
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── TRANSCRIBE FILE ──
app.post("/transcribe", upload.single("video"), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: "Email required" });

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

    // Logged in user ke liye credits check
    if (!isGuest && user.credits < 2) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: "Credits khatam ho gaye! Admin se contact karein." });
    }

    const filePath = req.file.path;
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3-turbo"
    });

    const fullTranscript = transcription.text;

    if (!isGuest) {
      // Logged in: full transcript, save history, deduct credits
      user.credits -= 2;
      await user.save();
      await Reel.create({ userEmail: email, reelUrl: req.file.originalname, transcript: fullTranscript });
    }

    fs.unlinkSync(filePath);

    // Guest ko sirf 100 words ka preview
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

  // Logged in user ke credits check
  if (!isGuest && user.credits < 2) {
    return res.status(400).json({ success: false, error: "Credits khatam ho gaye! Admin se contact karein." });
  }

  // Helper: guest ke liye 100 word preview banana
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

app.get("/credits/:email", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true, credits: user.credits });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
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
