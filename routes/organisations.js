const express = require("express");
const router = express.Router();
const Organisation = require("../models/organisation");
const User = require("../models/user");
const auth = require("../middleware/auth");
const mongoose = require("mongoose");
const Belt = require("../models/belt");
const PDFDocument = require('pdfkit');
const moment = require('moment');
const City = require("../models/city");
const fs = require('fs');
const path = require('path');

// ADMIN ONLY ROUTES
// Organizasyon oluşturma (Sadece Admin)
router.post("/", auth, async (req, res) => {
  try {
    // Admin kontrolü
    const user = await User.findById(req.user.id).populate("role");
    if (user.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { tournamentName, tournamentPlace, tournamentDate, birthDateRequirements, beltRequirement } = req.body;

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
    
    // Antrenör ise, sadece kendi eklediği veya sorumlusu olduğu katılımcıları göster
    if (user.role.name === "Coach") {
      participants = participants.filter(p => 
        p.addedBy._id.toString() === user.id.toString() || 
        (p.coach && p.coach._id.toString() === user.id.toString())
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

// Organizasyon katılımcılarının PDF çıktısını al
router.get("/:id/participants/export", auth, async (req, res) => {
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
    
    // Antrenör ise, sadece kendi eklediği veya sorumlusu olduğu katılımcıları göster
    if (user.role.name === "Coach") {
      participants = participants.filter(p => 
        p.addedBy._id.toString() === user.id.toString() || 
        (p.coach && p.coach._id.toString() === user.id.toString())
      );
    }
    
    // Eksik kulüp bilgilerini tamamla
    const Club = mongoose.model('Club'); // Kulüp modelini al
    
    // Tüm kulüpleri bir kerede getir
    const clubIds = participants
      .filter(p => p.athlete && p.athlete.club && typeof p.athlete.club === 'string')
      .map(p => p.athlete.club);
    
    let clubs = {};
    if (clubIds.length > 0) {
      const clubsData = await Club.find({ _id: { $in: clubIds } }).select('name');
      clubsData.forEach(club => {
        clubs[club._id.toString()] = club.name;
      });
    }
    
    // Şehirlere göre katılımcıları gruplandır
    const participantsByCity = {};
    
    participants.forEach(participant => {
      if (participant.athlete && participant.athlete.city) {
        const cityId = participant.athlete.city._id.toString();
        const cityName = participant.athlete.city.name;
        
        if (!participantsByCity[cityId]) {
          participantsByCity[cityId] = {
            cityName,
            participants: []
          };
        }
        
        // Kulüp bilgisini ekle
        if (participant.athlete.club) {
          if (typeof participant.athlete.club === 'string') {
            const clubId = participant.athlete.club;
            if (clubs[clubId]) {
              participant.athlete.clubName = clubs[clubId];
            }
          } else if (participant.athlete.club.name) {
            participant.athlete.clubName = participant.athlete.club.name;
          }
        }
        
        participantsByCity[cityId].participants.push(participant);
      }
    });
    
    // Her şehir için katılımcıları kiloya göre sırala
    Object.values(participantsByCity).forEach(city => {
      city.participants.sort((a, b) => a.weight - b.weight);
    });
    
    // Renk tanımlamaları
    const colors = {
      primary: '#1e3a8a',      // Koyu mavi
      secondary: '#3b82f6',    // Açık mavi
      accent: '#f59e0b',       // Turuncu
      light: '#f3f4f6',        // Açık gri
      dark: '#1f2937',         // Koyu gri
      white: '#ffffff',        // Beyaz
      headerBg: '#e5e7eb',     // Başlık arkaplanı
      tableBorder: '#d1d5db',  // Tablo çizgileri
      tableRowAlt: '#f9fafb'   // Alternatif satır rengi
    };
    
    // PDF oluştur - Yatay (Landscape) format
    const doc = new PDFDocument({ 
      size: 'A4',
      layout: 'landscape', // Yatay format
      margin: 50,
      info: {
        Title: 'Organizasyon Katılımcıları',
        Author: 'Türkiye Kuraş Federasyonu',
        Subject: organisation.tournamentName
      }
    });
    
    // PDF başlığını ayarla
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=participants-${id}.pdf`);
    
    // PDF'i response'a pipe et
    doc.pipe(res);
    
    // Türkçe karakterleri ASCII karşılıklarıyla değiştiren yardımcı fonksiyon
    function turkishToAscii(text) {
      if (!text) return ''; // text undefined veya null ise boş string döndür
      
      return text
        .replace(/ı/g, 'i')
        .replace(/İ/g, 'I')
        .replace(/ğ/g, 'g')
        .replace(/Ğ/g, 'G')
        .replace(/ü/g, 'u')
        .replace(/Ü/g, 'U')
        .replace(/ş/g, 's')
        .replace(/Ş/g, 'S')
        .replace(/ç/g, 'c')
        .replace(/Ç/g, 'C')
        .replace(/ö/g, 'o')
        .replace(/Ö/g, 'O');
    }
    
    // Tablo sütun genişlikleri - sabit değişken olarak tanımla
    const colWidths = [30, 60, 140, 60, 60, 60, 140, 140]; // Sütun genişlikleri
    
    // Sabit değerler - tüm sayfalarda tutarlılık için
    const pageMargin = 50;
    const tableLeft = pageMargin;
    
    // Sayfa üstbilgisi çizme fonksiyonu
    function drawHeader(doc) {
      // Üst bilgi arka planı
      doc.rect(pageMargin, pageMargin, doc.page.width - 2 * pageMargin, 80)
         .fill(colors.light);
      
      // Başlık alanı (tam genişlik)
      doc.font('Times-Bold').fontSize(18).fillColor(colors.primary)
         .text('TURKIYE KURAS FEDERASYONU', pageMargin + 20, pageMargin + 15, { 
           width: doc.page.width - 2 * pageMargin - 40,
           align: 'center' 
         });
      
      doc.fontSize(16).fillColor(colors.dark)
         .text(turkishToAscii(organisation.tournamentName), pageMargin + 20, pageMargin + 40, { 
           width: doc.page.width - 2 * pageMargin - 40,
           align: 'center' 
         });
      
      // Turnuva tarihleri
      const startDate = moment(organisation.tournamentDate.startDate).format('DD.MM.YYYY');
      const endDate = organisation.tournamentDate.endDate ? 
        moment(organisation.tournamentDate.endDate).format('DD.MM.YYYY') : 
        startDate;
      
      doc.fontSize(12).fillColor(colors.secondary)
         .text(`${startDate} - ${endDate}`, pageMargin + 20, pageMargin + 60, { 
           width: doc.page.width - 2 * pageMargin - 40,
           align: 'center' 
         });
      
      // Turnuva yeri
      if (organisation.tournamentPlace && organisation.tournamentPlace.city) {
        doc.fillColor(colors.dark)
           .text(`${turkishToAscii(organisation.tournamentPlace.city.name)} - ${turkishToAscii(organisation.tournamentPlace.venue)}`, 
                 pageMargin + 20, pageMargin + 75, { 
                   width: doc.page.width - 2 * pageMargin - 40,
                   align: 'center' 
                 });
      }
      
      // Sayfa başlığı
      doc.rect(pageMargin, pageMargin + 90, doc.page.width - 2 * pageMargin, 30)
         .fill(colors.primary);
      
      doc.font('Times-Bold').fontSize(14).fillColor(colors.white)
         .text('DELEGATION CONTROL LIST', pageMargin + 10, pageMargin + 98, { 
           width: doc.page.width - 2 * pageMargin - 20,
           align: 'center' 
         });
      
      return pageMargin + 130; // Başlıktan sonraki Y pozisyonunu döndür
    }
    
    // Tablo başlıklarını çizme fonksiyonu - tekrar kullanılabilir
    function drawTableHeaders(doc, tableTop) {
      // Tablo başlık arka planı
      doc.rect(tableLeft, tableTop, colWidths.reduce((a, b) => a + b, 0), 20)
         .fill(colors.headerBg);
      
      doc.font('Times-Bold').fontSize(10).fillColor(colors.dark);
      doc.text('#', tableLeft + 5, tableTop + 5);
      doc.text('Kategori', tableLeft + colWidths[0] + 5, tableTop + 5); // Kategori sütunu
      doc.text('Ad Soyad', tableLeft + colWidths[0] + colWidths[1] + 5, tableTop + 5); // Ad Soyad sütunu
      doc.text('Cinsiyet', tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + 5, tableTop + 5);
      doc.text('Dogum Tarihi', tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + 5, tableTop + 5);
      doc.text('Kemer', tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4] + 5, tableTop + 5);
      doc.text('Kulup', tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4] + colWidths[5] + 5, tableTop + 5);
      doc.text('Antrenor', tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4] + colWidths[5] + colWidths[6] + 5, tableTop + 5);
      
      // Tablo dış çerçevesi
      doc.rect(tableLeft, tableTop, colWidths.reduce((a, b) => a + b, 0), 20)
         .lineWidth(1)
         .stroke(colors.tableBorder);
      
      // Sütun çizgileri
      let x = tableLeft;
      for (let i = 0; i < colWidths.length - 1; i++) {
        x += colWidths[i];
        doc.moveTo(x, tableTop)
           .lineTo(x, tableTop + 20)
           .lineWidth(0.5)
           .stroke(colors.tableBorder);
      }
      
      return tableTop + 20; // Başlıktan sonraki Y pozisyonunu döndür
    }
    
    // İlk sayfa başlığını çiz
    let contentY = drawHeader(doc);
    
    // İlk sayfa mı kontrolü
    let isFirstPage = true;
    
    // Her şehir için tablo oluştur
    Object.values(participantsByCity).forEach(city => {
      // İlk sayfa değilse yeni sayfa ekle
      if (!isFirstPage) {
        doc.addPage({ 
          size: 'A4',
          layout: 'landscape',
          margin: pageMargin
        });
        contentY = drawHeader(doc);
      } else {
        isFirstPage = false;
      }
      
      // Şehir başlığı - her zaman sol hizalı
      doc.rect(tableLeft, contentY, colWidths.reduce((a, b) => a + b, 0), 25)
         .fill(colors.accent);
      
      doc.font('Times-Bold').fontSize(12).fillColor(colors.white);
      doc.text(turkishToAscii(city.cityName), tableLeft + 10, contentY + 7, { 
        align: 'left',
        continued: false
      });
      
      contentY += 25;
      
      // Tablo başlıklarını çiz
      let rowY = drawTableHeaders(doc, contentY);
      
      // Tablo içeriği
      doc.font('Times-Roman').fontSize(10);
      
      let currentWeight = null;
      let participantsProcessed = 0;
      let rowIsColored = false;
      
      // Her katılımcı için
      city.participants.forEach((participant, index) => {
        // Yeni sayfaya geçme kontrolü - sayfa sonuna yaklaşıldığında
        if (rowY > doc.page.height - 100) {
          // Yeni sayfa ekle ve yatay formatı koru
          doc.addPage({ 
            size: 'A4',
            layout: 'landscape',
            margin: pageMargin
          });
          
          // Yeni sayfada üstbilgiyi çiz
          contentY = drawHeader(doc);
          
          // Yeni sayfada şehir başlığını ve tablo başlıklarını tekrar ekle
          doc.rect(tableLeft, contentY, colWidths.reduce((a, b) => a + b, 0), 25)
             .fill(colors.accent);
          
          doc.font('Times-Bold').fontSize(12).fillColor(colors.white);
          doc.text(turkishToAscii(city.cityName) + ' (devam)', tableLeft + 10, contentY + 7, { 
            align: 'left',
            continued: false
          });
          
          contentY += 25;
          
          // Tablo başlıklarını yeniden çiz
          rowY = drawTableHeaders(doc, contentY);
          
          // İçerik fontunu ayarla
          doc.font('Times-Roman').fontSize(10);
          rowIsColored = false;
        }
        
        // Kilo değiştiğinde boşluk bırak ve arka plan rengini değiştir
        if (currentWeight !== null && currentWeight !== participant.weight) {
          rowY += 5;
        }
        currentWeight = participant.weight;
        
        // Alternatif satır renklendirme
        if (rowIsColored) {
          doc.rect(tableLeft, rowY, colWidths.reduce((a, b) => a + b, 0), 20)
             .fill(colors.tableRowAlt);
        }
        rowIsColored = !rowIsColored;
        
        // Cinsiyet değerini Türkçe olarak ayarla
        const genderText = participant.athlete.gender;
        
        // Satır içeriği
        doc.fillColor(colors.dark);
        doc.text((participantsProcessed + 1).toString(), tableLeft + 5, rowY + 5);
        doc.text(
          `${participant.weight} kg`, // Kategori (kilo) bilgisi
          tableLeft + colWidths[0] + 5, 
          rowY + 5
        );
        doc.text(
          `${turkishToAscii(participant.athlete.name)} ${turkishToAscii(participant.athlete.surname)}`, 
          tableLeft + colWidths[0] + colWidths[1] + 5, 
          rowY + 5
        );
        doc.text(
          turkishToAscii(genderText),
          tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + 5, 
          rowY + 5
        );
        doc.text(
          moment(participant.athlete.birthDate).format('DD.MM.YYYY'), 
          tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + 5, 
          rowY + 5
        );
        doc.text(
          participant.athlete.belt ? turkishToAscii(participant.athlete.belt.name) : '-', 
          tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4] + 5, 
          rowY + 5
        );
        doc.text(
          participant.athlete.clubName ? turkishToAscii(participant.athlete.clubName) : '-',
          tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4] + colWidths[5] + 5, 
          rowY + 5
        );
        doc.text(
          participant.coach ? `${turkishToAscii(participant.coach.name)} ${turkishToAscii(participant.coach.surname)}` : '-', 
          tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4] + colWidths[5] + colWidths[6] + 5, 
          rowY + 5
        );
        
        // Satır çizgisi
        doc.rect(tableLeft, rowY, colWidths.reduce((a, b) => a + b, 0), 20)
           .lineWidth(0.5)
           .stroke(colors.tableBorder);
        
        // Sütun çizgileri
        let x = tableLeft;
        for (let i = 0; i < colWidths.length - 1; i++) {
          x += colWidths[i];
          doc.moveTo(x, rowY)
             .lineTo(x, rowY + 20)
             .lineWidth(0.5)
             .stroke(colors.tableBorder);
        }
        
        rowY += 20;
        participantsProcessed++;
      });
      
      // Şehir tablosunun altında boşluk bırak
      doc.moveDown(2);
    });
    
    // Sayfa altbilgisi
    doc.fontSize(8).fillColor(colors.secondary)
       .text(`Olusturulma Tarihi: ${moment().format('DD.MM.YYYY HH:mm')}`, 
             pageMargin, 
             doc.page.height - pageMargin - 10, 
             { align: 'center' });
    
    // PDF'i sonlandır
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
    const { cityId, weight, coordinator, chairman } = req.query;
    
    if (!cityId || !weight) {
      return res.status(400).json({ message: "Şehir ID ve kilo bilgisi gereklidir" });
    }
    
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
        path: "tournamentPlace.city",
        select: "name"
      });
    
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }
    
    // Tüm katılımcıları al (rol filtrelemesi olmadan)
    let participants = [...organisation.participants];
    
    // Eksik kulüp bilgilerini tamamla
    const Club = mongoose.model('Club'); // Kulüp modelini al
    const City = mongoose.model('City'); // Şehir modelini al
    
    // Tüm kulüpleri bir kerede getir
    const clubIds = participants
      .filter(p => p.athlete && p.athlete.club && typeof p.athlete.club === 'string')
      .map(p => p.athlete.club);
    
    let clubs = {};
    if (clubIds.length > 0) {
      const clubsData = await Club.find({ _id: { $in: clubIds } }).select('name');
      clubsData.forEach(club => {
        clubs[club._id.toString()] = club.name;
      });
    }
    
    // Şehir bilgisini al
    const city = await City.findById(cityId).select('name');
    if (!city) {
      return res.status(404).json({ message: "Şehir bulunamadı" });
    }
    
    // Belirtilen şehir ve kiloya göre katılımcıları filtrele
    const filteredParticipants = participants.filter(p => 
      p.athlete && 
      p.athlete.city && 
      p.athlete.city._id.toString() === cityId &&
      p.weight.toString() === weight.toString()
    );
    
    // Kulüp bilgilerini ekle
    filteredParticipants.forEach(participant => {
      if (participant.athlete.club) {
        if (typeof participant.athlete.club === 'string') {
          const clubId = participant.athlete.club;
          if (clubs[clubId]) {
            participant.athlete.clubName = clubs[clubId];
          }
        } else if (participant.athlete.club.name) {
          participant.athlete.clubName = participant.athlete.club.name;
        }
      }
    });
    
    // Renk tanımlamaları
    const colors = {
      primary: '#1e3a8a',      // Koyu mavi
      secondary: '#3b82f6',    // Açık mavi
      accent: '#f59e0b',       // Turuncu
      light: '#f3f4f6',        // Açık gri
      dark: '#1f2937',         // Koyu gri
      white: '#ffffff',        // Beyaz
      headerBg: '#e5e7eb',     // Başlık arkaplanı
      tableBorder: '#d1d5db',  // Tablo çizgileri
      tableRowAlt: '#f9fafb'   // Alternatif satır rengi
    };
    
    // PDF oluştur - Yatay (Landscape) format
    const doc = new PDFDocument({ 
      size: 'A4',
      layout: 'landscape', // Yatay format
      margin: 50,
      info: {
        Title: 'Tartı Listesi',
        Author: 'Türkiye Kuraş Federasyonu',
        Subject: organisation.tournamentName
      }
    });
    
    // PDF başlığını ayarla
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=weighing-list-${cityId}-${weight}.pdf`);
    
    // PDF'i response'a pipe et
    doc.pipe(res);
    
    // Türkçe karakterleri ASCII karşılıklarıyla değiştiren yardımcı fonksiyon
    function turkishToAscii(text) {
      if (!text) return ''; // text undefined veya null ise boş string döndür
      
      return text
        .replace(/ı/g, 'i')
        .replace(/İ/g, 'I')
        .replace(/ğ/g, 'g')
        .replace(/Ğ/g, 'G')
        .replace(/ü/g, 'u')
        .replace(/Ü/g, 'U')
        .replace(/ş/g, 's')
        .replace(/Ş/g, 'S')
        .replace(/ç/g, 'c')
        .replace(/Ç/g, 'C')
        .replace(/ö/g, 'o')
        .replace(/Ö/g, 'O');
    }
    
    // Sabit değerler
    const pageMargin = 50;
    const tableLeft = pageMargin;
    const tableWidth = doc.page.width - 2 * pageMargin;
    const colWidths = [
      Math.round(tableWidth * 0.05),  // # (5%)
      Math.round(tableWidth * 0.35),  // Ad Soyad (35%)
      Math.round(tableWidth * 0.25),  // Kulüp (25%)
      Math.round(tableWidth * 0.175), // Tartı (17.5%)
      Math.round(tableWidth * 0.175)  // İmza (17.5%)
    ];
    
    // Başlık çiz
    doc.rect(pageMargin, pageMargin, doc.page.width - 2 * pageMargin, 80)
       .fill(colors.light);
    
    doc.font('Times-Bold').fontSize(18).fillColor(colors.primary)
       .text('TURKIYE KURAS FEDERASYONU', pageMargin + 20, pageMargin + 15, { 
         width: doc.page.width - 2 * pageMargin - 40,
         align: 'center' 
       });
    
    doc.fontSize(16).fillColor(colors.dark)
       .text(turkishToAscii(organisation.tournamentName), pageMargin + 20, pageMargin + 40, { 
         width: doc.page.width - 2 * pageMargin - 40,
         align: 'center' 
       });
    
    // Turnuva tarihleri
    const startDate = moment(organisation.tournamentDate.startDate).format('DD.MM.YYYY');
    const endDate = organisation.tournamentDate.endDate ? 
      moment(organisation.tournamentDate.endDate).format('DD.MM.YYYY') : 
      startDate;
    
    doc.fontSize(12).fillColor(colors.secondary)
       .text(`${startDate} - ${endDate}`, pageMargin + 20, pageMargin + 60, { 
         width: doc.page.width - 2 * pageMargin - 40,
         align: 'center' 
       });
    
    // Tartı listesi başlığı
    doc.rect(pageMargin, pageMargin + 90, doc.page.width - 2 * pageMargin, 30)
       .fill(colors.primary);
    
    doc.font('Times-Bold').fontSize(14).fillColor(colors.white)
       .text('TARTI LISTESI', pageMargin + 10, pageMargin + 98, { 
         width: doc.page.width - 2 * pageMargin - 20,
         align: 'center' 
       });
    
    // Şehir ve kilo bilgisi
    doc.font('Times-Bold').fontSize(12).fillColor(colors.dark)
       .text(`${turkishToAscii(city.name)} - ${weight} kg`, pageMargin, pageMargin + 140, { 
         width: doc.page.width - 2 * pageMargin,
         align: 'center' 
       });
    
    // Tablo başlıkları
    let tableTop = pageMargin + 170;
    
    doc.rect(tableLeft, tableTop, colWidths.reduce((a, b) => a + b, 0), 25)
       .fill(colors.headerBg);
    
    doc.font('Times-Bold').fontSize(10).fillColor(colors.dark);
    doc.text('#', tableLeft + 10, tableTop + 8);
    doc.text('Ad Soyad', tableLeft + colWidths[0] + 10, tableTop + 8);
    doc.text('Kulüp', tableLeft + colWidths[0] + colWidths[1] + 10, tableTop + 8);
    doc.text('Tarti', tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + 10, tableTop + 8);
    doc.text('Imza', tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + 10, tableTop + 8);
    
    // Tablo dış çerçevesi
    doc.rect(tableLeft, tableTop, colWidths.reduce((a, b) => a + b, 0), 25)
       .lineWidth(1)
       .stroke(colors.tableBorder);
    
    // Tablo içeriği
    let rowY = tableTop + 25;
    let rowIsColored = false;
    
    // Her katılımcı için
    filteredParticipants.forEach((participant, index) => {
      // Alternatif satır renklendirme
      if (rowIsColored) {
        doc.rect(tableLeft, rowY, colWidths.reduce((a, b) => a + b, 0), 30)
           .fill(colors.tableRowAlt);
      }
      rowIsColored = !rowIsColored;
      
      // Satır içeriği
      doc.font('Times-Roman').fontSize(10).fillColor(colors.dark);
      doc.text((index + 1).toString(), tableLeft + 10, rowY + 10);
      doc.text(
        `${turkishToAscii(participant.athlete.name)} ${turkishToAscii(participant.athlete.surname)}`, 
        tableLeft + colWidths[0] + 10, 
        rowY + 10
      );
      doc.text(
        participant.athlete.clubName ? turkishToAscii(participant.athlete.clubName) : '-',
        tableLeft + colWidths[0] + colWidths[1] + 10, 
        rowY + 10
      );
      
      // Tartı ve İmza alanları boş bırakılır
      
      // Satır çizgisi
      doc.rect(tableLeft, rowY, colWidths.reduce((a, b) => a + b, 0), 30)
         .lineWidth(0.5)
         .stroke(colors.tableBorder);
      
      // Sütun çizgileri
      let x = tableLeft;
      for (let i = 0; i < colWidths.length - 1; i++) {
        x += colWidths[i];
        doc.moveTo(x, rowY)
           .lineTo(x, rowY + 30)
           .lineWidth(0.5)
           .stroke(colors.tableBorder);
      }
      
      rowY += 30;
    });
    
    // İmza alanları
    doc.moveDown(4);
    let signatureY = rowY + 50;
    
    // İmza çizgileri
    const signatureWidth = 200;
    const signatureGap = (doc.page.width - 2 * pageMargin - 2 * signatureWidth) / 3;
    
    // Sol imza (Koordinatör)
    doc.font('Times-Bold').fontSize(10).fillColor(colors.dark);
    doc.text('Koordinatör', 
             pageMargin + signatureGap, 
             signatureY, 
             { width: signatureWidth, align: 'center' });
    
    doc.moveTo(pageMargin + signatureGap, signatureY + 30)
       .lineTo(pageMargin + signatureGap + signatureWidth, signatureY + 30)
       .lineWidth(0.5)
       .stroke(colors.dark);
    
    doc.text(coordinator || '', 
             pageMargin + signatureGap, 
             signatureY + 40, 
             { width: signatureWidth, align: 'center' });
    
    // Sağ imza (Kurul Başkanı)
    doc.text('Kurul Baskani', 
             pageMargin + 2 * signatureGap + signatureWidth, 
             signatureY, 
             { width: signatureWidth, align: 'center' });
    
    doc.moveTo(pageMargin + 2 * signatureGap + signatureWidth, signatureY + 30)
       .lineTo(pageMargin + 2 * signatureGap + 2 * signatureWidth, signatureY + 30)
       .lineWidth(0.5)
       .stroke(colors.dark);
    
    doc.text(chairman || '', 
             pageMargin + 2 * signatureGap + signatureWidth, 
             signatureY + 40, 
             { width: signatureWidth, align: 'center' });
    
    // Sayfa altbilgisi
    doc.fontSize(8).fillColor(colors.secondary)
       .text(`Olusturulma Tarihi: ${moment().format('DD.MM.YYYY HH:mm')}`, 
             pageMargin, 
             doc.page.height - pageMargin - 10, 
             { align: 'center' });
    
    // PDF'i sonlandır
    doc.end();
    
  } catch (error) {
    console.error("Tartı listesi oluşturma hatası:", error);
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