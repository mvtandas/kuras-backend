const express = require("express");
const router = express.Router();
const Club = require("../models/club");
const auth = require("../middleware/auth");

// Kulüp oluştur (sadece admin)
router.post("/", auth, async (req, res) => {
  try {
    if (req.user.role.name !== "Admin") {
      return res
        .status(403)
        .json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    }

    const { name, cityId } = req.body;
    if (!name || !cityId) {
      return res
        .status(400)
        .json({ message: "Kulüp adı ve şehir ID'si gereklidir" });
    }

    const club = new Club({
      name,
      city: cityId,
    });
    await club.save();

    const populatedClub = await Club.findById(club._id).populate("city");
    res.status(201).json(populatedClub);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Tüm kulüpleri getir
router.get("/", auth, async (req, res) => {
  try {
    let query = {};

    // Eğer kullanıcı Coach ise, sadece kendi şehrindeki kulüpleri göster
    if (
      req.user.role.name === "Coach" ||
      req.user.role.name === "Representetive"
    ) {
      console.log("Coach bilgileri:", {
        id: req.user._id,
        name: req.user.name,
        role: req.user.role.name,
        city: req.user.city,
      });

      if (!req.user.city) {
        return res.status(400).json({
          message: "Coach'un şehir bilgisi eksik",
        });
      }

      // Şehir ID'sini kontrol et
      const cityId = req.user.city._id || req.user.city;
      if (!cityId) {
        return res.status(400).json({
          message: "Coach'un şehir ID'si geçersiz",
        });
      }

      query.city = cityId;
    }

    console.log("Oluşturulan sorgu:", JSON.stringify(query, null, 2));

    const clubs = await Club.find(query).populate("city").sort({ name: 1 });

    console.log("Bulunan kulüp sayısı:", clubs.length);
    if (clubs.length > 0) {
      console.log("İlk kulüp örneği:", {
        id: clubs[0]._id,
        name: clubs[0].name,
        city: clubs[0].city,
      });
    }

    res.status(200).json(clubs);
  } catch (err) {
    console.error("Hata detayı:", err);
    res.status(500).json({ message: err.message });
  }
});

router.get("/:id", auth, async (req, res) => {
  try {
    const club = await Club.findById(req.params.id).populate("city");
    if (!club) {
      return res.status(404).json({ message: "Kulüp bulunamadı" });
    }
    res.status(200).json(club);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Kulüp güncelle (sadece admin)
router.put("/:id", auth, async (req, res) => {
  try {
    console.log(req.user.role);
    if (req.user.role.name !== "Admin") {
      return res
        .status(403)
        .json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    }

    const { name, cityId } = req.body;
    if (!name || !cityId) {
      return res
        .status(400)
        .json({ message: "Kulüp adı ve şehir ID'si gereklidir" });
    }

    const club = await Club.findByIdAndUpdate(
      req.params.id,
      { name, city: cityId },
      { new: true }
    ).populate("city");

    if (!club) {
      return res.status(404).json({ message: "Kulüp bulunamadı" });
    }

    res.status(200).json(club);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Kulüp sil (sadece admin)
router.delete("/:id", auth, async (req, res) => {
  try {
    if (req.user.role.name !== "Admin") {
      return res
        .status(403)
        .json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    }

    const club = await Club.findByIdAndDelete(req.params.id);
    if (!club) {
      return res.status(404).json({ message: "Kulüp bulunamadı" });
    }
    res.status(200).json({ message: "Kulüp başarıyla silindi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
