const express = require("express");
const router = express.Router();
const Club = require("../models/organization");
const auth = require("../middleware/auth");

//bunu ayarla

// Kulüp oluştur (sadece admin)
router.post("/", auth, async (req, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    }

    const { name, cityId } = req.body;
    if (!name || !cityId) {
      return res.status(400).json({ message: "Kulüp adı ve şehir ID'si gereklidir" });
    }

    const club = new Club({
      name,
      city: cityId
    });
    await club.save();
    
    const populatedClub = await Club.findById(club._id).populate('city');
    res.status(201).json(populatedClub);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Tüm kulüpleri getir
router.get("/", async (req, res) => {
  try {
    const clubs = await Club.find().populate('city').sort({ name: 1 });
    res.status(200).json(clubs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Kulüp güncelle (sadece admin)
router.put("/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    }

    const { name, cityId } = req.body;
    if (!name || !cityId) {
      return res.status(400).json({ message: "Kulüp adı ve şehir ID'si gereklidir" });
    }

    const club = await Club.findByIdAndUpdate(
      req.params.id,
      { name, city: cityId },
      { new: true }
    ).populate('city');

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
    if (req.user.role !== "Admin") {
      return res.status(403).json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
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