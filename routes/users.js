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
const Belt = require("../models/belt");

// Create a user
router.post("/create-athlete", auth, async (req, res) => {
  let {
    name,
    surname,
    gender,
    birthDate,
    fatherName,
    motherName,
    cityId,
    clubId,
    sportStartDate,
    athleteLicenseNo,
    email,
    password,
    identityNumber,
    belt,
    weight,
    mobilePhone,
  } = req.body;

  // Tüm gerekli alanların kontrolü
  const requiredFields = {
    name: "İsim",
    surname: "Soyisim",
    gender: "Cinsiyet",
    birthDate: "Doğum Tarihi",
    fatherName: "Baba Adı",
    motherName: "Anne Adı",
    sportStartDate: "Spor Başlangıç Tarihi",
    password: "Şifre",
    identityNumber: "Kimlik Numarası",
    clubId: "Kulüp",
  };

  // Eğer kullanıcı admin ise, şehir ve kulüp alanlarını zorunlu yap
  if (req.user && req.user.role.name === "Admin") {
    requiredFields.cityId = "Şehir";
  }

  const missingFields = [];
  for (const [field, label] of Object.entries(requiredFields)) {
    if (!req.body[field]) {
      missingFields.push(label);
    }
  }

  if (missingFields.length > 0) {
    return res.status(400).json({
      message: "Eksik alanlar var",
      missingFields: missingFields,
    });
  }

  try {
    // Eğer kullanıcı admin değilse, kendi şehir ID'sini kullan
    if (req.user && req.user.role.name !== "Admin") {
      if (!req.user.city) {
        return res.status(400).json({
          message: "Kullanıcının şehir bilgisi bulunamadı",
        });
      }

      const userCity = await City.findById(req.user.city._id || req.user.city);
      if (!userCity) {
        return res.status(400).json({
          message: "Kullanıcının şehir bilgisi geçersiz",
        });
      }
      // Şehir ID'sini kullanıcının şehri olarak güncelle
      cityId = userCity._id;
    }

    // Şehir kontrolü
    const city = await City.findById(cityId);
    if (!city) {
      return res.status(404).json({
        message: `Şehir bulunamadı (ID: ${cityId})`,
      });
    }

    // Role kontrolü
    const role = await Role.findOne({ name: "Athlete" });
    if (!role) {
      return res.status(404).json({
        message: "Rol bulunamadı",
      });
    }

    // Eğer belt bir string ise, ilgili Belt belgesini bul
    let beltId = belt;
    if (belt && typeof belt === "string") {
      const beltDoc = await Belt.findOne({ name: belt });
      if (beltDoc) {
        beltId = beltDoc._id;
      } else {
        return res.status(400).json({ message: "Belirtilen kemer bulunamadı" });
      }
    }

    const isAthlete = true;

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
      role: role._id,
      sportStartDate,
      athleteLicenseNo,
      email,
      password: hashedPassword,
      identityNumber,
      isAthlete: true,
      belt: beltId,
      weight,
      mobilePhone,
    });

    await user.save();

    // Şifre hariç kullanıcı bilgilerini döndür
    const userResponse = await User.findById(user._id)
      .select("-password")
      .populate(["role", "city", "club", "belt"]);

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
    isVisuallyImpairedAthlete,
    isHearingImpairedAthlete,
    athleteAchievements,
    belt,
    weight,
  } = req.body;

  try {
    // Güncelleme işlemi
    const athlete = await User.findById(req.params.id);
    if (!athlete) {
      return res.status(404).json({ message: "Sporcu bulunamadı" });
    }

    // Eğer e-posta değişiyorsa ve yeni e-posta başka bir kullanıcı tarafından kullanılıyorsa hata döndür
    if (email && email !== athlete.email) {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res
          .status(400)
          .json({ message: "Bu e-posta adresi zaten kullanılıyor" });
      }
    }

    // Eğer belt bir string ise, ilgili Belt belgesini bul
    let beltId = belt;
    if (belt && typeof belt === "string") {
      const beltDoc = await Belt.findOne({ name: belt });
      if (beltDoc) {
        beltId = beltDoc._id;
      } else {
        return res.status(400).json({ message: "Belirtilen kemer bulunamadı" });
      }
    }

    // Sadece gönderilen alanları güncelle
    const updateFields = {};
    if (name) updateFields.name = name;
    if (surname) updateFields.surname = surname;
    if (gender) updateFields.gender = gender;
    if (birthDate) updateFields.birthDate = birthDate;
    if (fatherName) updateFields.fatherName = fatherName;
    if (motherName) updateFields.motherName = motherName;
    if (cityId) updateFields.city = cityId;
    if (clubId) updateFields.club = clubId;
    if (sportStartDate) updateFields.sportStartDate = sportStartDate;
    if (athleteLicenseNo) updateFields.athleteLicenseNo = athleteLicenseNo;
    if (email) updateFields.email = email;
    if (identityNumber) updateFields.identityNumber = identityNumber;
    if (bloodType) updateFields.bloodType = bloodType;
    if (religion) updateFields.religion = religion;
    if (nationality) updateFields.nationality = nationality;
    if (serialNumber) updateFields.serialNumber = serialNumber;
    if (educationStatus) updateFields.educationStatus = educationStatus;
    if (language) updateFields.language = language;
    if (bankInfo) updateFields.bankInfo = bankInfo;
    if (passportInfo) updateFields.passportInfo = passportInfo;
    if (workPhone) updateFields.workPhone = workPhone;
    if (workAddress) updateFields.workAddress = workAddress;
    if (homePhone) updateFields.homePhone = homePhone;
    if (homeAddress) updateFields.homeAddress = homeAddress;
    if (mobilePhone) updateFields.mobilePhone = mobilePhone;
    if (website) updateFields.website = website;
    if (coach) updateFields.coach = coach;
    if (showInStatistics !== undefined)
      updateFields.showInStatistics = showInStatistics;
    if (licenseNo) updateFields.licenseNo = licenseNo;
    if (startDate) updateFields.startDate = startDate;
    if (province) updateFields.province = province;
    if (district) updateFields.district = district;
    if (isVisuallyImpairedAthlete !== undefined)
      updateFields.isVisuallyImpairedAthlete = isVisuallyImpairedAthlete;
    if (isHearingImpairedAthlete !== undefined)
      updateFields.isHearingImpairedAthlete = isHearingImpairedAthlete;
    if (athleteAchievements)
      updateFields.athleteAchievements = athleteAchievements;
    if (beltId) updateFields.belt = beltId;
    if (weight !== undefined) updateFields.weight = weight;

    // Verilen alanları güncelle
    Object.assign(athlete, updateFields);

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

