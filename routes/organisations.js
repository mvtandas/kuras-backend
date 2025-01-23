const express = require("express");
const router = express.Router();
const Organisation = require("../models/organisation");
const auth = require("../middleware/auth");

//bunu ayarla

// Kulüp oluştur (sadece admin)
router.post("/", async (req, res) => {
  try {
    // if (req.user.role !== "Admin") {
    //   return res.status(403).json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    // }

    const { name, cityId, date, status } = req.body;
    if (!name || !cityId || !date || !status) {
      return res.status(400).json({ message: "Organizasyon adı ve şehir ID'si gereklidir" });
    }

    const organisation = new Organisation({
      name,
      city: cityId,
      date,
     status
    });
    await organisation.save();
    
    const populatedOrganisation = await Organisation.findById(organisation._id).populate('city');
    res.status(201).json(populatedOrganisation);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Tüm kulüpleri getir
router.get("/", async (req, res) => {
  try {
    const organisations = await Organisation.find().populate('city').sort({ name: 1 });
    res.status(200).json(organisations);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/:id",async (req, res) => {
    try {
        const organisation = await Organisation.findById(req.params.id).populate('city');
        if (!organisation) {
        return res.status(404).json({ message: "Organizasyon bulunamadı" });
        }
        res.status(200).json(organisation);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
    });

// Kulüp güncelle (sadece admin)
router.put("/:id",  async (req, res) => {
  try {
    // if (req.user.role !== "Admin") {
    //   return res.status(403).json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    // }

    const { name, cityId, date, status } = req.body;
    if (!name || !cityId || !date || !status) {
      return res.status(400).json({ message: "Organizasyon adı ve şehir ID'si gereklidir" });
    }

    const organisation = await Organisation.findByIdAndUpdate(
      req.params.id,
      { name, city: cityId },
      { new: true }
    ).populate('city');

    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    res.status(200).json(organisation);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Kulüp sil (sadece admin)
router.delete("/:id",  async (req, res) => {
  try {
    // if (req.user.role !== "Admin") {
    //   return res.status(403).json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    // }

    const organisation = await Organisation.findByIdAndDelete(req.params.id);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }
    res.status(200).json({ message: "Organizasyon başarıyla silindi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router; 