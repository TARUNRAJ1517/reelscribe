require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Groq = require("groq-sdk");
const nodemailer = require("nodemailer");

const Reel = require("./models/Reel");
const User = require("./models/User");

const app = express();

app.use(express.json());
app.use(express.static("public"));

const groq = new Groq({
apiKey: process.env.GROQ_API_KEY
});

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.log("❌ MongoDB Error:", err));

const otpStore = {};

const transporter = nodemailer.createTransport({
service: "gmail",
auth: {
user: process.env.EMAIL_USER,
pass: process.env.EMAIL_PASS
}
});

const storage = multer.diskStorage({
destination: (req, file, cb) => {
cb(null, "uploads/");
},

filename: (req, file, cb) => {
cb(
null,
Date.now() +
path.extname(file.originalname)
);
}
});

const upload = multer({ storage });

app.post("/send-otp", async (req, res) => {

try {

const { email } = req.body;

if (!email) {
  return res.status(400).json({
    success: false,
    message: "Email required"
  });
}

const otp = Math.floor(
  100000 + Math.random() * 900000
).toString();

otpStore[email] = otp;

const info = await transporter.sendMail({
  from: process.env.EMAIL_USER,
  to: email,
  subject: "ReelScribe OTP Verification",
  html: `
    <h2>ReelScribe Login</h2>
    <p>Your OTP is:</p>
    <h1>${otp}</h1>
  `
});

console.log("MAIL SENT:", info.response);

res.json({
  success: true,
  message: "OTP Sent"
});

catch (error) {

  console.error("MAIL ERROR:", error);

  res.status(500).json({
    success: false,
    error: error.message
  });

}

});
app.post("/verify-otp", async (req, res) => {

try {

const { email, otp } = req.body;

if (otpStore[email] !== otp) {
  return res.status(400).json({
    success: false,
    message: "Invalid OTP"
  });
}

let user = await User.findOne({ email });

if (!user) {

  user = await User.create({
    name: email.split("@")[0],
    email: email
  });

}

delete otpStore[email];

res.json({
  success: true,
  user
});

} catch (error) {

res.status(500).json({
  success: false,
  error: error.message
});

}

});

app.post(
"/transcribe",
upload.single("video"),
async (req, res) => {

try {

  const { email } = req.body;

  const user =
    await User.findOne({ email });

  if (!user) {
    return res.status(404).json({
      success: false,
      error: "User not found"
    });
  }

  if (user.credits <= 0) {
    return res.status(400).json({
      success: false,
      error: "No credits left"
    });
  }

  const filePath = req.file.path;

  const transcription =
    await groq.audio.transcriptions.create({
      file: fs.createReadStream(
        filePath
      ),
      model:
        "whisper-large-v3-turbo"
    });

  user.credits -= 1;
  await user.save();

  await Reel.create({
    userEmail: email,
    reelUrl:
      req.file.originalname,
    transcript:
      transcription.text
  });

  fs.unlinkSync(filePath);

  res.json({
    success: true,
    transcript:
      transcription.text,
    creditsLeft:
      user.credits
  });

} catch (error) {

  console.error(error);

  res.status(500).json({
    success: false,
    error: error.message
  });

}

}
);

app.get(
"/credits/:email",
async (req, res) => {

try {

  const user =
    await User.findOne({
      email:
      req.params.email
    });

  if (!user) {
    return res.status(404).json({
      success:false
    });
  }

  res.json({
    success:true,
    credits:user.credits
  });

} catch (error) {

  res.status(500).json({
    success:false,
    error:error.message
  });

}

}
);

app.get(
"/history/:email",
async (req, res) => {

try {

  const reels =
    await Reel.find({
      userEmail:
      req.params.email
    })
    .sort({
      createdAt:-1
    });

  res.json({
    success:true,
    data:reels
  });

} catch (error) {

  res.status(500).json({
    success:false,
    error:error.message
  });

}

}
);

app.get("/users", async (req, res) => {

try {

const users =
  await User.find()
  .sort({ createdAt: -1 });

res.json(users);

} catch (error) {

res.status(500).json({
  success: false,
  error: error.message
});

}

});

app.get("/", (req, res) => {
res.send("🚀 ReelScribe Backend Running");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

console.log(
"🚀 Server running on ${PORT}"
);

});
