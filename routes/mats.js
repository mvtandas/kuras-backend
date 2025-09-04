const express = require("express");
const router = express.Router();
const Mat = require("../models/mat");
const MatAssignment = require("../models/matAssignment");
const TournamentMatch = require("../models/tournamentMatch");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const auth = require("../middleware/auth");

// Organizasyon için minderleri listele
router.get("/organisation/:organisationId", auth, async (req, res) => {
  try {
    const { organisationId } = req.params;
    
    // Organizasyonun varlığını kontrol et
    const organisation = await Organisation.findById(organisationId);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    const mats = await Mat.find({ organisationId })
      .sort({ order: 1, createdAt: 1 });

    res.json(mats);
  } catch (error) {
    console.error("Minderler listeleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Yeni minder oluştur
router.post("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar minder oluşturabilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { organisationId, name, description, order } = req.body;

    // Zorunlu alan kontrolü
    if (!organisationId || !name) {
      return res.status(400).json({ message: "Organizasyon ID ve minder adı gereklidir" });
    }

    // Organizasyonun varlığını kontrol et
    const organisation = await Organisation.findById(organisationId);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    const mat = new Mat({
      organisationId,
      name: name.trim(),
      description: description || '',
      order: order || 0
    });

    await mat.save();
    res.status(201).json(mat);
  } catch (error) {
    console.error("Minder oluşturma hatası:", error);
    if (error.code === 11000) {
      return res.status(400).json({ message: "Bu organizasyonda aynı isimde bir minder zaten mevcut" });
    }
    res.status(500).json({ message: error.message });
  }
});

// Minder güncelle
router.put("/:id", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar minder güncelleyebilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id } = req.params;
    const { name, description, isActive, order } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (order !== undefined) updateData.order = order;

    const mat = await Mat.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!mat) {
      return res.status(404).json({ message: "Minder bulunamadı" });
    }

    res.json(mat);
  } catch (error) {
    console.error("Minder güncelleme hatası:", error);
    if (error.code === 11000) {
      return res.status(400).json({ message: "Bu organizasyonda aynı isimde bir minder zaten mevcut" });
    }
    res.status(500).json({ message: error.message });
  }
});