router.get("/get-athletes", auth, async (req, res) => {
  try {
    const role = await Role.findOne({ name: "Athlete" });
    if (!role) {
      return res.status(404).json({ message: "Sporcu rolü bulunamadı" });
    }

    // Query parametrelerinden minBeltValue, minDate ve maxDate değerlerini al
    const { minBeltValue, minDate, maxDate } = req.query;

    // Temel sorgu
    let query = { role: role._id };

    // Eğer kullanıcı Athlete ise, sadece kendisini göster
    if (req.user.role.name === "Athlete") {
      console.log("Sporcu bilgileri:", {
        id: req.user._id,
        name: req.user.name,
        role: req.user.role.name,
      });

      query._id = req.user._id;
    }
    // Eğer kullanıcı Coach ise, sadece kendi şehir ve kulübündeki sporcuları göster
    else if (req.user.role.name === "Coach") {
      console.log("Coach bilgileri:", {
        id: req.user._id,
        name: req.user.name,
        role: req.user.role.name,
        city: req.user.city,
      });

      if (!req.user.city) {
        return res.status(400).json({
          message: "Coach'un şehir veya kulüp bilgisi eksik",
        });
      }

      // Şehir ve kulüp ID'lerini kontrol et
      const cityId = req.user.city._id || req.user.city;

      if (!cityId) {
        return res.status(400).json({
          message: "Coach'un şehir veya kulüp ID'si geçersiz",
        });
      }

      query.city = cityId;
    }
    // Eğer kullanıcı Referee ise, sadece kendi şehrindeki sporcuları göster
    else if (req.user.role.name === "Referee") {
      console.log("Hakem bilgileri:", {
        id: req.user._id,
        name: req.user.name,
        role: req.user.role.name,
        city: req.user.city,
      });

      if (!req.user.city) {
        return res.status(400).json({
          message: "Hakemin şehir bilgisi eksik",
        });
      }

      // Şehir ID'sini kontrol et
      const cityId = req.user.city._id || req.user.city;
      if (!cityId) {
        return res.status(400).json({
          message: "Hakemin şehir ID'si geçersiz",
        });
      }

      query.city = cityId;
    }
    // Eğer kullanıcı Representetive ise, sadece kendi şehrindeki sporcuları göster
    else if (req.user.role.name === "Representetive") {
      console.log("Temsilci bilgileri:", {
        id: req.user._id,
        name: req.user.name,
        role: req.user.role.name,
        city: req.user.city,
      });

      if (!req.user.city) {
        return res.status(400).json({
          message: "Temsilcinin şehir bilgisi eksik",
        });
      }

      // Şehir ID'sini kontrol et
      const cityId = req.user.city._id || req.user.city;
      if (!cityId) {
        return res.status(400).json({
          message: "Temsilcinin şehir ID'si geçersiz",
        });
      }

      query.city = cityId;
    }

    // Eğer minBeltValue belirtilmişse, kemer değeri filtresini ekle
    if (minBeltValue && !isNaN(Number(minBeltValue))) {
      const belts = await Belt.find({ value: { $gte: Number(minBeltValue) } });
      const beltIds = belts.map((belt) => belt._id);
      query.belt = { $in: beltIds };
    }

    // Doğum tarihi filtresini ekle
    if (minDate || maxDate) {
      query.birthDate = {};
      if (minDate) {
        query.birthDate.$gte = new Date(minDate);
      }
      if (maxDate) {
        query.birthDate.$lte = new Date(maxDate);
      }
    }

    console.log("Oluşturulan sorgu:", JSON.stringify(query, null, 2));

    // Önce sorguyu test et
    const testQuery = await User.find(query).countDocuments();
    console.log("Sorgu sonucu bulunan toplam kayıt sayısı:", testQuery);

    const athletes = await User.find(query)
      .select("-password")
      .populate({
        path: "role",
        select: "name",
      })
      .populate({
        path: "city",
        select: "name _id",
      })
      .populate({
        path: "club",
        select: "name _id",
      })
      .populate({
        path: "belt",
        select: "name value _id",
      });

    console.log("Bulunan sporcu sayısı:", athletes.length);
    if (athletes.length > 0) {
      console.log("İlk sporcu örneği:", {
        id: athletes[0]._id,
        name: athletes[0].name,
        city: athletes[0].city,
        club: athletes[0].club,
      });
    }

    res.status(200).json(athletes);
  } catch (error) {
    console.error("Hata detayı:", error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-athlete/:id", auth, async (req, res) => {
  try {
    const athlete = await User.findById(req.params.id)
      .select("-password")
      .populate([
        "role",
        "city",
        "club",
        "belt",
        {
          path: "beltHistory",
          populate: {
            path: "belt",
            select: "name value _id",
          },
        },
      ]);

    if (!athlete) {
      return res.status(404).json({ message: "Sporcu bulunamadı" });
    }

    // Eğer kullanıcı Coach ise ve sporcu farklı bir şehirdeyse erişimi engelle
    if (
      req.user.role.name === "Coach" &&
      athlete.city._id.toString() !== req.user.city._id.toString()
    ) {
      return res
        .status(403)
        .json({ message: "Bu sporcuya erişim yetkiniz yok" });
    }

    res.status(200).json(athlete);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.post("/create-coach", async (req, res) => {
  const {
    name,
    surname,
    gender,
    birthDate,
    fatherName,
    motherName,
    cityId,
    clubId,
    sportStartDate,
    athleteLicenseNo,
    email,
    password,
    identityNumber,
    belt,
    mobilePhone,
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (
    !name ||
    !surname ||
    !gender ||
    !birthDate ||
    !fatherName ||
    !motherName ||
    !cityId ||
    !clubId ||
    !email ||
    !password ||
    !identityNumber
  ) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role kontrolü
    const role = await Role.findOne({ name: "Coach" });
    if (!role) {
      return res.status(404).json({
        message: "Rol bulunamadı",
      });
    }

    // Eğer kullanıcı admin değilse, kendi şehir ID'sini kullan
    if (req.user && req.user.role.name !== "Admin") {
      const userCity = await City.findById(req.user.city._id || req.user.city);
      if (!userCity) {
        return res.status(400).json({
          message: "Kullanıcının şehir bilgisi geçersiz",
        });
      }
      if (userCity._id.toString() !== cityId) {
        return res.status(403).json({
          message: "Sadece kendi şehrinize antrenör ekleyebilirsiniz",
        });
      }
    }

    // Eğer belt bir string ise, ilgili Belt belgesini bul
    let beltId = belt;
    if (belt && typeof belt === "string" && belt.trim() !== '') {
      const beltDoc = await Belt.findOne({ name: belt });
      if (beltDoc) {
        beltId = beltDoc._id;
      } else {
        return res.status(400).json({ message: "Belirtilen kemer bulunamadı" });
      }
    } else {
      beltId = undefined; // Boş belt değeri için undefined kullan
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
      role: role._id,
      sportStartDate,
      athleteLicenseNo,
      email,
      password: hashedPassword,
      isCoach: true,
      belt: beltId,
      mobilePhone,
    });

    await user.save();

    // Şifre hariç kullanıcı bilgilerini döndür
    const userResponse = await User.findById(user._id)
      .select("-password")
      .populate(["role", "city", "club", "belt"]);

    res.status(201).json(userResponse);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/update-coach/:id", async (req, res) => {
  const {
    name,
    surname,
    gender,
    birthDate,
    fatherName,
    motherName,
    cityId,
    clubId,
    sportStartDate,
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
    showInStatistics,
    licenseNo,
    startDate,
    province,
    district,
    institutionPosition,
    coachVisaYear,
    isCoach,
    coachStatus,
    promotion,
    promotionDate,
    belt
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
      !motherName || !cityId || !clubId || 
      !email || !identityNumber) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role kontrolü
    const role = await Role.findOne({ name: "Coach" });
    if (!role) {
      return res.status(404).json({ 
        message: "Rol bulunamadı" 
      });
    }

    // Eğer kullanıcı admin değilse, kendi şehir ID'sini kullan
    if (req.user && req.user.role.name !== "Admin") {
      const userCity = await City.findById(req.user.city._id || req.user.city);
      if (!userCity) {
        return res.status(400).json({ 
          message: "Kullanıcının şehir bilgisi geçersiz" 
        });
      }
      if (userCity._id.toString() !== cityId) {
        return res.status(403).json({ 
          message: "Sadece kendi şehrinize antrenör ekleyebilirsiniz" 
        });
      }
    }

    // Eğer belt bir string ise, ilgili Belt belgesini bul
    let beltId = belt;
    if (belt && typeof belt === 'string' && belt.trim() !== '') {
      const beltDoc = await Belt.findOne({ name: belt });
      if (beltDoc) {
        beltId = beltDoc._id;
      } else {
        return res.status(400).json({ message: "Belirtilen kemer bulunamadı" });
      }
    } else {
      beltId = undefined; // Boş belt değeri için undefined kullan
    }

    // Güncelleme işlemi
    const coach = await User.findById(req.params.id);
    if (!coach) {
      return res.status(404).json({ message: "Antrenör bulunamadı" });
    }

    const updateData = {
      name,
      surname,
      gender,
      birthDate,
      fatherName,
      motherName,
      city: cityId,
      club: clubId,
      role: role._id,
      sportStartDate,
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
      showInStatistics,
      licenseNo,
      startDate,
      province,
      district,
      institutionPosition,
      coachVisaYear,
      isCoach,
      coachStatus,
      promotion,
      promotionDate
    };

    // Sadece belt değeri varsa ekle
    if (beltId) {
      updateData.belt = beltId;
    }

    Object.assign(coach, updateData);

    // Kaydet ve yanıt dön
    await coach.save();

    res.status(200).json({ message: "Antrenör başarıyla güncellendi", coach });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.post("/delete-coach/:id", async (req, res) => {
  try {
    const coach = await User.findByIdAndDelete(req.params.id);
    if (!coach) {
      return res.status(404).json({ message: "Antrenör bulunamadı" });
    }

    res.status(200).json({ message: "Antrenör başarıyla silindi" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-coaches", auth, async (req, res) => {
  try {
    const role = await Role.findOne({ name: "Coach" });
    let query = { role: role._id };

    // Eğer kullanıcı Coach, Referee veya Representetive ise, sadece kendi şehrindeki antrenörleri göster
    if (
      req.user.role.name === "Coach" ||
      req.user.role.name === "Referee" ||
      req.user.role.name === "Representetive"
    ) {
      console.log("Kullanıcı bilgileri:", {
        id: req.user._id,
        name: req.user.name,
        role: req.user.role.name,
        city: req.user.city,
      });

      if (!req.user.city) {
        return res.status(400).json({
          message: "Kullanıcının şehir bilgisi eksik",
        });
      }

      // Şehir ID'sini kontrol et
      const cityId = req.user.city._id || req.user.city;
      if (!cityId) {
        return res.status(400).json({
          message: "Kullanıcının şehir ID'si geçersiz",
        });
      }

      query.city = cityId;
    }

    console.log("Sorgu:", query);
    const coaches = await User.find(query)
      .select("-password")
      .populate(["role", "city", "club", "belt"]);

    res.status(200).json(coaches);
  } catch (error) {
    console.error("Hata:", error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-coach/:id", auth, async (req, res) => {
  try {
    const coach = await User.findById(req.params.id)
      .select("-password")
      .populate([
        "role",
        "city",
        "club",
        "belt",
        {
          path: "beltHistory",
          populate: {
            path: "belt",
            select: "name value _id",
          },
        },
      ]);

    if (!coach) {
      return res.status(404).json({ message: "Antrenör bulunamadı" });
    }

    res.status(200).json(coach);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.post("/create-admin", async (req, res) => {
  try {
    const role = await Role.findOne({ name: "Admin" });
    const { name, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      name,
      email,
      password: hashedPassword,
      role: role._id,
    });

    await user.save();
    res.status(201).json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.put("/update-admin/:id", async (req, res) => {
  try {
    const { name, email } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { name, email },
      { new: true }
    );
    if (!user) {
      return res.status(404).json({ message: "Kullanıcı bulunamadı" });
    }

    await user.save();
    res.status(200).json({ message: "Kullanıcı başarıyla güncellendi", user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.post("/create-referee", async (req, res) => {
  const {
    name,
    surname,
    gender,
    birthDate,
    fatherName,
    motherName,
    cityId,
    sportStartDate,
    athleteLicenseNo,
    email,
    password,
    identityNumber,
    refereeStatus,
    belt,
    mobilePhone,
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (
    !name ||
    !surname ||
    !gender ||
    !birthDate ||
    !fatherName ||
    !motherName ||
    !cityId ||
    !email ||
    !password ||
    !identityNumber ||
    !refereeStatus
  ) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Eğer kullanıcı admin değilse, kendi şehir ID'sini kullan
    if (req.user && req.user.role.name !== "Admin") {
      const userCity = await City.findById(req.user.city._id || req.user.city);
      if (!userCity) {
        return res.status(400).json({
          message: "Kullanıcının şehir bilgisi geçersiz",
        });
      }
      if (userCity._id.toString() !== cityId) {
        return res.status(403).json({
          message: "Sadece kendi şehrinize hakem ekleyebilirsiniz",
        });
      }
    }

    // Eğer belt bir string ise, ilgili Belt belgesini bul
    let beltId = belt;
    if (belt && typeof belt === "string") {
      const beltDoc = await Belt.findOne({ name: belt });
      if (beltDoc) {
        beltId = beltDoc._id;
      } else {
        return res.status(400).json({ message: "Belirtilen kemer bulunamadı" });
      }
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
      role: role._id,
      sportStartDate,
      athleteLicenseNo,
      email,
      password: hashedPassword,
      isReferee: true,
      belt: beltId,
      mobilePhone,
    });

    await user.save();

    // Şifre hariç kullanıcı bilgilerini döndür
    const userResponse = await User.findById(user._id)
      .select("-password")
      .populate(["role", "city", "club", "belt"]);

    res.status(201).json(userResponse);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/update-referee/:id", async (req, res) => {
  const {
    name,
    surname,
    gender,
    birthDate,
    fatherName,
    motherName,
    cityId,
    sportStartDate,
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
    showInStatistics,
    licenseNo,
    startDate,
    province,
    district,
    institutionPosition,
    isReferee,
    refereeVisaYear,
    refereeStatus,
    belt,
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (
    !name ||
    !surname ||
    !gender ||
    !birthDate ||
    !fatherName ||
    !motherName ||
    !cityId ||
    !email ||
    !identityNumber ||
    !refereeStatus
  ) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Eğer kullanıcı admin değilse, kendi şehir ID'sini kullan
    if (req.user && req.user.role.name !== "Admin") {
      const userCity = await City.findById(req.user.city._id || req.user.city);
      if (!userCity) {
        return res.status(400).json({
          message: "Kullanıcının şehir bilgisi geçersiz",
        });
      }
      if (userCity._id.toString() !== cityId) {
        return res.status(403).json({
          message: "Sadece kendi şehrinize hakem ekleyebilirsiniz",
        });
      }
    }

    // Eğer belt bir string ise, ilgili Belt belgesini bul
    let beltId = belt;
    if (belt && typeof belt === "string") {
      const beltDoc = await Belt.findOne({ name: belt });
      if (beltDoc) {
        beltId = beltDoc._id;
      } else {
        return res.status(400).json({ message: "Belirtilen kemer bulunamadı" });
      }
    }

    // Güncelleme işlemi
    const referee = await User.findById(req.params.id);
    if (!referee) {
      return res.status(404).json({ message: "Hakem bulunamadı" });
    }

    // Verilen tüm alanları güncelle
    Object.assign(referee, {
      name,
      surname,
      gender,
      birthDate,
      fatherName,
      motherName,
      city: cityId,
      role: role._id,
      sportStartDate,
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
      showInStatistics,
      licenseNo,
      startDate,
      province,
      district,
      institutionPosition,
      isReferee,
      refereeVisaYear,
      refereeStatus,
      belt: beltId,
    });

    // Kaydet ve yanıt dön
    await referee.save();

    res.status(200).json({ message: "Hakem başarıyla güncellendi", referee });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.post("/delete-referee/:id", async (req, res) => {
  try {
    const referee = await User.findByIdAndDelete(req.params.id);
    if (!referee) {
      return res.status(404).json({ message: "Hakem bulunamadı" });
    }

    res.status(200).json({ message: "Hakem başarıyla silindi" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-referees", auth, async (req, res) => {
  try {
    const role = await Role.findOne({ name: "Referee" });
    let query = { role: role._id };

    // Eğer kullanıcı Coach ise, sadece kendi şehrindeki hakemleri göster
    if (
      req.user.role.name === "Coach" ||
      req.user.role.name === "Representetive"
    ) {
      console.log("Coach şehri:", req.user.city._id);
      query.city = req.user.city._id;
    }

    console.log("Sorgu:", query);
    const referees = await User.find(query)
      .select("-password")
      .populate(["role", "city", "belt"]);

    res.status(200).json(referees);
  } catch (error) {
    console.error("Hata:", error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-referee/:id", auth, async (req, res) => {
  try {
    const referee = await User.findById(req.params.id)
      .select("-password")
      .populate([
        "role",
        "city",
        "club",
        "belt",
        {
          path: "beltHistory",
          populate: {
            path: "belt",
            select: "name value _id",
          },
        },
      ]);

    if (!referee) {
      return res.status(404).json({ message: "Hakem bulunamadı" });
    }

    res.status(200).json(referee);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.post("/create-representetive", async (req, res) => {
  const {
    name,
    surname,
    gender,
    birthDate,
    fatherName,
    motherName,
    cityId,
    sportStartDate,
    email,
    password,
    identityNumber,
    mobilePhone,
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (
    !name ||
    !surname ||
    !gender ||
    !birthDate ||
    !fatherName ||
    !motherName ||
    !cityId ||
    !email ||
    !password ||
    !identityNumber
  ) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role kontrolü
    const role = await Role.findOne({ name: "Representetive" });
    if (!role) {
      return res.status(404).json({
        message: "Rol bulunamadı",
      });
    }

    // Eğer kullanıcı admin değilse, kendi şehir ID'sini kullan
    if (req.user && req.user.role.name !== "Admin") {
      const userCity = await City.findById(req.user.city._id || req.user.city);
      if (!userCity) {
        return res.status(400).json({
          message: "Kullanıcının şehir bilgisi geçersiz",
        });
      }
      if (userCity._id.toString() !== cityId) {
        return res.status(403).json({
          message: "Sadece kendi şehrinize temsilci ekleyebilirsiniz",
        });
      }
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
      role: role._id,
      sportStartDate,
      email,
      password: hashedPassword,
      isProvincialRepresentative: true,
      mobilePhone,
    });

    await user.save();

    // Şifre hariç kullanıcı bilgilerini döndür
    const userResponse = await User.findById(user._id)
      .select("-password")
      .populate(["role", "city", "club", "belt"]);

    res.status(201).json(userResponse);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/update-representetive/:id", async (req, res) => {
  const {
    name,
    surname,
    gender,
    birthDate,
    fatherName,
    motherName,
    cityId,
    sportStartDate,
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
    showInStatistics,
    licenseNo,
    startDate,
    province,
    district,
    institutionPosition,
    isProvincialRepresentative,
    promotion,
    promotionDate
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
      !motherName || !cityId || 
      !email || !identityNumber) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role kontrolü
    const role = await Role.findOne({ name: "Representetive" });
    if (!role) {
      return res.status(404).json({ 
        message: "Rol bulunamadı" 
      });
    }

    // Eğer kullanıcı admin değilse, kendi şehir ID'sini kullan
    if (req.user && req.user.role.name !== "Admin") {
      const userCity = await City.findById(req.user.city._id || req.user.city);
      if (!userCity) {
        return res.status(400).json({ 
          message: "Kullanıcının şehir bilgisi geçersiz" 
        });
      }
      if (userCity._id.toString() !== cityId) {
        return res.status(403).json({ 
          message: "Sadece kendi şehrinize temsilci ekleyebilirsiniz" 
        });
      }
    }

    // Güncelleme işlemi
    const representetive = await User.findById(req.params.id);
    if (!representetive) {
      return res.status(404).json({ message: "Temsilci bulunamadı" });
    }

    Object.assign(representetive, {
      name,
      surname,
      gender,
      birthDate,
      fatherName,
      motherName,
      city: cityId,
      role: role._id,
      sportStartDate,
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
      showInStatistics,
      licenseNo,
      startDate,
      province,
      district,
      institutionPosition,
      isProvincialRepresentative,
      promotion,
      promotionDate
    });

    // Kaydet ve yanıt dön
    await representetive.save();

    res.status(200).json({ message: "Temsilci başarıyla güncellendi", representetive });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.post("/delete-representetive/:id", async (req, res) => {
  try {
    const representetive = await User.findByIdAndDelete(req.params.id);
    if (!representetive) {
      return res.status(404).json({ message: "Temsilci bulunamadı" });
    }

    res.status(200).json({ message: "Temsilci başarıyla silindi" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-representetives", auth, async (req, res) => {
  try {
    const role = await Role.findOne({ name: "Representetive" });
    let query = { role: role._id };

    // Eğer kullanıcı Coach ise, sadece kendi şehrindeki temsilcileri göster
    if (req.user.role.name === "Coach") {
      console.log("Coach şehri:", req.user.city._id);
      query.city = req.user.city._id;
    }

    console.log("Sorgu:", query);
    const representetives = await User.find(query)
      .select("-password")
      .populate(["role", "city", "belt"]);

    res.status(200).json(representetives);
  } catch (error) {
    console.error("Hata:", error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-representetive/:id", auth, async (req, res) => {
  try {
    const representetive = await User.findById(req.params.id)
      .select("-password")
      .populate(["role", "city", "club", "belt"]);

    if (!representetive) {
      return res.status(404).json({ message: "Temsilci bulunamadı" });
    }

    // Eğer kullanıcı Coach ise ve temsilci farklı bir şehirdeyse erişimi engelle
    if (
      req.user.role.name === "Coach" &&
      representetive.city._id.toString() !== req.user.city._id.toString()
    ) {
      return res
        .status(403)
        .json({ message: "Bu temsilciye erişim yetkiniz yok" });
    }

    res.status(200).json(representetive);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.post("/create-personel", async (req, res) => {
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
    identityNumber,
    mobilePhone,
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (
    !name ||
    !surname ||
    !gender ||
    !birthDate ||
    !fatherName ||
    !motherName ||
    !cityId ||
    !clubId ||
    !roleId ||
    !sportStartDate ||
    !email ||
    !password ||
    !identityNumber
  ) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Eğer kullanıcı admin değilse, kendi şehir ID'sini kullan
    if (req.user && req.user.role.name !== "Admin") {
      const userCity = await City.findById(req.user.city._id || req.user.city);
      if (!userCity) {
        return res.status(400).json({
          message: "Kullanıcının şehir bilgisi geçersiz",
        });
      }
      if (userCity._id.toString() !== cityId) {
        return res.status(403).json({
          message: "Sadece kendi şehrinize personel ekleyebilirsiniz",
        });
      }
    }

    // Role, City ve Club varlığını kontrol et
    const [role, city, club] = await Promise.all([
      Role.findById(roleId),
      City.findById(cityId),
      Club.findById(clubId),
    ]);

    if (!role) {
      return res.status(404).json({
        message: "Rol bulunamadı",
      });
    }

    if (!city) {
      return res.status(404).json({
        message: "Şehir bulunamadı",
      });
    }

    if (!club) {
      return res.status(404).json({
        message: "Kulüp bulunamadı",
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
      isStaff: true,
      mobilePhone,
    });

    await user.save();

    // Şifre hariç kullanıcı bilgilerini döndür
    const userResponse = await User.findById(user._id)
      .select("-password")
      .populate(["role", "city", "club", "belt"]);

    res.status(201).json(userResponse);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/update-personel/:id", async (req, res) => {
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
    identityNumber,
    mobilePhone,
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (
    !name ||
    !surname ||
    !gender ||
    !birthDate ||
    !fatherName ||
    !motherName ||
    !cityId ||
    !clubId ||
    !roleId ||
    !sportStartDate ||
    !email ||
    !password ||
    !identityNumber
  ) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Eğer kullanıcı admin değilse, kendi şehir ID'sini kullan
    if (req.user && req.user.role.name !== "Admin") {
      const userCity = await City.findById(req.user.city._id || req.user.city);
      if (!userCity) {
        return res.status(400).json({
          message: "Kullanıcının şehir bilgisi geçersiz",
        });
      }
      if (userCity._id.toString() !== cityId) {
        return res.status(403).json({
          message: "Sadece kendi şehrinize personel ekleyebilirsiniz",
        });
      }
    }

    // Güncelleme işlemi
    const personel = await User.findById(req.params.id);
    if (!personel) {
      return res.status(404).json({ message: "Personel bulunamadı" });
    }

    personel.name = name;
    personel.surname = surname;
    personel.gender = gender;
    personel.birthDate = birthDate;
    personel.fatherName = fatherName;
    personel.motherName = motherName;
    personel.city = cityId;
    personel.club = clubId;
    personel.role = roleId;
    personel.sportStartDate = sportStartDate;
    personel.athleteLicenseNo = athleteLicenseNo;
    personel.email = email;
    personel.identityNumber = identityNumber;
    personel.mobilePhone = mobilePhone;

    await personel.save();

    res
      .status(200)
      .json({ message: "Personel başarıyla güncellendi", personel });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.post("/delete-personel/:id", async (req, res) => {
  try {
    const personel = await User.findByIdAndDelete(req.params.id);
    if (!personel) {
      return res.status(404).json({ message: "Personel bulunamadı" });
    }

    res.status(200).json({ message: "Personel başarıyla silindi" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-personels", auth, async (req, res) => {
  try {
    let query = { role: "Personel" };

    // Eğer kullanıcı Coach ise, sadece kendi şehrindeki personelleri göster
    if (req.user.role.name === "Coach") {
      console.log("Coach şehri:", req.user.city._id);
      query.city = req.user.city._id;
    }

    console.log("Sorgu:", query);
    const personels = await User.find(query)
      .select("-password")
      .populate(["role", "city", "club", "belt"]);

    res.status(200).json(personels);
  } catch (error) {
    console.error("Hata:", error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-personel/:id", auth, async (req, res) => {
  try {
    const personel = await User.findById(req.params.id)
      .select("-password")
      .populate(["role", "city", "club", "belt"]);

    if (!personel) {
      return res.status(404).json({ message: "Personel bulunamadı" });
    }

    // Eğer kullanıcı Coach ise ve personel farklı bir şehirdeyse erişimi engelle
    if (
      req.user.role.name === "Coach" &&
      personel.city._id.toString() !== req.user.city._id.toString()
    ) {
      return res
        .status(403)
        .json({ message: "Bu personele erişim yetkiniz yok" });
    }

    res.status(200).json(personel);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

// Login a user
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ message: "Email/TC ve şifre zorunludur" });

  try {
    // TC kimlik numarası veya e-posta ile kullanıcıyı bul
    const user = await User.findOne({
      $or: [
        { email: email },
        { identityNumber: email }
      ]
    }).populate("role");

    if (!user) return res.status(404).json({ message: "Kullanıcı bulunamadı" });
    
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Geçersiz kimlik bilgileri" });

    const token = jwt.sign(
      { id: user._id, role: user.role.name },
      process.env.JWT_SECRET,
      {
        expiresIn: "1d",
      }
    );

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
      createdAt: user.createdAt,
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
      return res
        .status(403)
        .json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    }

    const users = await User.find().select("-password").populate("role");

    res.status(200).json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Kullanıcı rolünü değiştir (SADECE ADMIN)
router.put("/change-role/:userId", auth, async (req, res) => {
  try {
    // Admin kontrolü
    const adminUser = await User.findById(req.user.id).populate("role");
    if (adminUser.role.name !== "Admin") {
      return res.status(403).json({ message: "Bu işlem için yetkiniz yok" });
    }

    const { userId } = req.params;
    const { newRoleName } = req.body;

    // Rol varlık kontrolü
    const newRole = await Role.findOne({ name: newRoleName });
    if (!newRole) {
      return res.status(404).json({ message: "Belirtilen rol bulunamadı" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "Kullanıcı bulunamadı" });
    }

    user.isAthlete = false;
    user.isCoach = false;
    user.isReferee = false;
    user.isProvincialRepresentative = false;

    user.role = newRole._id;
    switch (newRoleName) {
      case "Athlete":
        user.isAthlete = true;
        break;
      case "Coach":
        user.isCoach = true;
        break;
      case "Referee":
        user.isReferee = true;
        break;
      case "Representetive":
        user.isProvincialRepresentative = true;
        break;
    }

    await user.save();

    const updatedUser = await User.findById(userId)
      .select("-password")
      .populate("role");

    res.status(200).json({
      message: "Rol başarıyla değiştirildi",
      user: updatedUser,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Kullanıcı şifresini değiştir (SADECE ADMIN)
router.put("/change-password/:userId", auth, async (req, res) => {
  try {
    // Admin kontrolü
    const adminUser = await User.findById(req.user.id).populate("role");
    if (adminUser.role.name !== "Admin") {
      return res.status(403).json({ message: "Bu işlem için yetkiniz yok" });
    }

    const { userId } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ message: "Yeni şifre gereklidir" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "Kullanıcı bulunamadı" });
    }

    // Yeni şifreyi hashle
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;

    await user.save();

    res.status(200).json({
      message: "Kullanıcı şifresi başarıyla değiştirildi",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// BeltHistory için CRUD işlemleri
router.post("/:userId/belt-history", auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { belt, date, note } = req.body;

    if (!belt || !date) {
      return res
        .status(400)
        .json({ message: "Kemer ve tarih bilgisi zorunludur" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "Kullanıcı bulunamadı" });
    }

    // BeltHistory'ye yeni kayıt ekle
    user.beltHistory.push({
      belt,
      date: new Date(date),
      note: note || "",
      updatedAt: new Date(),
    });

    await user.save();

    // Güncellenmiş kullanıcıyı döndür
    const updatedUser = await User.findById(userId)
      .select("-password")
      .populate([
        "role",
        "city",
        "club",
        "belt",
        {
          path: "beltHistory",
          populate: {
            path: "belt",
            select: "name value _id",
          },
        },
      ]);

    res.status(201).json(updatedUser);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.put("/:userId/belt-history/:historyId", auth, async (req, res) => {
  try {
    const { userId, historyId } = req.params;
    const { belt, date, note } = req.body;

    if (!belt || !date) {
      return res
        .status(400)
        .json({ message: "Kemer ve tarih bilgisi zorunludur" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "Kullanıcı bulunamadı" });
    }

    // BeltHistory'deki ilgili kaydı bul ve güncelle
    const historyIndex = user.beltHistory.findIndex(
      (h) => h._id.toString() === historyId
    );
    if (historyIndex === -1) {
      return res
        .status(404)
        .json({ message: "Kuşak geçmişi kaydı bulunamadı" });
    }

    user.beltHistory[historyIndex] = {
      ...user.beltHistory[historyIndex].toObject(),
      belt,
      date: new Date(date),
      note: note || user.beltHistory[historyIndex].note,
      updatedAt: new Date(),
    };

    await user.save();

    // Güncellenmiş kullanıcıyı döndür
    const updatedUser = await User.findById(userId)
      .select("-password")
      .populate([
        "role",
        "city",
        "club",
        "belt",
        {
          path: "beltHistory",
          populate: {
            path: "belt",
            select: "name value _id",
          },
        },
      ]);

    res.status(200).json(updatedUser);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.delete("/:userId/belt-history/:historyId", auth, async (req, res) => {
  try {
    const { userId, historyId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "Kullanıcı bulunamadı" });
    }

    // BeltHistory'den ilgili kaydı sil
    user.beltHistory = user.beltHistory.filter(
      (h) => h._id.toString() !== historyId
    );
    await user.save();

    // Güncellenmiş kullanıcıyı döndür
    const updatedUser = await User.findById(userId)
      .select("-password")
      .populate([
        "role",
        "city",
        "club",
        "belt",
        {
          path: "beltHistory",
          populate: {
            path: "belt",
            select: "name value _id",
          },
        },
      ]);

    res.status(200).json(updatedUser);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

module.exports = router;
