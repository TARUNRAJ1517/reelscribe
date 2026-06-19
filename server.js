const express = require("express");
const mongoose = require("mongoose");

const app = express();

app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.log("❌ MongoDB Error:", err));

app.get("/", (req, res) => {
  res.send("ReelScribe Backend Running 🚀");
});

// Test API
app.post("/transcript", async (req, res) => {
  try {
    const { reelUrl } = req.body;

    if (!reelUrl) {
      return res.status(400).json({
        success: false,
        message: "Reel URL required"
      });
    }

    return res.json({
      success: true,
      reelUrl,
      transcript: "Demo transcript generated successfully 🎉"
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
