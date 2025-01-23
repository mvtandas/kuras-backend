const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  surname: { type: String, required: true },
  gender: { type: String, enum: ['Erkek', 'Kadın'], required: true },
  birthDate: { type: Date, required: true },
  fatherName: { type: String, required: true },
  motherName: { type: String, required: true },
  city: { type: mongoose.Schema.Types.ObjectId, ref: "City", required: true },
  club: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
  role: { type: mongoose.Schema.Types.ObjectId, ref: "Role", required: true },
  sportStartDate: { type: Date, required: true },
  athleteLicenseNo: { type: String, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // Hashed password
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("User", UserSchema);
