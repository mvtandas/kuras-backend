const mongoose = require("mongoose");

const BlacklistedTokenSchema = new mongoose.Schema({
  token: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 } // 24 saat sonra otomatik silinir
});

module.exports = mongoose.model("BlacklistedToken", BlacklistedTokenSchema); 