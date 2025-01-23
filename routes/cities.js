const express = require("express");
const router = express.Router();
const City = require("../models/city");
const auth = require("../middleware/auth");

// Şehir oluştur (sadece admin)
router.post("/", auth, async (req, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    }

    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ message: "Şehir adı gereklidir" });
    }

    const city = new City({ name });
    await city.save();
    res.status(201).json(city);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Tüm şehirleri getir
router.get("/", async (req, res) => {
  try {
    const cities = await City.find().sort({ name: 1 });
    res.status(200).json(cities);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Şehir sil (sadece admin)
router.delete("/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    }

    const city = await City.findByIdAndDelete(req.params.id);
    if (!city) {
      return res.status(404).json({ message: "Şehir bulunamadı" });
    }
    res.status(200).json({ message: "Şehir başarıyla silindi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router; 