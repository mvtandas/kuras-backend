const express = require("express");
const router = express.Router();
const Belt = require("../models/belt");
const User = require("../models/user");
const auth = require("../middleware/auth");

// Kemer oluştur (sadece admin)
router.post("/", auth, async (req, res) => {
  try {
    // Admin kontrolü
    const user = await User.findById(req.user.id).populate("role");
    if (user.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { name, value } = req.body;
    if (!name || !value) {
      return res.status(400).json({ message: "Kemer adı ve değeri gereklidir" });
    }

    const belt = new Belt({ name, value });
    await belt.save();
    res.status(201).json(belt);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Tüm kemerleri getir
router.get("/", async (req, res) => {
  try {
    const belts = await Belt.find().sort({ value: 1 });
    res.status(200).json(belts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Kemer güncelle (sadece admin)
router.put("/:id", auth, async (req, res) => {
  try {
    // Admin kontrolü
    const user = await User.findById(req.user.id).populate("role");
    if (user.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { name, value } = req.body;
    if (!name || !value) {
      return res.status(400).json({ message: "Kemer adı ve değeri gereklidir" });
    }

    const belt = await Belt.findByIdAndUpdate(
      req.params.id,
      { name, value },
      { new: true }
    );

    if (!belt) {
      return res.status(404).json({ message: "Kemer bulunamadı" });
    }

    res.status(200).json(belt);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Kemer sil (sadece admin)
router.delete("/:id", auth, async (req, res) => {
  try {
    // Admin kontrolü
    const user = await User.findById(req.user.id).populate("role");
    if (user.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const belt = await Belt.findByIdAndDelete(req.params.id);
    if (!belt) {
      return res.status(404).json({ message: "Kemer bulunamadı" });
    }
    res.status(200).json({ message: "Kemer başarıyla silindi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Belirli bir kemeri getir
router.get("/:id", async (req, res) => {
  try {
    const belt = await Belt.findById(req.params.id);
    if (!belt) {
      return res.status(404).json({ message: "Kemer bulunamadı" });
    }
    res.status(200).json(belt);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router; 