// Minder sil
router.delete("/:id", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin silebilir
    if (user.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id } = req.params;

    // Minderin aktif atamasının olup olmadığını kontrol et
    const activeAssignments = await MatAssignment.countDocuments({
      matId: id,
      status: { $in: ['assigned', 'in_progress'] }
    });

    if (activeAssignments > 0) {
      return res.status(400).json({ 
        message: "Bu minderin aktif atamalar mevcut. Önce atamaları iptal edin." 
      });
    }

    const deletedMat = await Mat.findByIdAndDelete(id);

    if (!deletedMat) {
      return res.status(404).json({ message: "Minder bulunamadı" });
    }

    // İlgili tüm atamaları da sil
    await MatAssignment.deleteMany({ matId: id });

    res.status(200).json({ message: "Minder başarıyla silindi" });
  } catch (error) {
    console.error("Minder silme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Belirli bir minderi getir
router.get("/:id", auth, async (req, res) => {
  try {
    const mat = await Mat.findById(req.params.id)
      .populate('organisationId', 'tournamentName tournamentDate');

    if (!mat) {
      return res.status(404).json({ message: "Minder bulunamadı" });
    }

    res.json(mat);
  } catch (error) {
    console.error("Minder getirme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Minderin detaylı bilgilerini ve atamalarını getir
router.get("/:id/details", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      status,
      date,
      weightCategory,
      gender,
      roundNumber,
      tournamentType,
      search,
      sortBy = 'scheduledTime',
      sortOrder = 'asc',
      page = 1,
      limit = 50
    } = req.query;

    // Minder kontrolü
    const mat = await Mat.findById(id)
      .populate('organisationId', 'tournamentName tournamentDate tournamentPlace');

    if (!mat) {
      return res.status(404).json({ message: "Minder bulunamadı" });
    }

    // Filtre oluştur
    const filter = { matId: id };
    if (status) filter.status = status;
    if (weightCategory) filter['matchDetails.weightCategory'] = weightCategory;
    if (gender) filter['matchDetails.gender'] = gender;
    if (roundNumber) filter['matchDetails.roundNumber'] = parseInt(roundNumber);
    if (tournamentType) filter['matchDetails.tournamentType'] = tournamentType;
    
    // Tarih filtresi
    if (date) {
      const targetDate = new Date(date);
      const nextDay = new Date(targetDate);
      nextDay.setDate(nextDay.getDate() + 1);
      
      filter.scheduledTime = {
        $gte: targetDate,
        $lt: nextDay
      };
    }

    // Tüm atamaları al (sayfalama öncesi)
    let assignments = await MatAssignment.find(filter)
      .populate('matId', 'name order')
      .populate('tournamentMatchId', 'weightCategory gender tournamentType')
      .populate('assignedBy', 'name surname');

    // Her assignment için maç detaylarını al
    for (let assignment of assignments) {
      try {
        const tournamentMatch = await TournamentMatch.findById(assignment.tournamentMatchId._id);
        if (tournamentMatch) {
          let matchDetails = null;
          
          // Maç tipine göre maçı bul
          if (tournamentMatch.tournamentType === 'round_robin') {
            // Round robin maçını bul
            for (let round of tournamentMatch.rounds) {
              const match = round.matches.find(m => m.matchId === assignment.matchIdentifier.roundRobinMatchId);
              if (match) {
                matchDetails = match;
                break;
              }
            }
          } else {
            // Elimination maçını bul
            if (assignment.matchIdentifier.isLoserBracket) {
              matchDetails = tournamentMatch.loserBrackets.find(m => m.matchNumber === assignment.matchIdentifier.eliminationMatchNumber);
            } else {
              matchDetails = tournamentMatch.brackets.find(m => m.matchNumber === assignment.matchIdentifier.eliminationMatchNumber);
            }
          }
          
          // Maç detaylarını assignment'a ekle
          if (matchDetails) {
            assignment.matchDetails = {
              ...assignment.matchDetails,
              // Mevcut bilgileri koru
              weightCategory: assignment.matchDetails.weightCategory,
              gender: assignment.matchDetails.gender,
              roundNumber: assignment.matchDetails.roundNumber,
              tournamentType: assignment.matchDetails.tournamentType,
              player1Name: assignment.matchDetails.player1Name,
              player2Name: assignment.matchDetails.player2Name,
              // Yeni maç bilgilerini ekle
              matchStatus: matchDetails.status || 'scheduled',
              matchWinner: matchDetails.winner || null,
              matchScore: matchDetails.score || { player1Score: 0, player2Score: 0 },
              matchCompletedAt: matchDetails.completedAt || null,
              matchNotes: matchDetails.notes || '',
              isByeMatch: !matchDetails.player1 || !matchDetails.player2,
              displayNumber: matchDetails.displayNumber || matchDetails.matchNumber
            };
            
            // Assignment status'unu maç durumuna göre güncelle
            if (matchDetails.status === 'completed' && assignment.status !== 'completed') {
              assignment.status = 'completed';
              assignment.completedAt = matchDetails.completedAt || new Date();
              await assignment.save();
            } else if (matchDetails.status === 'in_progress' && assignment.status !== 'in_progress') {
              assignment.status = 'in_progress';
              assignment.startedAt = new Date();
              await assignment.save();
            } else if (matchDetails.status === 'scheduled' && assignment.status === 'completed') {
              assignment.status = 'assigned';
              assignment.completedAt = null;
              assignment.startedAt = null;
              await assignment.save();
            }
          }
        }
      } catch (error) {
        console.error(`Assignment ${assignment._id} için maç detayları alınırken hata:`, error);
      }
    }

    // Arama filtresi (oyuncu isimlerine göre)
    if (search && search.trim()) {
      const searchTerm = search.trim().toLowerCase();
      assignments = assignments.filter(assignment => 
        assignment.matchDetails.player1Name.toLowerCase().includes(searchTerm) ||
        assignment.matchDetails.player2Name.toLowerCase().includes(searchTerm)
      );
    }

    // Sıralama
    assignments.sort((a, b) => {
      let aValue, bValue;
      
      switch (sortBy) {
        case 'scheduledTime':
          aValue = a.scheduledTime || new Date(0);
          bValue = b.scheduledTime || new Date(0);
          break;
        case 'roundNumber':
          aValue = a.matchDetails.roundNumber;
          bValue = b.matchDetails.roundNumber;
          break;
        case 'weightCategory':
          aValue = a.matchDetails.weightCategory;
          bValue = b.matchDetails.weightCategory;
          break;
        case 'gender':
          aValue = a.matchDetails.gender;
          bValue = b.matchDetails.gender;
          break;
        case 'status':
          aValue = a.status;
          bValue = b.status;
          break;
        case 'createdAt':
          aValue = a.createdAt;
          bValue = b.createdAt;
          break;
        case 'players':
          aValue = `${a.matchDetails.player1Name} vs ${a.matchDetails.player2Name}`;
          bValue = `${b.matchDetails.player1Name} vs ${b.matchDetails.player2Name}`;
          break;
        default:
          aValue = a.createdAt;
          bValue = b.createdAt;
      }
      
      if (aValue instanceof Date && bValue instanceof Date) {
        const comparison = aValue.getTime() - bValue.getTime();
        return sortOrder === 'desc' ? -comparison : comparison;
      } else if (typeof aValue === 'string' && typeof bValue === 'string') {
        const comparison = aValue.localeCompare(bValue);
        return sortOrder === 'desc' ? -comparison : comparison;
      } else {
        const comparison = aValue - bValue;
        return sortOrder === 'desc' ? -comparison : comparison;
      }
    });

    // İstatistikler hesapla
    const stats = {
      totalAssignments: assignments.length,
      byStatus: {},
      byRound: {},
      byCategory: {},
      byGender: {},
      byTournamentType: {},
      upcomingMatches: 0,
      completedToday: 0
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    assignments.forEach(assignment => {
      // Status istatistikleri
      stats.byStatus[assignment.status] = (stats.byStatus[assignment.status] || 0) + 1;
      
      // Round istatistikleri
      const roundKey = `Round ${assignment.matchDetails.roundNumber}`;
      stats.byRound[roundKey] = (stats.byRound[roundKey] || 0) + 1;
      
      // Kategori istatistikleri
      stats.byCategory[assignment.matchDetails.weightCategory] = 
        (stats.byCategory[assignment.matchDetails.weightCategory] || 0) + 1;
      
      // Cinsiyet istatistikleri
      stats.byGender[assignment.matchDetails.gender] = 
        (stats.byGender[assignment.matchDetails.gender] || 0) + 1;
      
      // Turnuva tipi istatistikleri
      stats.byTournamentType[assignment.matchDetails.tournamentType] = 
        (stats.byTournamentType[assignment.matchDetails.tournamentType] || 0) + 1;

      // Yaklaşan maçlar
      if (assignment.status === 'assigned' && assignment.scheduledTime && assignment.scheduledTime >= today) {
        stats.upcomingMatches++;
      }

      // Bugün tamamlanan maçlar
      if (assignment.status === 'completed' && assignment.completedAt && 
          assignment.completedAt >= today && assignment.completedAt < tomorrow) {
        stats.completedToday++;
      }
    });

    // Sayfalama
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;
    
    const paginatedAssignments = assignments.slice(startIndex, endIndex);

    // Benzersiz değerleri al (filtreleme seçenekleri için)
    const availableFilters = {
      weightCategories: [...new Set(assignments.map(a => a.matchDetails.weightCategory))].sort(),
      genders: [...new Set(assignments.map(a => a.matchDetails.gender))].sort(),
      rounds: [...new Set(assignments.map(a => a.matchDetails.roundNumber))].sort((a, b) => a - b),
      tournamentTypes: [...new Set(assignments.map(a => a.matchDetails.tournamentType))].sort(),
      statuses: [...new Set(assignments.map(a => a.status))].sort()
    };

    res.json({
      mat: {
        _id: mat._id,
        name: mat.name,
        description: mat.description,
        isActive: mat.isActive,
        order: mat.order,
        organisation: mat.organisationId
      },
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(assignments.length / limitNum),
        totalItems: assignments.length,
        itemsPerPage: limitNum,
        hasNextPage: endIndex < assignments.length,
        hasPrevPage: pageNum > 1
      },
      filters: {
        applied: {
          status,
          date,
          weightCategory,
          gender,
          roundNumber,
          tournamentType,
          search,
          sortBy,
          sortOrder
        },
        available: availableFilters
      },
      stats,
      assignments: paginatedAssignments
    });
  } catch (error) {
    console.error("Minder detayları getirme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Minderin mevcut atamalarını listele (basit versiyon - geriye uyumluluk için)
router.get("/:id/assignments", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, date } = req.query;

    const filter = { matId: id };
    if (status) filter.status = status;
    
    // Belirli bir tarihteki atamaları filtrele
    if (date) {
      const targetDate = new Date(date);
      const nextDay = new Date(targetDate);
      nextDay.setDate(nextDay.getDate() + 1);
      
      filter.scheduledTime = {
        $gte: targetDate,
        $lt: nextDay
      };
    }

    const assignments = await MatAssignment.find(filter)
      .populate('matId', 'name')
      .populate('tournamentMatchId', 'weightCategory gender tournamentType')
      .populate('assignedBy', 'name surname')
      .sort({ scheduledTime: 1, createdAt: -1 });

    res.json(assignments);
  } catch (error) {
    console.error("Minder atamaları listeleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Organizasyon için otomatik minder oluşturma
router.post("/organisation/:organisationId/auto-create", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar otomatik minder oluşturabilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { organisationId } = req.params;
    const { count, matCount } = req.body;
    
    // matCount veya count parametresini kullan, default 2
    const finalCount = matCount || count || 2;

    // Organizasyonun varlığını kontrol et
    const organisation = await Organisation.findById(organisationId);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    // Mevcut minderleri kontrol et
    const existingMats = await Mat.find({ organisationId });
    if (existingMats.length > 0) {
      return res.status(400).json({ 
        message: "Bu organizasyon için zaten minderler mevcut" 
      });
    }

    const mats = [];
    for (let i = 1; i <= finalCount; i++) {
      const mat = new Mat({
        organisationId,
        name: `Minder ${i}`,
        description: `Otomatik oluşturulan minder ${i}`,
        order: i
      });
      await mat.save();
      mats.push(mat);
    }

    res.status(201).json({
      message: `${finalCount} adet minder başarıyla oluşturuldu`,
      mats
    });
  } catch (error) {
    console.error("Otomatik minder oluşturma hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
