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
