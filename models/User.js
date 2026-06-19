const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true
  },

  name: {
    type: String,
    required: true
  },

  credits: {
    type: Number,
    default: 10
  }

}, {
  timestamps: true
});

module.exports = mongoose.model("User", UserSchema);
