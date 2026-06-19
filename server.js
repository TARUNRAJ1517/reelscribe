require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
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
app.use(express.static("public")); 
app.use(session({
  secret: "reelscribe_secret",
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});




// frontend serve karega

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

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback"
    },
    async (accessToken, refreshToken, profile, done) => {

      try {

        let user = await User.findOne({
          email: profile.emails[0].value
        });

        if (!user) {

          user = await User.create({
            name: profile.displayName,
            email: profile.emails[0].value
          });

        }

        return done(null, user);

      } catch (error) {

        return done(error, null);

      }
    }
  )
);

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
console.error(error);

res.status(500).json({
  success: false,
  error: error.message
});

}
});
// Reel Transcribe (Coming Soon)
app.post("/reel-transcribe", async (req, res) => {
res.json({
success: false,
message: "Reel URL feature coming soon"
});
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
// Admin Add Credits
app.post("/admin/add-credit", async (req, res) => {
  try {

    const { email, credits } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    user.credits += Number(credits);
    await user.save();

    res.json({
      success: true,
      email: user.email,
      credits: user.credits
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });

  }
});

app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"]
  })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/"
  }),
  (req, res) => {
    res.redirect("/");
  }
);

app.get("/me", (req, res) => {

  if (!req.user) {

    return res.json({
      loggedIn: false
    });

  }

  res.json({
    loggedIn: true,
    user: req.user
  });

});

// Get All Reels
app.get("/reels", async (req, res) => {
try {

const reels = await Reel.find()
  .sort({ createdAt: -1 });

res.json(reels);

} catch (error) {

res.status(500).json({
  error: error.message
});

}
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
console.log(`Server running on ${PORT}`);
});
