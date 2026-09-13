const mongoose = require("mongoose");

const ReelSchema = new mongoose.Schema(
{
userEmail: {
type: String,
required: true
},

reelUrl: {
  type: String,
  default: ""
},

transcript: {
  type: String,
  required: true
}

},
{
timestamps: true
}
);

module.exports = mongoose.model("Reel", ReelSchema);

// Fast per-user history queries.
ReelSchema.index({ userEmail: 1, createdAt: -1 });
