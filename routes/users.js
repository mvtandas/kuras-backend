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
    sportStartDate,
    athleteLicenseNo,
    email,
    password,
    identityNumber,
    belt,
    weight
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
      !motherName || !cityId || !clubId || !sportStartDate || 
      !email || !password || !identityNumber) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role, City ve Club varlığını kontrol et
    const [role, city, club] = await Promise.all([
      Role.findOne({ name: "Athlete" }),
      City.findById(cityId),
      Club.findById(clubId)
    ]);

    if (!role || !city || !club) {
      return res.status(404).json({ 
        message: "Rol, şehir veya kulüp bulunamadı" 
      });
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
      belt,
      weight
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
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (
    !name || !surname || !gender || !birthDate || !fatherName || 
    !motherName || !cityId || !clubId || !sportStartDate || 
    !email || !identityNumber
  ) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role, City ve Club varlığını kontrol et
    const [role, city, club] = await Promise.all([
      Role.findOne({ name: "Athlete" }),
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
      role: role._id,
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
    identityNumber
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
      !motherName || !cityId || !clubId || 
      !email || !password || !identityNumber) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role, City ve Club varlığını kontrol et
    const [role, city, club] = await Promise.all([
      Role.findOne({ name: "Coach" }),
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
      role: role._id,
      sportStartDate,
      athleteLicenseNo,
      email,
      password: hashedPassword,
      isCoach: true
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
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
      !motherName || !cityId || !clubId || 
      !email || !identityNumber) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role, City ve Club varlığını kontrol et
    const [role, city, club] = await Promise.all([
      Role.findOne({ name: "Coach" }),
      City.findById(cityId),
      Club.findById(clubId)
    ]);

    if (!role || !city || !club) {
      return res.status(404).json({ 
        message: "Rol, şehir veya kulüp bulunamadı" 
      });
    }

    // Güncelleme işlemi
    const coach = await User.findById(req.params.id);
    if (!coach) {
      return res.status(404).json({ message: "Antrenör bulunamadı" });
    }

    Object.assign(coach, {
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
      promotionDate,
    });

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

router.get("/get-coaches", async (req, res) => {
  try {
    const role = await Role.findOne({ name: "Coach" });
    const coaches = await User.find({ role: role._id })
      .select("-password")
      .populate(["role", "city", "club"]);

    res.status(200).json(coaches);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-coach/:id", async (req, res) => {
  try {
    const coach = await User.findById(req.params.id)
      .select("-password")
      .populate(["role", "city", "club"]);

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
    const {name, email, password} = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      name,
      email,
      password: hashedPassword,
      role: role._id
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
    const {name, email} = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { name, email},
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
    refereeStatus
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
      !motherName || !cityId || 
      !email || !password || !identityNumber || !refereeStatus) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role, City varlığını kontrol et
    const [role, city] = await Promise.all([
      Role.findOne({ name: "Referee" }),
      City.findById(cityId),
    ]);

    if (!role || !city) {
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
      role: role._id,
      sportStartDate,
      athleteLicenseNo,
      email,
      password: hashedPassword,
      isReferee: true,
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
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
    !motherName || !cityId || 
    !email || !identityNumber || !refereeStatus) {
  return res.status(400).json({ message: "Tüm alanlar zorunludur" });
}



try {

  // Role, City ve Club varlığını kontrol et
  const [role, city] = await Promise.all([
    Role.findOne({ name: "Referee" }),
    City.findById(cityId),
  ]);

  if (!role || !city) {
    return res.status(404).json({ 
      message: "Rol, şehir bulunamadı" 
    });
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
    refereeStatus
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
}
);

router.get("/get-referees", async (req, res) => {
  try {
    const role = await Role.findOne({ name: "Referee" });
    const referees = await User.find({ role: role._id })
      .select("-password")
      .populate(["role", "city"]);

    res.status(200).json(referees);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

router.get("/get-referee/:id", async (req, res) => {
    try {
      const referee = await User.findById(req.params.id)
        .select("-password")
        .populate(["role", "city", "club"]);
  
      if (!referee) {
        return res.status(404).json({ message: "Hakem bulunamadı" });
      }
  
      res.status(200).json(referee);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Sunucu hatası" });
    }
  }
  );

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
    identityNumber
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
      !motherName || !cityId || 
      !email || !password || !identityNumber) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role, City ve Club varlığını kontrol et
    const [role, city] = await Promise.all([
      Role.findOne({ name: "Representetive" }),
      City.findById(cityId),
    ]);

    if (!role || !city) {
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
      role: role._id,
      sportStartDate,
      email,
      password: hashedPassword,
      isProvincialRepresentative: true,
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
    promotionDate,
  } = req.body;

  // Tüm gerekli alanların kontrolü
  if (!name || !surname || !gender || !birthDate || !fatherName || 
      !motherName || !cityId || 
      !email || !identityNumber) {
    return res.status(400).json({ message: "Tüm alanlar zorunludur" });
  }

  try {
    // Role, City ve Club varlığını kontrol et
    const [role, city] = await Promise.all([
      Role.findOne({ name: "Representetive" }),
      City.findById(cityId),
    ]);

    if (!role || !city) {
      return res.status(404).json({ 
        message: "Rol, şehir veya kulüp bulunamadı" 
      });
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
      promotionDate,
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
}
);

router.get("/get-representetives", async (req, res) => {
  try {
    const role = await Role.findOne({ name: "Representetive" });
    const representetives = await User.find({ role: role._id })
      .select("-password")
      .populate(["role", "city"]);

    res.status(200).json(representetives);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
}
);

router.get("/get-representetive/:id", async (req, res) => {
  try {
    const representetive = await User.findById(req.params.id)
      .select("-password")
      .populate(["role", "city", "club"]);

    if (!representetive) {
      return res.status(404).json({ message: "Temsilci bulunamadı" });
    }

    res.status(200).json(representetive);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
}
);


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
      isStaff: true,
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

    await personel.save();

    res.status(200).json({ message: "Personel başarıyla güncellendi", personel });
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
}
);

router.get("/get-personels", async (req, res) => {
  try {
    const personels = await User.find({ role: "Personel" })
      .select("-password")
      .populate(["role", "city", "club"]);

    res.status(200).json(personels);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
}
);

router.get("/get-personel/:id", async (req, res) => {
  try {
    const personel = await User.findById(req.params.id)
      .select("-password")
      .populate(["role", "city", "club"]);

    if (!personel) {
      return res.status(404).json({ message: "Personel bulunamadı" });
    }

    res.status(200).json(personel);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Sunucu hatası" });
  }
}
);



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
      user: updatedUser
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
