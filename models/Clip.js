const mongoose = require("mongoose");

const ClipItemSchema = new mongoose.Schema(
  {
    title: { type: String, default: "" },
    reason: { type: String, default: "" },
    duration: { type: Number, default: 0 },
    url: { type: String, required: true },
    s3Key: { type: String, required: true },
    downloaded: { type: Boolean, default: false },
    // Once a clip is downloaded we schedule real S3 deletion 5 min later;
    // this timestamp lets the sweep job find it again even after a restart.
    downloadedAt: { type: Date, default: null },
    deleted: { type: Boolean, default: false }
  },
  { _id: false }
);

const ClipJobSchema = new mongoose.Schema(
  {
    userEmail: {
      type: String,
      required: true
    },

    ytUrl: {
      type: String,
      default: ""
    },

    ytTitle: {
      type: String,
      default: ""
    },

    clips: {
      type: [ClipItemSchema],
      default: []
    }

  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("ClipJob", ClipJobSchema);
