const mongoose = require("mongoose");

const ReelSchema = new mongoose.Schema({
  reelUrl: {
    type: String,
    required: true
  },
  transcript: {
    type: String,
    default: ""
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("Reel", ReelSchema);
