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

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

app.use(express.json());
app.use(express.static("public"));

const otpStore = {};

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

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

// Send OTP
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

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "ReelScribe OTP Verification",
      html: `
        <h2>ReelScribe Login</h2>
        <p>Your OTP is:</p>
        <h1>${otp}</h1>
      `
    });

    res.json({
      success: true,
      message: "OTP Sent"
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

// Verify OTP
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
