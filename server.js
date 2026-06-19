const express = require("express");
const mongoose = require("mongoose");
const Reel = require("./models/Reel");
const User = require("./models/User");

const app = express();

app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

app.get("/", (req, res) => {
  res.send("ReelScribe Backend Running 🚀");
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
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
