
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const Groq = require("groq-sdk");
const nodemailer = require("nodemailer");

const Reel = require("./models/Reel");
const User = require("./models/User");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

// OTP store with expiry
const otpStore = {};

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// File upload — 25MB limit
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// ── ADMIN MIDDLEWARE ──
function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (key !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

// ── SEND OTP ──
app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email required" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = {
      otp,
      expiresAt: Date.now() + 5 * 60 * 1000 // 5 min expiry
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
      user = await User.create({ name: email.split("@")[0], email });
    }

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── TRANSCRIBE ──
app.post("/transcribe", upload.single("video"), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: "Email required" });

    const user = await User.findOne({ email });

    if (!user) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, error: "User not found. Pehle login karein." });
    }

    if (user.credits <= 0) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: "Credits khatam ho gaye! Admin se contact karein." });
    }

    const filePath = req.file.path;

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3-turbo"
    });

    user.credits -= 1;
    await user.save();

    await Reel.create({
      userEmail: email,
      reelUrl: req.file.originalname,
      transcript: transcription.text
    });

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      transcript: transcription.text,
      creditsLeft: user.credits
    });

  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: error.message });
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
    // Verify user exists
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const reels = await Reel.find({ userEmail: req.params.email }).sort({ createdAt: -1 });
    res.json({ success: true, data: reels });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── ADMIN: ALL USERS (protected) ──
app.get("/admin/users", adminAuth, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── ADMIN: ADD CREDITS (protected) ──
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
