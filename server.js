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

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.use(
  session({
    secret: "reelscribe-secret",
    resave: false,
    saveUninitialized: false
  })
);

app.use(passport.initialize());
app.use(passport.session());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

const otpStore = {};

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails[0].value;
        let user = await User.findOne({ email });
        if (!user) {
          user = await User.create({
            name: profile.displayName,
            email,
            credits: 5
          });
        }
        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

transporter.verify(function(error, success) {
  if (error) {
    console.log("SMTP ERROR:", error);
  } else {
    console.log("SMTP READY");
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

// ── ADMIN MIDDLEWARE ──
function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (key !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

// ── RAPIDAPI SE INSTAGRAM VIDEO URL LAO ──
async function getInstagramVideoUrl(instagramUrl) {
  try {
    const response = await axios.get(
      "https://instagram-reels-downloader-api.p.rapidapi.com/download",
      {
        params: { url: instagramUrl },
        headers: {
          "x-rapidapi-key": process.env.RAPID_API_KEY,
          "x-rapidapi-host": "instagram-reels-downloader-api.p.rapidapi.com"
        }
      }
    );

    const data = response.data;

    if (data.success && data.data && data.data.medias && data.data.medias.length > 0) {
      return data.data.medias[0].url;
    }

    throw new Error("Video URL nahi mila API response mein");

  } catch (err) {
    console.error("RapidAPI Error:", err.response?.data || err.message);
    throw err;
  }
}

// ── VIDEO DOWNLOAD KARO URL SE ──
function downloadVideo(videoUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https.get(videoUrl, (response) => {
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

// ── YOUTUBE VIDEO ID NIKALO ──
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

app.get("/test", (req, res) => {
  res.send("TEST ROUTE WORKING");
});

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect("/dashboard.html?email=" + encodeURIComponent(req.user.email));
  }
);

// ── SEND OTP ──
app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email required" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = {
      otp,
      expiresAt: Date.now() + 5 * 60 * 1000
    };

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "ReelScribe OTP",
      html: `<h2>ReelScribe</h2><p>Your OTP is:</p><h1 style="color:#6d5dfc">${otp}</h1><p>Valid for 5 minutes.</p>`
    });

    res.json({ success: true, message: "OTP Sent" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── VERIFY OTP ──
app.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const record = otpStore[email];

    if (!record) return res.status(400).json({ success: false, message: "OTP not found. Resend karein." });
    if (Date.now() > record.expiresAt) {
      delete otpStore[email];
      return res.status(400).json({ success: false, message: "OTP expired. Resend karein." });
    }
    if (record.otp !== otp) return res.status(400).json({ success: false, message: "Invalid OTP" });

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
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── TRANSCRIBE (File Upload) ──
app.post("/transcribe", upload.single("video"), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: "Email required" });

    const user = await User.findOne({ email });
    let isGuest = !user;

    if (!isGuest && user.credits < 2) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        error: "Credits khatam ho gaye! Admin se contact karein."
      });
    }

    const filePath = req.file.path;

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3-turbo"
    });

    if (!isGuest) {
      user.credits -= 2;
      await user.save();
    }

    await Reel.create({
      userEmail: email,
      reelUrl: req.file.originalname,
      transcript: transcription.text
    });

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      transcript: transcription.text,
      creditsLeft: user ? user.credits : 0
    });

  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── TRANSCRIBE URL (Instagram + YouTube) ──
