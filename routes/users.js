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
router.post("/create-athlete", async (req, res) => {
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
    password,
    identityNumber
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
      !motherName || !cityId || !clubId || !roleId || !sportStartDate || 
      !email || !password || !identityNumber) {
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
      password: hashedPassword,
      identityNumber,
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

router.post("/update-athlete/:id", async (req, res) => {
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
    identityNumber,
    bloodType,
    religion,
    nationality,
    serialNumber,
    educationStatus,
    language,
    bankInfo,
    passportInfo,
    workPhone,
    workAddress,
    homePhone,
    homeAddress,
    mobilePhone,
    website,
    coach,
    showInStatistics,
    licenseNo,
    startDate,
    province,
    district,
    institutionPosition,
    isAthlete,
    isVisuallyImpairedAthlete,
    isHearingImpairedAthlete,
    coachVisaYear,
    isCoach,
    coachStatus,
    isReferee,
    refereeVisaYear,
    isProvincialRepresentative,
    isStaff,
    isBoardMember,
    athleteAchievements,
    
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (
    !name || !surname || !gender || !birthDate || !fatherName || 
    !motherName || !cityId || !clubId || !roleId || !sportStartDate || 
    !email || !identityNumber
  ) {
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

    // Güncelleme işlemi
    const athlete = await User.findById(req.params.id);
    if (!athlete) {
      return res.status(404).json({ message: "Sporcu bulunamadı" });
    }

    // Verilen tüm alanları güncelle
    Object.assign(athlete, {
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
      identityNumber,
      bloodType,
      religion,
      nationality,
      serialNumber,
      educationStatus,
      language,
      bankInfo,
      passportInfo,
      workPhone,
      workAddress,
      homePhone,
      homeAddress,
      mobilePhone,
      website,
      coach,
      showInStatistics,
      licenseNo,
      startDate,
      province,
      district,
      institutionPosition,
      isAthlete,
      isVisuallyImpairedAthlete,
      isHearingImpairedAthlete,
      coachVisaYear,
      isCoach,
      coachStatus,
      isReferee,
      refereeVisaYear,
      isProvincialRepresentative,
      isStaff,
      isBoardMember,
      athleteAchievements
    });

    // Kaydet ve yanıt dön
    await athlete.save();

    res.status(200).json({ message: "Sporcu başarıyla güncellendi", athlete });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.post("/delete-athlete/:id", async (req, res) => {
  try {
    const athlete = await User.findByIdAndDelete(req.params.id);
    if (!athlete) {
      return res.status(404).json({ message: "Sporcu bulunamadı" });
    }

    res.status(200).json({ message: "Sporcu başarıyla silindi" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-athletes", async (req, res) => {
  try {
    const role = await Role.findOne({ name: "Athlete" });
    const athletes = await User.find({ role: role._id })
      .select("-password")
      .populate(["role", "city", "club"]);

    res.status(200).json(athletes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-athlete/:id", async (req, res) => {
   try {
    const athlete = await User.findById(req.params.id)
      .select("-password")
      .populate(["role", "city", "club"]);

    if (!athlete) {
      return res.status(404).json({ message: "Sporcu bulunamadı" });
    }

    res.status(200).json(athlete);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
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
