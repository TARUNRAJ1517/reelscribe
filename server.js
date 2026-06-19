const express = require("express");
const mongoose = require("mongoose");
const Reel = require("./models/Reel");
const User = require("./models/User");

const app = express();

app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.log("❌ MongoDB Error:", err));

// Home
app.get("/", (req, res) => {
res.send("ReelScribe Backend Running 🚀");
});

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
res.status(500).json({
error: error.message
});
}
});

// Check Credits
app.get("/credits/:email", async (req, res) => {
try {
const user = await User.findOne({
email: req.params.email
});

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

// Save Reel
app.post("/save", async (req, res) => {
try {
const { reelUrl, transcript } = req.body;

const reel = new Reel({
  reelUrl,
  transcript
});

await reel.save();

res.json({
  success: true,
  message: "Reel Saved Successfully"
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
res.status(500).json({
error: error.message
});
}
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
console.log("Server running on ${PORT}");
});
