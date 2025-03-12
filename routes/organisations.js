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
      .populate({
        path: "participants.athlete",
        select: "name surname birthDate gender belt weight club",
        populate: [
          { path: "belt", select: "name value" },
          { path: "club", select: "name" }
        ]
      })
      .populate({
        path: "participants.coach",
        select: "name surname"
      })
      .populate({
        path: "participants.addedBy",
        select: "name surname role",
        populate: { path: "role", select: "name" }
      })
      .populate("beltRequirement");
      
    if (!organisation) return res.status(404).json({ message: "Organizasyon bulunamadı" });
    
    // Antrenör ise, sadece kendi eklediği veya sorumlusu olduğu katılımcıları göster
    const user = await User.findById(req.user.id).populate("role");
    if (user.role.name === "Coach") {
      organisation.participants = organisation.participants.filter(p => 
        p.addedBy._id.toString() === user.id.toString() || 
        (p.coach && p.coach._id.toString() === user.id.toString())
      );
    }
    
    res.json(organisation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// COACH ACCESS ROUTES
// Organizasyona sporcu ekleme (Antrenör/Admin)
router.post("/:id/participants", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    const allowedRoles = ["Coach", "Admin", "Representetive"];

    // Kullanıcının rolünü kontrol et
    if (!allowedRoles.includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const organisation = await Organisation.findById(req.params.id);
    if (!organisation) return res.status(404).json({ message: "Organizasyon bulunamadı" });

    const { participants } = req.body;
    
    // Katılımcı bilgilerinin doğru formatta olduğunu kontrol et
    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ message: "Geçerli katılımcı bilgileri gereklidir" });
    }

    // Tüm katılımcıları kontrol et ve geçerli olanları ekle
    const validParticipants = [];
    const invalidParticipants = [];
    
    for (const participant of participants) {
      const { athleteId, weight, coachId } = participant;
      
      if (!athleteId || weight === undefined) {
        invalidParticipants.push({ athleteId, reason: "Sporcu ID veya kilo bilgisi eksik" });
        continue;
      }
      
      // Sporcuyu kontrol et
      const athlete = await User.findById(athleteId).populate(["role", "belt"]);
      if (!athlete || athlete.role.name !== "Athlete") {
        invalidParticipants.push({ athleteId, reason: "Geçerli bir sporcu değil" });
        continue;
      }
      
      // Yaş kontrolü
      const ageValid = checkBirthDate(athlete.birthDate, organisation.birthDateRequirements);
      if (!ageValid) {
        invalidParticipants.push({ athleteId, reason: "Yaş gereksinimlerini karşılamıyor" });
        continue;
      }
      
      // Kemer kontrolü
      let beltValid = true;
      if (organisation.beltRequirement) {
        if (athlete.belt) {
          beltValid = athlete.belt._id.toString() === organisation.beltRequirement.toString();
        } else {
          beltValid = false;
        }
      }
      
      if (!beltValid) {
        invalidParticipants.push({ athleteId, reason: "Kemer gereksinimlerini karşılamıyor" });
        continue;
      }
      
      // Sporcu zaten eklenmiş mi kontrol et
      // Eğer participants dizisi henüz oluşturulmamışsa, boş bir dizi olarak başlat
      if (!organisation.participants) {
        organisation.participants = [];
      }
      
      const alreadyAdded = organisation.participants.some(p => 
        p.athlete && p.athlete.toString() === athleteId
      );
      
      if (alreadyAdded) {
        invalidParticipants.push({ athleteId, reason: "Sporcu zaten eklenmiş" });
        continue;
      }
      
      // Geçerli katılımcıyı listeye ekle
      validParticipants.push({
        athlete: athleteId,
        weight,
        coach: coachId || null,
        addedBy: req.user.id
      });
    }
    
    // Geçerli katılımcıları organizasyona ekle
    if (validParticipants.length > 0) {
      if (!organisation.participants) {
        organisation.participants = [];
      }
      organisation.participants.push(...validParticipants);
      await organisation.save();
    }
    
    res.status(200).json({
      message: `${validParticipants.length} katılımcı başarıyla eklendi`,
      addedCount: validParticipants.length,
      invalidParticipants: invalidParticipants
    });
  } catch (error) {
    console.error("Katılımcı ekleme hatası:", error);
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

    // beltRequirement bir dizi olarak gönderilirse, ilk elemanını al
    if (updates.beltRequirement && Array.isArray(updates.beltRequirement)) {
      updates.beltRequirement = updates.beltRequirement[0] || null;
    }

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

// Organizasyondan katılımcı çıkarma (Antrenör/Admin)
router.delete("/:id/participants/:athleteId", auth, async (req, res) => {
  try {
    console.log("DELETE isteği alındı:", req.params);
    const user = await User.findById(req.user.id).populate("role");
    const allowedRoles = ["Coach", "Admin", "Representetive"];

    // Yetki kontrolü
    if (!allowedRoles.includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id, athleteId } = req.params;
    const organisation = await Organisation.findById(id);
    
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }
    
    console.log("Organizasyon bulundu:", organisation._id);
    console.log("Katılımcılar:", organisation.participants ? organisation.participants.length : 0);
    
    if (!organisation.participants || organisation.participants.length === 0) {
      return res.status(404).json({ message: "Bu organizasyonda katılımcı bulunmamaktadır" });
    }
    
    // Katılımcıyı bul
    const participantIndex = organisation.participants.findIndex(p => 
      p.athlete && p.athlete.toString() === athleteId
    );
    
    console.log("Katılımcı indeksi:", participantIndex);
    
    if (participantIndex === -1) {
      return res.status(404).json({ message: "Katılımcı bulunamadı" });
    }
    
    // Antrenör ise, sadece kendi eklediği veya sorumlusu olduğu katılımcıları çıkarabilir
    if (user.role.name === "Coach") {
      const participant = organisation.participants[participantIndex];
      if (participant.addedBy.toString() !== user.id.toString() && 
          (!participant.coach || participant.coach.toString() !== user.id.toString())) {
        return res.status(403).json({ 
          message: "Sadece kendi eklediğiniz veya sorumlusu olduğunuz katılımcıları çıkarabilirsiniz" 
        });
      }
    }
    
    // Katılımcıyı çıkar
    organisation.participants.splice(participantIndex, 1);
    await organisation.save();
    
    res.status(200).json({
      message: "Katılımcı organizasyondan çıkarıldı",
      remainingParticipants: organisation.participants.length
    });
  } catch (error) {
    console.error("Katılımcı çıkarma hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Organizasyon katılımcılarını listele
router.get("/:id/participants", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(req.user.id).populate("role");
    
    // Organizasyonu bul ve katılımcıları populate et
    const organisation = await Organisation.findById(id)
      .populate({
        path: "participants.athlete",
        select: "name surname birthDate gender belt weight club",
        populate: [
          { path: "belt", select: "name value" },
          { path: "club", select: "name" }
        ]
      })
      .populate({
        path: "participants.coach",
        select: "name surname"
      })
      .populate({
        path: "participants.addedBy",
        select: "name surname role",
        populate: { path: "role", select: "name" }
      });
    
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }
    
    // Kullanıcı rolüne göre katılımcıları filtrele
    let participants = [...organisation.participants];
    
    // Antrenör ise, sadece kendi eklediği veya sorumlusu olduğu katılımcıları göster
    if (user.role.name === "Coach") {
      participants = participants.filter(p => 
        p.addedBy._id.toString() === user.id.toString() || 
        (p.coach && p.coach._id.toString() === user.id.toString())
      );
    }
    
    // Sıralama ve filtreleme seçenekleri
    const { sortBy, sortOrder, weight, club, belt } = req.query;
    
    // Filtreleme
    if (weight) {
      const [minWeight, maxWeight] = weight.split('-').map(Number);
      if (!isNaN(minWeight) && !isNaN(maxWeight)) {
        participants = participants.filter(p => 
          p.weight >= minWeight && p.weight <= maxWeight
        );
      }
    }
    
    if (club) {
      participants = participants.filter(p => 
        p.athlete.club && p.athlete.club._id.toString() === club
      );
    }
    
    if (belt) {
      participants = participants.filter(p => 
        p.athlete.belt && p.athlete.belt._id.toString() === belt
      );
    }
    
    // Sıralama
    if (sortBy) {
      const order = sortOrder === 'desc' ? -1 : 1;
      
      participants.sort((a, b) => {
        if (sortBy === 'name') {
          return order * a.athlete.name.localeCompare(b.athlete.name);
        } else if (sortBy === 'weight') {
          return order * (a.weight - b.weight);
        } else if (sortBy === 'addedAt') {
          return order * (new Date(a.addedAt) - new Date(b.addedAt));
        }
        return 0;
      });
    }
    
    // İstatistikler ekle
    const stats = {
      total: participants.length,
      weightDistribution: {}
    };
    
    // Kilo dağılımı istatistiği
    participants.forEach(p => {
      const weightRange = Math.floor(p.weight / 5) * 5;
      const rangeKey = `${weightRange}-${weightRange + 5}`;
      
      if (!stats.weightDistribution[rangeKey]) {
        stats.weightDistribution[rangeKey] = 0;
      }
      stats.weightDistribution[rangeKey]++;
    });
    
    res.json({
      participants,
      stats
    });
  } catch (error) {
    console.error("Katılımcı listeleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Organizasyondaki katılımcı bilgilerini güncelleme (PUT)
router.put("/:id/participants/:athleteId", auth, async (req, res) => {
  try {
    console.log("PUT isteği alındı:", req.params);
    const user = await User.findById(req.user.id).populate("role");
    const allowedRoles = ["Coach", "Admin", "Representetive"];

    // Yetki kontrolü
    if (!allowedRoles.includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id, athleteId } = req.params;
    const { weight, coachId } = req.body;
    
    console.log("Güncelleme verileri:", { id, athleteId, weight, coachId });
    
    if (weight === undefined) {
      return res.status(400).json({ message: "Kilo bilgisi gereklidir" });
    }
    
    // Organizasyonu bul
    const organisation = await Organisation.findById(id);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }
    
    console.log("Organizasyon bulundu:", organisation._id);
    
    // Katılımcıları kontrol et
    if (!organisation.participants || organisation.participants.length === 0) {
      return res.status(404).json({ message: "Bu organizasyonda katılımcı bulunmamaktadır" });
    }
    
    // Katılımcıyı bul
    const participantIndex = organisation.participants.findIndex(p => 
      p.athlete && p.athlete.toString() === athleteId
    );
    
    console.log("Katılımcı indeksi:", participantIndex);
    
    if (participantIndex === -1) {
      return res.status(404).json({ message: "Katılımcı bulunamadı" });
    }
    
    // Antrenör ise, sadece kendi eklediği veya sorumlusu olduğu katılımcıları düzenleyebilir
    if (user.role.name === "Coach") {
      const participant = organisation.participants[participantIndex];
      if (participant.addedBy.toString() !== user.id.toString() && 
          (!participant.coach || participant.coach.toString() !== user.id.toString())) {
        return res.status(403).json({ 
          message: "Sadece kendi eklediğiniz veya sorumlusu olduğunuz katılımcıları düzenleyebilirsiniz" 
        });
      }
    }
    
    // Antrenör kontrolü (eğer belirtilmişse)
    if (coachId) {
      const coach = await User.findById(coachId).populate("role");
      if (!coach || coach.role.name !== "Coach") {
        return res.status(400).json({ message: "Geçerli bir antrenör değil" });
      }
    }
    
    // Katılımcı bilgilerini güncelle
    organisation.participants[participantIndex].weight = weight;
    if (coachId !== undefined) {
      organisation.participants[participantIndex].coach = coachId || null;
    }
    
    await organisation.save();
    
    // Güncellenmiş katılımcıyı döndür
    const updatedParticipant = {
      ...organisation.participants[participantIndex].toObject(),
      athleteId: organisation.participants[participantIndex].athlete
    };
    
    res.status(200).json({
      message: "Katılımcı bilgileri güncellendi",
      participant: updatedParticipant
    });
  } catch (error) {
    console.error("Katılımcı güncelleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Yaş kontrolü için yardımcı fonksiyon
function checkBirthDate(birthDate, requirements) {
  if (!birthDate) return false;
  if (!requirements || (!requirements.minDate && !requirements.maxDate)) return true;
  
  const dob = new Date(birthDate);
  
  if (requirements.minDate && new Date(requirements.minDate) > dob) {
    return false;
  }
  
  if (requirements.maxDate && new Date(requirements.maxDate) < dob) {
    return false;
  }
  
  return true;
}

module.exports = router;