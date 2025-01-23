const mongoose = require("mongoose");

const ClubSchema = new mongoose.Schema({
  name: { type: String, required: true },
  city: { type: mongoose.Schema.Types.ObjectId, ref: "City", required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Club", ClubSchema); 