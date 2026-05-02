const express = require("express");
const router = express.Router();
const Organisation = require("../models/organisation");
const User = require("../models/user");
const auth = require("../middleware/auth");
const mongoose = require("mongoose");
const Belt = require("../models/belt");
const moment = require('moment');
const City = require("../models/city");
const {
  turkishToAscii,
  chooseLayout,
  createDoc,
  drawPageHeader,
  drawTableHeaders,
  drawTableRow,
  drawGroupHeader,
  drawPageFooter,
  drawSignatureArea,
  LAYOUT,
  COMPACT_LAYOUT,
  drawCompactPageHeader,
  drawCompactTableHeaders,
  drawCompactRow,
  drawCompactGroupHeader,
  drawCompactSignature,
} = require('../utils/pdfGenerator');

// ADMIN ONLY ROUTES
// Organizasyon oluşturma (Sadece Admin)
router.post("/", auth, async (req, res) => {
  try {
    // Admin kontrolü
    const user = await User.findById(req.user.id).populate("role");
    if (user.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { tournamentName, tournamentPlace, tournamentDate, birthDateRequirements, beltRequirement, matchType } = req.body;

    // Zorunlu alan kontrolü
    if (!tournamentPlace || !tournamentDate?.startDate ) {
      return res.status(400).json({ message: "Zorunlu alanları doldurun" });
    }

    const organisation = new Organisation({
      tournamentName,
      tournamentPlace,
      tournamentDate,
      birthDateRequirements,
      beltRequirement: beltRequirement || [],
      matchType: matchType || 'single', // Varsayılan olarak single
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
    const { startDate } = req.query;
    const filter = {};
    
    if (startDate) filter["tournamentDate.startDate"] = { $gte: new Date(startDate) };

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
    
    // Antrenör ise, sadece kendi eklediği katılımcıları göster
    const user = await User.findById(req.user.id).populate("role");
    if (user.role.name === "Coach") {
      organisation.participants = organisation.participants.filter(p => 
        p.addedBy && p.addedBy._id.toString() === user.id.toString()
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
          try {
            // Gerekli kemer bilgisini al
            const requiredBelt = await Belt.findById(organisation.beltRequirement);
            
            if (!requiredBelt) {
              beltValid = false;
            } else {
              // Değerleri karşılaştır
              const athleteBeltValue = athlete.belt.value;
              const requiredBeltValue = requiredBelt.value;
              
              // Sporcunun kemer değeri, gereken değere eşit veya daha yüksek olmalı
              beltValid = athleteBeltValue >= requiredBeltValue;
            }
          } catch (error) {
            console.error("Kemer kontrolü hatası:", error);
            beltValid = false;
          }
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
        weight: weight.toString(),
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

    // matchType doğrulama
    if (updates.matchType && !['single', 'double'].includes(updates.matchType)) {
      return res.status(400).json({ message: "matchType sadece 'single' veya 'double' olabilir" });
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
        select: "name surname birthDate gender belt weight club city",
        populate: [
          { path: "belt", select: "name value" },
          { path: "club", select: "name" },
          { path: "city", select: "name" }
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
      .populate({
        path: "tournamentPlace.city",
        select: "name"
      });
    
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }
    
    // Kullanıcı rolüne göre katılımcıları filtrele
    let participants = [...organisation.participants];
    
    // Antrenör ise, sadece kendi eklediği katılımcıları göster
    if (user.role.name === "Coach") {
      participants = participants.filter(p => 
        p.addedBy && p.addedBy._id.toString() === user.id.toString()
      );
    }
    // Temsilci ise, sadece kendi ilindeki katılımcıları göster
    else if (user.role.name === "Representetive") {
      participants = participants.filter(p => 
        p.athlete && 
        p.athlete.city && 
        p.athlete.city._id.toString() === user.city.toString()
      );
    }
    
    // Sıralama ve filtreleme seçenekleri
    const { sortBy, sortOrder, weight, club, belt, city } = req.query;
    
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
    
    if (city) {
      participants = participants.filter(p => 
        p.athlete.city && p.athlete.city._id.toString() === city
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
    organisation.participants[participantIndex].weight = weight.toString();
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

// Organizasyon katılımcılarının PDF çıktısını al
router.get("/:id/participants/export", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { city } = req.query;
    const user = await User.findById(req.user.id).populate("role");

    const organisation = await Organisation.findById(id)
      .populate({
        path: "participants.athlete",
        select: "name surname birthDate gender belt weight club city",
        populate: [
          { path: "belt", select: "name value" },
          { path: "club", select: "name" },
          { path: "city", select: "name" }
        ]
      })
      .populate({ path: "participants.coach", select: "name surname" })
      .populate({
        path: "participants.addedBy",
        select: "name surname role",
        populate: { path: "role", select: "name" }
      })
      .populate({ path: "tournamentPlace.city", select: "name" });

    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    let participants = [...organisation.participants];

    if (user.role.name === "Coach") {
      participants = participants.filter(p =>
        p.addedBy && p.addedBy._id.toString() === user.id.toString()
      );
    } else if (user.role.name === "Representetive") {
      participants = participants.filter(p =>
        p.athlete && p.athlete.city && p.athlete.city._id.toString() === city
      );
    }

    // Eksik kulüp bilgilerini tamamla
    const Club = mongoose.model('Club');
    const clubIds = participants
      .filter(p => p.athlete && p.athlete.club && typeof p.athlete.club === 'string')
      .map(p => p.athlete.club);
    let clubs = {};
    if (clubIds.length > 0) {
      const clubsData = await Club.find({ _id: { $in: clubIds } }).select('name');
      clubsData.forEach(c => { clubs[c._id.toString()] = c.name; });
    }

    // Şehirlere göre grupla
    const participantsByCity = {};
    participants.forEach(participant => {
      if (participant.athlete && participant.athlete.city) {
        const cityId   = participant.athlete.city._id.toString();
        const cityName = participant.athlete.city.name;
        if (!participantsByCity[cityId]) {
          participantsByCity[cityId] = { cityName, participants: [] };
        }
        if (participant.athlete.club) {
          if (typeof participant.athlete.club === 'string') {
            if (clubs[participant.athlete.club]) {
              participant.athlete.clubName = clubs[participant.athlete.club];
            }
          } else if (participant.athlete.club.name) {
            participant.athlete.clubName = participant.athlete.club.name;
          }
        }
        participantsByCity[cityId].participants.push(participant);
      }
    });
    Object.values(participantsByCity).forEach(g => {
      g.participants.sort((a, b) => a.weight - b.weight);
    });

    // Sütun tanımları – 8 sütun → landscape
    const headers = [
      { label: '#',            width: 25  },
      { label: 'Kategori',     width: 55  },
      { label: 'Ad Soyad',     width: 130 },
      { label: 'Cinsiyet',     width: 55  },
      { label: 'Dogum Tarihi', width: 65  },
      { label: 'Kemer',        width: 55  },
      { label: 'Kulup',        width: 130 },
      { label: 'Antrenor',     width: 130 },
    ];
    const totalW   = headers.reduce((s, c) => s + c.width, 0);
    const layout   = chooseLayout(headers.length, totalW);
    const doc      = createDoc(layout, { Title: 'Organizasyon Katilimcilari', Subject: organisation.tournamentName });
    const m        = LAYOUT.margin;
    const tableLeft = m;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=participants-${id}.pdf`);
    doc.pipe(res);

    let isFirstGroup = true;
    Object.values(participantsByCity).forEach(group => {
      if (!isFirstGroup) {
        doc.addPage({ size: 'A4', layout, margin: m });
      } else {
        isFirstGroup = false;
      }

      let contentY = drawPageHeader(doc, organisation, 'DELEGATION CONTROL LIST');
      contentY = drawGroupHeader(doc, tableLeft, totalW, group.cityName, contentY);
      let rowY = drawTableHeaders(doc, tableLeft, headers, contentY);

      let currentWeight = null;
      let rowIsColored  = false;
      let rowNum        = 0;

      group.participants.forEach(participant => {
        // Sayfa sonu kontrolü
        if (rowY > doc.page.height - m - 40) {
          drawPageFooter(doc);
          doc.addPage({ size: 'A4', layout, margin: m });
          const cy = drawPageHeader(doc, organisation, 'DELEGATION CONTROL LIST');
          const gy = drawGroupHeader(doc, tableLeft, totalW, group.cityName + ' (devam)', cy);
          rowY = drawTableHeaders(doc, tableLeft, headers, gy);
          rowIsColored = false;
        }

        if (currentWeight !== null && currentWeight !== participant.weight) rowY += 3;
        currentWeight = participant.weight;

        const cells = [
          rowNum + 1,
          `${participant.weight} kg`,
          `${turkishToAscii(participant.athlete.name)} ${turkishToAscii(participant.athlete.surname)}`,
          turkishToAscii(participant.athlete.gender),
          moment(participant.athlete.birthDate).format('DD.MM.YYYY'),
          participant.athlete.belt ? turkishToAscii(participant.athlete.belt.name) : '-',
          participant.athlete.clubName ? turkishToAscii(participant.athlete.clubName) : '-',
          participant.coach ? `${turkishToAscii(participant.coach.name)} ${turkishToAscii(participant.coach.surname)}` : '-',
        ];

        rowY = drawTableRow(doc, tableLeft, headers, cells, rowY, rowIsColored);
        rowIsColored = !rowIsColored;
        rowNum++;
      });

      drawPageFooter(doc);
    });

    doc.end();

  } catch (error) {
    console.error("PDF oluşturma hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Organizasyon tartı listesi PDF çıktısını al
router.get("/:id/weighing-list", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { weight, coordinator, chairman, gender } = req.query;

    if (!weight) {
      return res.status(400).json({ message: "Kilo bilgisi gereklidir" });
    }
    if (!gender) {
      return res.status(400).json({ message: "Cinsiyet bilgisi gereklidir" });
    }

    const organisation = await Organisation.findById(id)
      .populate({
        path: "participants.athlete",
        select: "name surname birthDate gender belt weight club city",
        populate: [
          { path: "belt", select: "name value" },
          { path: "club", select: "name" },
          { path: "city", select: "name" }
        ]
      })
      .populate({ path: "participants.coach", select: "name surname" })
      .populate({ path: "tournamentPlace.city", select: "name" });

    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    const participants = [...organisation.participants];

    const filteredParticipants = participants.filter(p =>
      p.athlete &&
      p.athlete.city &&
      p.weight.toString() === weight.toString() &&
      p.athlete.gender === gender
    );

    // 5 sütun, portrait – compact layout
    const headers = [
      { label: '#',        width: 30  },
      { label: 'Ad Soyad', width: 190 },
      { label: 'Sehir',    width: 130 },
      { label: 'Tarti',    width: 70  },
      { label: 'Imza',     width: 95  },
    ];
    const totalW = headers.reduce((s, c) => s + c.width, 0);
    const layout = chooseLayout(headers.length, totalW);
    const m      = COMPACT_LAYOUT.margin;

    const doc = createDoc(layout, { Title: 'Tarti Listesi', Subject: organisation.tournamentName });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=weighing-list-${weight}.pdf`);
    doc.pipe(res);

    const pageTitle = `TARTI LISTESI  |  ${turkishToAscii(organisation.tournamentName)}  |  ${weight} kg - ${turkishToAscii(gender)}`;
    const tableLeft = m;
    // Reserve bottom space: signature (35px) + footer (20px) + gap (10px) = 65px
    const bottomReserve = 65;

    let contentY = drawCompactPageHeader(doc, pageTitle);
    let rowY     = drawCompactTableHeaders(doc, tableLeft, headers, contentY);
    let rowIsColored = false;

    filteredParticipants.forEach((participant, index) => {
      if (rowY > doc.page.height - m - bottomReserve) {
        // Footer + new page
        doc.font('Times-Roman').fontSize(7).fillColor('#6b7280')
           .text(`Olusturulma: ${moment().format('DD.MM.YYYY HH:mm')}`, m, doc.page.height - m - 10,
             { width: doc.page.width - 2 * m, align: 'center' });
        doc.addPage({ size: 'A4', layout, margin: m });
        const cy = drawCompactPageHeader(doc, pageTitle);
        rowY = drawCompactTableHeaders(doc, tableLeft, headers, cy);
        rowIsColored = false;
      }

      const cells = [
        index + 1,
        `${turkishToAscii(participant.athlete.name)} ${turkishToAscii(participant.athlete.surname)}`,
        participant.athlete.city ? turkishToAscii(participant.athlete.city.name) : '-',
        '',
        '',
      ];

      rowY = drawCompactRow(doc, tableLeft, headers, cells, rowY, rowIsColored);
      rowIsColored = !rowIsColored;
    });

    // İmza alanı: same page if space, otherwise new page
    const sigNeeded = 55;
    if (rowY + sigNeeded > doc.page.height - m - 20) {
      doc.font('Times-Roman').fontSize(7).fillColor('#6b7280')
         .text(`Olusturulma: ${moment().format('DD.MM.YYYY HH:mm')}`, m, doc.page.height - m - 10,
           { width: doc.page.width - 2 * m, align: 'center' });
      doc.addPage({ size: 'A4', layout, margin: m });
      rowY = m + 20;
    }
    drawCompactSignature(doc, coordinator, chairman, rowY + 15);
    doc.font('Times-Roman').fontSize(7).fillColor('#6b7280')
       .text(`Olusturulma: ${moment().format('DD.MM.YYYY HH:mm')}`, m, doc.page.height - m - 10,
         { width: doc.page.width - 2 * m, align: 'center' });
    doc.end();

  } catch (error) {
    console.error("Tartı listesi oluşturma hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Organizasyon tüm tartı listesi PDF çıktısını al
router.get("/:id/all-weighing-list", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { coordinator, chairman } = req.query;

    const organisation = await Organisation.findById(id)
      .populate({
        path: "participants.athlete",
        select: "name surname birthDate gender belt weight club city",
        populate: [
          { path: "belt", select: "name value" },
          { path: "club", select: "name" },
          { path: "city", select: "name" }
        ]
      })
      .populate({ path: "participants.coach", select: "name surname" })
      .populate({ path: "tournamentPlace.city", select: "name" });

    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    let participants = [...organisation.participants];

    // Kulüp bilgilerini tamamla
    const Club = mongoose.model('Club');
    const clubIds = participants
      .filter(p => p.athlete && p.athlete.club && typeof p.athlete.club === 'string')
      .map(p => p.athlete.club);
    let clubs = {};
    if (clubIds.length > 0) {
      const clubsData = await Club.find({ _id: { $in: clubIds } }).select('name');
      clubsData.forEach(c => { clubs[c._id.toString()] = c.name; });
    }
    participants.forEach(participant => {
      if (participant.athlete && participant.athlete.club) {
        if (typeof participant.athlete.club === 'string') {
          if (clubs[participant.athlete.club]) {
            participant.athlete.clubName = clubs[participant.athlete.club];
          }
        } else if (participant.athlete.club.name) {
          participant.athlete.clubName = participant.athlete.club.name;
        }
      }
    });

    // Kilo × cinsiyet grupları
    const participantsByWeight = {};
    participants.forEach(participant => {
      if (participant.athlete && participant.weight) {
        const w   = participant.weight.toString();
        const g   = participant.athlete.gender;
        const key = `${w}-${g}`;
        if (!participantsByWeight[key]) {
          participantsByWeight[key] = { weight: w, gender: g, participants: [] };
        }
        participantsByWeight[key].participants.push(participant);
      }
    });

    const sortedWeights = Object.keys(participantsByWeight).sort((a, b) => {
      const [wA, gA] = a.split('-');
      const [wB, gB] = b.split('-');
      if (parseInt(wA) !== parseInt(wB)) return parseInt(wA) - parseInt(wB);
      return gA === 'Kadın' ? -1 : 1;
    });

    // 5 sütun, portrait – compact layout
    const headers = [
      { label: '#',        width: 30  },
      { label: 'Ad Soyad', width: 190 },
      { label: 'Sehir',    width: 130 },
      { label: 'Tarti',    width: 70  },
      { label: 'Imza',     width: 95  },
    ];
    const totalW  = headers.reduce((s, c) => s + c.width, 0);
    const layout  = chooseLayout(headers.length, totalW);
    const m       = COMPACT_LAYOUT.margin;
    const tableLeft = m;

    const doc = createDoc(layout, { Title: 'Tum Tarti Listeleri', Subject: organisation.tournamentName });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=all-weighing-lists.pdf`);
    doc.pipe(res);

    const pageTitle = `TUM TARTI LISTELERI  |  ${turkishToAscii(organisation.tournamentName)}`;

    function addFooter() {
      doc.font('Times-Roman').fontSize(7).fillColor('#6b7280')
         .text(`Olusturulma: ${moment().format('DD.MM.YYYY HH:mm')}`, m, doc.page.height - m - 10,
           { width: doc.page.width - 2 * m, align: 'center' });
    }

    let contentY = drawCompactPageHeader(doc, pageTitle);
    // bottom reserve: footer 20px + gap 10px
    const bottomReserve = 30;

    sortedWeights.forEach((weightKey, weightIndex) => {
      const { weight, gender, participants: group } = participantsByWeight[weightKey];
      const groupLabel = `${weight} kg - ${turkishToAscii(gender)}`;

      // New page if group header + at least one row won't fit
      if (contentY + 16 + COMPACT_LAYOUT.rowHeight > doc.page.height - m - bottomReserve) {
        addFooter();
        doc.addPage({ size: 'A4', layout, margin: m });
        contentY = drawCompactPageHeader(doc, pageTitle);
      }

      contentY = drawCompactGroupHeader(doc, tableLeft, totalW, groupLabel, contentY);
      let rowY = drawCompactTableHeaders(doc, tableLeft, headers, contentY);
      let rowIsColored = false;

      group.forEach((participant, index) => {
        if (rowY > doc.page.height - m - bottomReserve) {
          addFooter();
          doc.addPage({ size: 'A4', layout, margin: m });
          const cy = drawCompactPageHeader(doc, pageTitle);
          const gy = drawCompactGroupHeader(doc, tableLeft, totalW, `${groupLabel} (devam)`, cy);
          rowY = drawCompactTableHeaders(doc, tableLeft, headers, gy);
          rowIsColored = false;
        }

        const cells = [
          index + 1,
          `${turkishToAscii(participant.athlete.name)} ${turkishToAscii(participant.athlete.surname)}`,
          participant.athlete.city ? turkishToAscii(participant.athlete.city.name) : '-',
          '',
          '',
        ];

        rowY = drawCompactRow(doc, tableLeft, headers, cells, rowY, rowIsColored);
        rowIsColored = !rowIsColored;
      });

      contentY = rowY + 6; // small gap between groups
    });

    // İmza alanı – son sayfada, yer yoksa yeni sayfa aç
    const sigNeeded = 55;
    let sigY = contentY + 10;
    if (sigY + sigNeeded > doc.page.height - m - 20) {
      addFooter();
      doc.addPage({ size: 'A4', layout, margin: m });
      sigY = m + 20;
    }
    drawCompactSignature(doc, coordinator, chairman, sigY);
    addFooter();
    doc.end();

  } catch (error) {
    console.error("Tüm tartı listeleri oluşturma hatası:", error);
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

// Organizasyon için turnuva maçlarını getir
router.get("/:id/tournament-matches", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { weightCategory, gender, status } = req.query;
    
    // Organizasyonun var olduğunu kontrol et
    const organisation = await Organisation.findById(id);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }
    
    // TournamentMatch modelini import et
    const TournamentMatch = require("../models/tournamentMatch");
    
    const filters = { organisationId: id };
    if (weightCategory) filters.weightCategory = weightCategory;
    if (gender) filters.gender = gender;
    if (status) filters.status = status;
    
    const tournamentMatches = await TournamentMatch.find(filters)
      .sort({ createdAt: -1 });
    
    // Her turnuva için istatistikleri ekle
    const matchesWithStats = tournamentMatches.map(match => {
      const stats = match.getStats();
      return {
        ...match.toObject(),
        stats
      };
    });
    
    res.json(matchesWithStats);
  } catch (error) {
    console.error("Organizasyon turnuva maçları getirme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Gelen veriyi temizleyen fonksiyon
function cleanTournamentData(data) {
  if (data.tournamentType === 'round_robin' && data.rounds) {
    data.rounds.forEach(round => {
      round.matches.forEach(match => {
        // BYE oyuncularını temizle
        if (match.player1 && (match.player1.name === "BYE" || match.player1.participantId === "bye")) {
          match.player1 = null;
        }
        if (match.player2 && (match.player2.name === "BYE" || match.player2.participantId === "bye")) {
          match.player2 = null;
        }
      });
    });
  } else if ((data.tournamentType === 'single_elimination' || data.tournamentType === 'double_elimination') && data.brackets) {
    data.brackets.forEach(match => {
      // BYE oyuncularını temizle
      if (match.player1 && (match.player1.name === "BYE" || match.player1.participantId === "bye")) {
        match.player1 = null;
      }
      if (match.player2 && (match.player2.name === "BYE" || match.player2.participantId === "bye")) {
        match.player2 = null;
      }
    });
    
    // Double elimination için loser brackets da temizle
    if (data.tournamentType === 'double_elimination' && data.loserBrackets) {
      data.loserBrackets.forEach(match => {
        if (match.player1 && (match.player1.name === "BYE" || match.player1.participantId === "bye")) {
          match.player1 = null;
        }
        if (match.player2 && (match.player2.name === "BYE" || match.player2.participantId === "bye")) {
          match.player2 = null;
        }
      });
    }
  }
  return data;
}

// Round Robin turnuva oluşturma yardımcı fonksiyonu
function createRoundRobinMatches(participants) {
  const rounds = [];
  const n = participants.length;
  
  if (n < 2) {
    return rounds;
  }
  
  // Eğer tek sayıda katılımcı varsa, "bye" ekle
  const players = [...participants];
  if (n % 2 === 1) {
    players.push({ 
      name: "BYE", 
      isBye: true,
      city: "BYE",
      club: "BYE"
    });
  }
  
  const numRounds = players.length - 1;
  const halfSize = players.length / 2;
  
  for (let round = 0; round < numRounds; round++) {
    const roundMatches = [];
    
    for (let i = 0; i < halfSize; i++) {
      const player1Index = i;
      const player2Index = players.length - 1 - i;
      
      // İlk oyuncu sabit, diğerleri döner
      const player1 = round === 0 ? players[player1Index] : 
                     round % 2 === 0 ? players[player1Index] : players[player2Index];
      const player2 = round === 0 ? players[player2Index] : 
                     round % 2 === 0 ? players[player2Index] : players[player1Index];
      
      // BYE maçı oluşturma - BYE olan oyuncuyu null olarak bırak
      if (player1.isBye && player2.isBye) {
        continue; // Her iki oyuncu da BYE ise maç oluşturma
      }
      
      const match = {
        matchId: `round_${round + 1}_match_${i + 1}`,
        player1: player1.isBye ? null : player1,
        player2: player2.isBye ? null : player2,
        status: 'scheduled',
        winner: null,
        score: { player1Score: 0, player2Score: 0 },
        scheduledTime: null,
        completedAt: null,
        notes: ''
      };
      
      roundMatches.push(match);
    }
    
    rounds.push({
      roundNumber: round + 1,
      matches: roundMatches
    });
    
    // Oyuncuları döndür (Berger tablosu)
    const lastPlayer = players.pop();
    players.splice(1, 0, lastPlayer);
  }
  
  return rounds;
}

// Single Elimination turnuva oluşturma yardımcı fonksiyonu
function createSingleEliminationBrackets(participants) {
  const brackets = [];
  const n = participants.length;
  
  if (n < 2) {
    return brackets;
  }
  
  // Turnuva seviyesini hesapla (2^n >= katılımcı sayısı)
  const levels = Math.ceil(Math.log2(n));
  const totalMatches = Math.pow(2, levels - 1);
  
  let matchNumber = 1;
  let roundNumber = 1;
  
  // İlk tur maçları
  for (let i = 0; i < totalMatches; i++) {
    const player1Index = i;
    const player2Index = totalMatches * 2 - 1 - i;
    
    const player1 = participants[player1Index];
    const player2 = participants[player2Index];
    
    // Eğer her iki oyuncu da yoksa, bu maçı atla
    if (!player1 && !player2) {
      continue;
    }
    
    const match = {
      roundNumber,
      matchNumber,
      player1: player1 || null,
      player2: player2 || null,
      status: 'scheduled',
      winner: null,
      score: { player1Score: 0, player2Score: 0 },
      scheduledTime: null,
      completedAt: null,
      nextMatchNumber: Math.ceil(matchNumber / 2) + totalMatches,
      nextMatchSlot: matchNumber % 2 === 1 ? 'player1' : 'player2',
      notes: ''
    };
    
    brackets.push(match);
    matchNumber++;
  }
  
  // Sonraki turlar için boş maçlar
  for (let round = 2; round <= levels; round++) {
    const matchesInRound = Math.pow(2, levels - round);
    
    for (let i = 0; i < matchesInRound; i++) {
      const match = {
        roundNumber: round,
        matchNumber: matchNumber,
        player1: null,
        player2: null,
        status: 'scheduled',
        winner: null,
        score: { player1Score: 0, player2Score: 0 },
        scheduledTime: null,
        completedAt: null,
        nextMatchNumber: round < levels ? Math.ceil(matchNumber / 2) + totalMatches + Math.pow(2, levels - round - 1) : null,
        nextMatchSlot: matchNumber % 2 === 1 ? 'player1' : 'player2',
        notes: ''
      };
      
      brackets.push(match);
      matchNumber++;
    }
  }
  
  return brackets;
}

// Double Elimination turnuva oluşturma yardımcı fonksiyonu
function createDoubleEliminationBrackets(participants) {
  const winnerBrackets = [];
  const loserBrackets = [];
  const n = participants.length;
  
  if (n < 2) {
    return { winnerBrackets, loserBrackets };
  }
  
  // Ana bracket (winner bracket) - single elimination gibi başlar
  const levels = Math.ceil(Math.log2(n));
  const totalMatches = Math.pow(2, levels - 1);
  
  let matchNumber = 1;
  let roundNumber = 1;
  
  // İlk tur maçları (winner bracket)
  for (let i = 0; i < totalMatches; i++) {
    const player1Index = i;
    const player2Index = totalMatches * 2 - 1 - i;
    
    const player1 = participants[player1Index];
    const player2 = participants[player2Index];
    
    if (!player1 && !player2) {
      continue;
    }
    
    const match = {
      roundNumber,
      matchNumber,
      player1: player1 || null,
      player2: player2 || null,
      status: 'scheduled',
      winner: null,
      score: { player1Score: 0, player2Score: 0 },
      scheduledTime: null,
      completedAt: null,
      nextMatchNumber: Math.ceil(matchNumber / 2) + totalMatches,
      nextMatchSlot: matchNumber % 2 === 1 ? 'player1' : 'player2',
      loserNextMatchNumber: matchNumber, // Kaybeden loser bracket'e gider
      notes: ''
    };
    
    winnerBrackets.push(match);
    matchNumber++;
  }
  
  // Winner bracket'in sonraki turları
  for (let round = 2; round <= levels; round++) {
    const matchesInRound = Math.pow(2, levels - round);
    
    for (let i = 0; i < matchesInRound; i++) {
      const match = {
        roundNumber: round,
        matchNumber: matchNumber,
        player1: null,
        player2: null,
        status: 'scheduled',
        winner: null,
        score: { player1Score: 0, player2Score: 0 },
        scheduledTime: null,
        completedAt: null,
        nextMatchNumber: round < levels ? Math.ceil(matchNumber / 2) + totalMatches + Math.pow(2, levels - round - 1) : null,
        nextMatchSlot: matchNumber % 2 === 1 ? 'player1' : 'player2',
        loserNextMatchNumber: matchNumber + 1000, // Loser bracket için offset
        notes: ''
      };
      
      winnerBrackets.push(match);
      matchNumber++;
    }
  }
  
  // Loser bracket oluştur - basit versiyon
  let loserMatchNumber = 1000; // Loser bracket için farklı numaralar
  for (let i = 0; i < Math.floor(n/2); i++) {
    const match = {
      roundNumber: 1,
      matchNumber: loserMatchNumber,
      player1: null,
      player2: null,
      status: 'scheduled',
      winner: null,
      score: { player1Score: 0, player2Score: 0 },
      scheduledTime: null,
      completedAt: null,
      nextMatchNumber: loserMatchNumber + 1,
      nextMatchSlot: 'player1',
      notes: ''
    };
    
    loserBrackets.push(match);
    loserMatchNumber++;
  }
  
  return { winnerBrackets, loserBrackets };
}

// Organizasyon için turnuva maçı oluştur
router.post("/:id/tournament-matches", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar maç oluşturabilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }
    
    const { id } = req.params;
    const { weightCategory, gender, tournamentType, rounds, brackets, participants } = req.body;
    
    // Debug: gelen veriyi kontrol et
    console.log('Tournament match creation - received data:', {
      tournamentType,
      bracketCount: brackets ? brackets.length : 0,
      loserBracketCount: req.body.loserBrackets ? req.body.loserBrackets.length : 0,
      hasParticipants: participants && participants.length > 0
    });
    
    // Zorunlu alan kontrolü
    if (!weightCategory || !gender || !tournamentType) {
      return res.status(400).json({ message: "Zorunlu alanları doldurun" });
    }
    
    // Organizasyonun var olduğunu kontrol et
    const organisation = await Organisation.findById(id);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }
    
    // TournamentMatch modelini import et
    const TournamentMatch = require("../models/tournamentMatch");
    
    // Aynı kategori ve cinsiyet için zaten turnuva var mı kontrol et
    const existingTournament = await TournamentMatch.findOne({
      organisationId: id,
      weightCategory,
      gender
    });
    
    if (existingTournament) {
      return res.status(400).json({ 
        message: "Bu kategori ve cinsiyet için zaten bir turnuva mevcut" 
      });
    }
    
    let tournamentRounds = [];
    let tournamentBrackets = [];
    let tournamentLoserBrackets = [];
    
    // Eğer katılımcılar verilmişse otomatik maç oluştur
    if (participants && participants.length > 0) {
      if (tournamentType === 'round_robin') {
        tournamentRounds = createRoundRobinMatches(participants);
      } else if (tournamentType === 'single_elimination') {
        tournamentBrackets = createSingleEliminationBrackets(participants);
      } else if (tournamentType === 'double_elimination') {
        const doubleElimResult = createDoubleEliminationBrackets(participants);
        tournamentBrackets = doubleElimResult.winnerBrackets;
        tournamentLoserBrackets = doubleElimResult.loserBrackets;
      }
    } else {
      // Manuel olarak verilen maçları kullan ve temizle
      if (tournamentType === 'round_robin') {
        tournamentRounds = rounds || [];
        if (tournamentRounds.length > 0) {
          const cleanedData = cleanTournamentData({ tournamentType, rounds: tournamentRounds });
          tournamentRounds = cleanedData.rounds;
        }
      } else if (tournamentType === 'single_elimination') {
        tournamentBrackets = brackets || [];
        if (tournamentBrackets.length > 0) {
          const cleanedData = cleanTournamentData({ tournamentType, brackets: tournamentBrackets });
          tournamentBrackets = cleanedData.brackets;
        }
      } else if (tournamentType === 'double_elimination') {
        // Double elimination için manuel bracket verileri
        tournamentBrackets = brackets || [];
        tournamentLoserBrackets = req.body.loserBrackets || [];
        
        if (tournamentBrackets.length > 0 || tournamentLoserBrackets.length > 0) {
          const cleanedData = cleanTournamentData({ 
            tournamentType, 
            brackets: tournamentBrackets,
            loserBrackets: tournamentLoserBrackets 
          });
          tournamentBrackets = cleanedData.brackets || [];
          tournamentLoserBrackets = cleanedData.loserBrackets || [];
        }
      }
    }
    
    // Debug: ne kaydedilecek kontrol et
    console.log('Tournament match creation - saving data:', {
      tournamentType,
      roundsCount: tournamentRounds.length,
      bracketsCount: tournamentBrackets.length,
      loserBracketsCount: tournamentLoserBrackets.length
    });
    
    const tournamentMatch = new TournamentMatch({
      organisationId: id,
      weightCategory,
      gender,
      tournamentType,
      rounds: tournamentRounds,
      brackets: tournamentBrackets,
      loserBrackets: tournamentLoserBrackets,
      status: 'active'
    });
    
    await tournamentMatch.save();
    res.status(201).json(tournamentMatch);
  } catch (error) {
    console.error("Organizasyon turnuva maçı oluşturma hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;