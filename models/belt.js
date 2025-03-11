const mongoose = require("mongoose");

const BeltSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  value: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Belt", BeltSchema); 