app.post("/transcribe-url", async (req, res) => {
  const { email, url } = req.body;

  if (!email || !url) {
    return res.status(400).json({ success: false, error: "Email aur URL required hai" });
  }

  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  const isInstagram = url.includes("instagram.com");

  if (!isYouTube && !isInstagram) {
    return res.status(400).json({
      success: false,
      error: "Sirf YouTube aur Instagram URLs supported hain"
    });
  }

  const user = await User.findOne({ email });
const isGuest = !user;

if (!isGuest && user.credits < 2) {
    return res.status(400).json({
      success: false,
      error: "Credits khatam ho gaye! Admin se contact karein."
    });
  }

  // ── YOUTUBE FLOW ──
  if (isYouTube) {
    try {
      console.log("⏳ YouTube transcript fetch kar raha hoon...");

      const videoId = getYouTubeVideoId(url);
      if (!videoId) {
        return res.status(400).json({ success: false, error: "Invalid YouTube URL" });
      }

      // Transcript fetch karo
      const transcriptArr = await YoutubeTranscript.fetchTranscript(videoId);

      if (!transcriptArr || transcriptArr.length === 0) {
        return res.status(400).json({
          success: false,
          error: "Is video mein transcript/captions available nahi hain."
        });
      }

      // Array ko plain text mein convert karo
      const transcript = transcriptArr
        .map(item => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      console.log("✅ YouTube transcript ready");

      // Credits kato
      user.credits -= 2;
      await user.save();

      // History save karo
      await Reel.create({
        userEmail: email,
        reelUrl: url,
        transcript
      });

      return res.json({
        success: true,
        transcript,
        creditsLeft: user.credits,
        source: "youtube-captions"
      });

    } catch (error) {
      console.error("YouTube Transcript Error:", error.message);

      let errorMsg = "YouTube transcript fetch nahi hua.";
      if (error.message.includes("disabled") || error.message.includes("Transcript is disabled")) {
        errorMsg = "Is video mein captions disabled hain. Dusra video try karo.";
      } else if (error.message.includes("available")) {
        errorMsg = "Is video mein transcript available nahi hai.";
      }

      return res.status(500).json({ success: false, error: errorMsg });
    }
  }

  // ── INSTAGRAM FLOW ──
  const outputPath = path.join(__dirname, "uploads", `${Date.now()}_insta.mp4`);

  try {
    console.log("⏳ RapidAPI se video URL la raha hoon...");
    const videoUrl = await getInstagramVideoUrl(url);
    console.log("✅ Video URL mila:", videoUrl.substring(0, 60) + "...");

    console.log("⏳ Video download ho rahi hai...");
    await downloadVideo(videoUrl, outputPath);
    console.log("✅ Video download complete");

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ success: false, error: "Video download nahi hua" });
    }

    console.log("⏳ Transcribing...");
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(outputPath),
      model: "whisper-large-v3-turbo"
    });
    console.log("✅ Transcript ready");

    user.credits -= 2;
    await user.save();

    await Reel.create({
      userEmail: email,
      reelUrl: url,
      transcript: transcription.text
    });

    fs.unlinkSync(outputPath);

    return res.json({
      success: true,
      transcript: transcription.text,
      creditsLeft: user.credits,
      source: "groq-whisper"
    });

  } catch (error) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    console.error("Instagram Transcribe Error:", error.message);

    let errorMsg = "URL se video nahi mil saka.";
    if (error.message.includes("private") || error.message.includes("Private")) {
      errorMsg = "Yeh video private hai! Public reel ka URL daalo.";
    } else if (error.message.includes("Video URL nahi mila")) {
      errorMsg = "Reel nahi mili. Sahi public URL daalo (reel/ ya p/ wala).";
    } else if (error.response?.status === 429) {
      errorMsg = "RapidAPI limit khatam ho gayi. Thodi der baad try karo.";
    }

    return res.status(500).json({ success: false, error: errorMsg });
  }
});

// ── CREDITS ──
app.get("/credits/:email", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true, credits: user.credits });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── HISTORY ──
app.get("/history/:email", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const reels = await Reel.find({ userEmail: req.params.email }).sort({ createdAt: -1 });
    res.json({ success: true, data: reels });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── ADMIN: ALL USERS ──
app.get("/admin/users", adminAuth, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── ADMIN: ADD CREDITS ──
app.post("/admin/add-credit", adminAuth, async (req, res) => {
  try {
    const { email, credits } = req.body;
    if (!email || !credits) return res.status(400).json({ success: false, error: "Email aur credits required" });

    const user = await User.findOneAndUpdate(
      { email },
      { $inc: { credits: parseInt(credits) } },
      { new: true }
    );

    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    res.json({ success: true, message: `${credits} credits add kiye`, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
