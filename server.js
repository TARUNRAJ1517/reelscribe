require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Groq = require("groq-sdk");
const axios = require("axios");
const instagramGetUrl = require("instagram-url-direct").default;

const Reel = require("./models/Reel");
const User = require("./models/User");

const app = express();
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

app.use(express.json());
app.use(express.static("public")); // frontend serve karega

// Multer Storage
const storage = multer.diskStorage({
destination: function (req, file, cb) {
cb(null, "uploads/");
},

filename: function (req, file, cb) {
cb(null, Date.now() + path.extname(file.originalname));
}
});

const upload = multer({ storage });

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.log("❌ MongoDB Error:", err));

// Register User
app.post("/register", async (req, res) => {
try {
const { name, email } = req.body;

let user = await User.findOne({ email });

if (user) {
  return res.json({
    success: true,
    message: "User already exists",
    user
  });
}

user = await User.create({
  name,
  email
});

res.json({
  success: true,
  message: "User registered successfully",
  user
});

} catch (error) {
res.status(500).json({
success: false,
error: error.message
});
}
});

// Get All Users
app.get("/users", async (req, res) => {
try {
const users = await User.find().sort({ createdAt: -1 });
res.json(users);
} catch (error) {
res.status(500).json({ error: error.message });
}
});

// Check Credits
app.get("/credits/:email", async (req, res) => {
try {
const user = await User.findOne({ email: req.params.email });

if (!user) {
  return res.status(404).json({
    success: false,
    message: "User not found"
  });
}

res.json({
  success: true,
  credits: user.credits
});

} catch (error) {
res.status(500).json({
success: false,
error: error.message
});
}
});

// Use 1 Credit
app.post("/use-credit", async (req, res) => {
try {
const { email } = req.body;

const user = await User.findOne({ email });

if (!user) {
  return res.status(404).json({
    success: false,
    message: "User not found"
  });
}

if (user.credits <= 0) {
  return res.status(400).json({
    success: false,
    message: "No credits left"
  });
}

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
  credits: user.credits
});

} catch (error) {
res.status(500).json({
success: false,
error: error.message
});
}
});

// Save Reel
app.post("/save", async (req, res) => {
try {
const { userEmail, reelUrl, transcript } = req.body;

const reel = new Reel({
  userEmail,
  reelUrl,
  transcript
});

await reel.save();

res.json({
  success: true,
  message: "Reel Saved Successfully",
  reel
});

} catch (error) {
res.status(500).json({
success: false,
error: error.message
});
}
});

// Upload Video
app.post("/upload", upload.single("video"), async (req, res) => {
try {
res.json({
success: true,
file: req.file.filename,
path: req.file.path
});
} catch (error) {
res.status(500).json({
success: false,
error: error.message
});
}
});

// Transcribe Video
app.post("/transcribe", upload.single("video"), async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (user.credits <= 0) {
      return res.status(400).json({
        success: false,
        message: "No credits left"
      });
    }

    const filePath = req.file.path;

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3-turbo"
    });

    user.credits -= 1;
    await user.save();

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      transcript: transcription.text,
      creditsLeft: user.credits
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Reel Transcribe
app.post("/reel-transcribe", async (req, res) => {
try {

const instaPackage = require("instagram-url-direct");

res.json({
  success: true,
  packageType: typeof instaPackage,
  packageData: instaPackage
});

} catch (error) {
res.json({
success: false,
error: error.message,
stack: error.stack
});
}
});

// User History
app.get("/history/:email", async (req, res) => {
  try {

    const reels = await Reel.find({
      userEmail: req.params.email
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      total: reels.length,
      data: reels
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });

  }
});

// Get All Reels
app.get("/reels", async (req, res) => {
try {
const reels = await Reel.find().sort({ createdAt: -1 });
res.json(reels);
} catch (error) {
res.status(500).json({ error: error.message });
}
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
