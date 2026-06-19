const mongoose = require("mongoose");

const ReelSchema = new mongoose.Schema({
userEmail: {
type: String,
required: true
},

reelUrl: {
type: String,
required: true
},

transcript: {
type: String,
default: ""
}

}, {
timestamps: true
});

module.exports = mongoose.model("Reel", ReelSchema);
