const express = require("express");
const router = express.Router();
const Organisation = require("../models/organisation");
const User = require("../models/user");
const auth = require("../middleware/auth");
const mongoose = require("mongoose");

// ADMIN ONLY ROUTES
// Organizasyon oluşturma (Sadece Admin)
router.post("/", auth, async (req, res) => {
  try {
    // Admin kontrolü
    const user = await User.findById(req.user.id).populate("role");
    if (user.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { tournamentName, tournamentPlace, tournamentDate, birthDateRequirements, beltRequirement, participationType } = req.body;

    // Zorunlu alan kontrolü
    if (!tournamentPlace || !tournamentDate?.startDate || !participationType) {
      return res.status(400).json({ message: "Zorunlu alanları doldurun" });
    }

    const organisation = new Organisation({
      tournamentName,
      tournamentPlace,
      tournamentDate,
      birthDateRequirements,
      beltRequirement: beltRequirement || [],
      participationType,
    });

    await organisation.save();
    res.status(201).json(organisation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Tüm organizasyonları listele (Admin + Filtreli)
router.get("/", auth, async (req, res) => {
  try {
    // Tarih filtresi için örnek query: ?startDate=2024-01-01
    const { startDate, participationType } = req.query;
    const filter = {};
    
    if (startDate) filter["tournamentDate.startDate"] = { $gte: new Date(startDate) };
    if (participationType) filter.participationType = participationType;

    const organisations = await Organisation.find(filter);
    res.json(organisations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Organizasyon detayını getir
router.get("/:id", auth, async (req, res) => {
  try {
    const organisation = await Organisation.findById(req.params.id)
      .populate("participants");
      
    if (!organisation) return res.status(404).json({ message: "Organizasyon bulunamadı" });
    res.json(organisation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// COACH ACCESS ROUTES
// Organizasyona sporcu ekleme (Antrenör)
router.post("/:id/participants", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    const allowedRoles = ["Coach", "Admin", "Representetive"];

    // Kullanıcının rolünü kontrol et
    if (!allowedRoles.includes(user.role.name)) {
      console.log(user.role.name);
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const organisation = await Organisation.findById(req.params.id);
    if (!organisation) return res.status(404).json({ message: "Organizasyon bulunamadı" });

    const { athleteIds } = req.body;
    const athletes = await User.find({
      _id: { $in: athleteIds } 
    }).populate("role");

    console.log("athletes", athletes);

    // Sporcu ve yaş/kemer kontrolü
    const validAthletes = athletes.filter(athlete => {
      const isAthlete = athlete.role.name === "Athlete";
      const ageValid = checkBirthDate(athlete.birthDate, organisation.birthDateRequirements);
      const beltValid = organisation.beltRequirement.length === 0 || 
                        organisation.beltRequirement.includes(athlete.belt);
      return isAthlete && ageValid && beltValid;
    });

    organisation.participants.push(...validAthletes.map(a => a._id));
    await organisation.save();

    res.json({
      addedCount: validAthletes.length,
      invalidIds: athleteIds.filter(id => 
        !validAthletes.map(a => a._id.toString()).includes(id)
      )
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Filtreli sporcu listesi (Yaş, Sıklet, Kemer)
router.get("/:id/eligible-athletes", auth, async (req, res) => {
  try {
    const { minWeight, maxWeight, belt } = req.query;
    const organisation = await Organisation.findById(req.params.id);

    // Ek filtreler
    const weightFilter = {};
    if (minWeight || maxWeight) {
      weightFilter["weight"] = {};
      if (minWeight) weightFilter.weight.$gte = parseInt(minWeight);
      if (maxWeight) weightFilter.weight.$lte = parseInt(maxWeight);
    }

    const athletes = await User.find({
      ...weightFilter,
      ...(belt && { belt })
    })
    .populate("role")
    .select("-password");

    console.log("athletes",athletes)

    // Yaş filtresi (memory'de)
    const ageFiltered = athletes.filter(athlete => 
      checkBirthDate(athlete.birthDate, organisation.birthDateRequirements)
    );

    res.json(ageFiltered);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ORGANIZATION UPDATE (ADMIN ONLY)
router.put("/:id", auth, async (req, res) => {
  try {
    // Admin kontrolü
    const adminUser = await User.findById(req.user.id).populate("role");
    if (adminUser.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id } = req.params;
    const updates = req.body;

    // Organizasyonu bul ve güncelle
    const updatedOrg = await Organisation.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!updatedOrg) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    res.status(200).json(updatedOrg);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ORGANIZATION DELETE (ADMIN ONLY)
router.delete("/:id", auth, async (req, res) => {
  try {
    // Admin kontrolü
    const adminUser = await User.findById(req.user.id).populate("role");
    if (adminUser.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id } = req.params;
    const deletedOrg = await Organisation.findByIdAndDelete(id);

    if (!deletedOrg) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    res.status(200).json({ message: "Organizasyon başarıyla silindi" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// PARTICIPANT REMOVAL (COACH/ADMIN/REPRESENTATIVE)
router.delete("/:id/participants/:athleteId", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    const allowedRoles = ["Coach", "Admin", "Representetive"];

    // Yetki kontrolü
    if (!allowedRoles.includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id, athleteId } = req.params;

    // Organizasyondan sporcu çıkar
    const updatedOrg = await Organisation.findByIdAndUpdate(
      id,
      { $pull: { participants: athleteId } },
      { new: true }
    );

    if (!updatedOrg) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    res.status(200).json({
      message: "Sporcu organizasyondan çıkarıldı",
      remainingParticipants: updatedOrg.participants.length
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Yardımcı Fonksiyonlar
function checkBirthDate(userBirthDate, requirements) {
  if (!requirements) return true;
  
  const birthDate = new Date(userBirthDate);
  const minDate = requirements.minDate ? new Date(requirements.minDate) : null;
  const maxDate = requirements.maxDate ? new Date(requirements.maxDate) : null;
  
  return (!minDate || birthDate >= minDate) && 
         (!maxDate || birthDate <= maxDate);
}

module.exports = router;