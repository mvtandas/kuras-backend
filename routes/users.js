const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const router = express.Router();
const User = require("../models/user");
const Role = require("../models/role");
const BlacklistedToken = require("../models/blacklistedToken");
const auth = require("../middleware/auth");
const City = require("../models/city");
const Club = require("../models/club");

// Create a user
router.post("/", async (req, res) => {
  const {
    name,
    surname,
    gender,
    birthDate,
    fatherName,
    motherName,
    cityId,
    clubId,
    roleId,
    sportStartDate,
    athleteLicenseNo,
    email,
    password
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
      !motherName || !cityId || !clubId || !roleId || !sportStartDate || 
      !email || !password) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role, City ve Club varlığını kontrol et
    const [role, city, club] = await Promise.all([
      Role.findById(roleId),
      City.findById(cityId),
      Club.findById(clubId)
    ]);

    if (!role || !city || !club) {
      return res.status(404).json({ 
        message: "Rol, şehir veya kulüp bulunamadı" 
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      name,
      surname,
      gender,
      birthDate,
      fatherName,
      motherName,
      city: cityId,
      club: clubId,
      role: roleId,
      sportStartDate,
      athleteLicenseNo,
      email,
      password: hashedPassword
    });

    await user.save();
    
    // Şifre hariç kullanıcı bilgilerini döndür
    const userResponse = await User.findById(user._id)
      .select('-password')
      .populate(['role', 'city', 'club']);
      
    res.status(201).json(userResponse);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Login a user
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ message: "Email and password are required" });

  try {
    const user = await User.findOne({ email }).populate("role");
    if (!user) return res.status(404).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign({ id: user._id, role: user.role.name }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    res.status(200).json({ token });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Logout a user
router.post("/logout", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    
    if (!token) {
      return res.status(400).json({ message: "Token bulunamadı" });
    }

    // Token'ı blacklist'e ekle
    const blacklistedToken = new BlacklistedToken({ token });
    await blacklistedToken.save();

    res.status(200).json({ message: "Başarıyla çıkış yapıldı" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get current user info
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select("-password")
      .populate("role");
    
    if (!user) {
      return res.status(404).json({ message: "Kullanıcı bulunamadı" });
    }

    res.status(200).json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all users (admin only)
router.get("/", auth, async (req, res) => {
  try {
    // Kullanıcının admin olup olmadığını kontrol et
    if (req.user.role !== "Admin") {
      return res.status(403).json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    }

    const users = await User.find()
      .select("-password")
      .populate("role");

    res.status(200).json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
