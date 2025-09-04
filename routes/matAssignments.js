const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const MatAssignment = require("../models/matAssignment");
const Mat = require("../models/mat");
const TournamentMatch = require("../models/tournamentMatch");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const auth = require("../middleware/auth");

// Organizasyon için tüm minder atamalarını listele
router.get("/organisation/:organisationId", auth, async (req, res) => {
  try {
    const { organisationId } = req.params;
    const { status, date, matId } = req.query;

    const filter = { organisationId };
    if (status) filter.status = status;
    if (matId) filter.matId = matId;
    
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
      .populate('matId', 'name order')
      .populate('tournamentMatchId', 'weightCategory gender tournamentType')
      .populate('assignedBy', 'name surname')
      .sort({ 'matId.order': 1, scheduledTime: 1, createdAt: -1 });

    res.json(assignments);
  } catch (error) {
    console.error("Minder atamaları listeleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Manuel minder atama
router.post("/manual", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar manuel atama yapabilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { 
      matId, 
      tournamentMatchId, 
      matchIdentifier, 
      scheduledTime, 
      notes 
    } = req.body;

    // Zorunlu alan kontrolü
    if (!matId || !tournamentMatchId || !matchIdentifier) {
      return res.status(400).json({ 
        message: "Minder ID, Turnuva Maçı ID ve Maç Tanımlayıcısı gereklidir" 
      });
    }

    // Minder kontrolü
    const mat = await Mat.findById(matId);
    if (!mat) {
      return res.status(404).json({ message: "Minder bulunamadı" });
    }

    if (!mat.isActive) {
      return res.status(400).json({ message: "Minder aktif değil" });
    }

    // Turnuva maçı kontrolü
    const tournamentMatch = await TournamentMatch.findById(tournamentMatchId);
    if (!tournamentMatch) {
      return res.status(404).json({ message: "Turnuva maçı bulunamadı" });
    }

    // Maç detaylarını al
    const matchDetails = await getMatchDetails(tournamentMatch, matchIdentifier);
    if (!matchDetails) {
      return res.status(404).json({ message: "Belirtilen maç bulunamadı" });
    }

    // Mevcut atama kontrolü - daha spesifik sorgu
    let existingAssignmentQuery;
    if (matchIdentifier.roundRobinMatchId) {
      existingAssignmentQuery = {
        tournamentMatchId,
        'matchIdentifier.roundRobinMatchId': matchIdentifier.roundRobinMatchId
      };
    } else {
      existingAssignmentQuery = {
        tournamentMatchId,
        'matchIdentifier.eliminationMatchNumber': matchIdentifier.eliminationMatchNumber,
        'matchIdentifier.isLoserBracket': matchIdentifier.isLoserBracket === true || matchIdentifier.isLoserBracket === 'true'
      };
    }

    const existingAssignment = await MatAssignment.findOne(existingAssignmentQuery)
      .populate('matId', 'name');

    if (existingAssignment) {
      return res.status(400).json({ 
        message: `Bu maç zaten "${existingAssignment.matId.name}" minderine atanmış`,
        currentAssignment: {
          matId: existingAssignment.matId._id,
          matName: existingAssignment.matId.name,
          assignedAt: existingAssignment.createdAt,
          status: existingAssignment.status
        }
      });
    }

    // Zaman çakışması kontrolü (eğer scheduledTime verilmişse)
    if (scheduledTime) {
      const timeConflict = await MatAssignment.findOne({
        matId,
        scheduledTime: new Date(scheduledTime),
        status: { $in: ['assigned', 'in_progress'] }
      });

      if (timeConflict) {
        return res.status(400).json({ 
          message: "Bu zamanda minder zaten başka bir maça atanmış" 
        });
      }
    }

    const assignment = new MatAssignment({
      matId,
      organisationId: mat.organisationId,
      tournamentMatchId,
      matchIdentifier,
      matchDetails: {
        weightCategory: tournamentMatch.weightCategory,
        gender: tournamentMatch.gender,
        roundNumber: matchDetails.roundNumber,
        tournamentType: tournamentMatch.tournamentType,
        player1Name: matchDetails.player1Name,
        player2Name: matchDetails.player2Name
      },
      assignedBy: req.user.id,
      assignmentType: 'manual',
      scheduledTime: scheduledTime ? new Date(scheduledTime) : null,
      notes: notes || ''
    });

    await assignment.save();

    // Populate edilerek döndür
    const populatedAssignment = await MatAssignment.findById(assignment._id)
      .populate('matId', 'name order')
      .populate('tournamentMatchId', 'weightCategory gender tournamentType')
      .populate('assignedBy', 'name surname');

    res.status(201).json(populatedAssignment);
  } catch (error) {
    console.error("Manuel minder atama hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Otomatik minder atama
router.post("/auto-assign", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar otomatik atama yapabilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { 
      organisationId, 
      filters = {}, 
      assignmentStrategy = 'round_robin' // 'round_robin' | 'sequential' | 'balanced'
    } = req.body;

    if (!organisationId) {
      return res.status(400).json({ message: "Organizasyon ID gereklidir" });
    }

    // Organizasyon kontrolü
    const organisation = await Organisation.findById(organisationId);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    // Aktif minderleri al
    const mats = await Mat.find({ 
      organisationId, 
      isActive: true 
    }).sort({ order: 1 });

    if (mats.length === 0) {
      return res.status(400).json({ message: "Aktif minder bulunamadı" });
    }

    // Atanmamış maçları al
    const unassignedMatches = await getUnassignedMatches(organisationId, filters);

    if (unassignedMatches.length === 0) {
      return res.status(200).json({ 
        message: "Atanacak maç bulunamadı",
        assignments: []
      });
    }

    // Otomatik atama yap
    const assignments = await performAutoAssignment(
      unassignedMatches, 
      mats, 
      req.user.id, 
      assignmentStrategy
    );

    res.status(201).json({
      message: `${assignments.length} maç başarıyla atandı`,
      assignments
    });
  } catch (error) {
    console.error("Otomatik minder atama hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Atanmamış maçları listele
router.get("/unassigned/:organisationId", auth, async (req, res) => {
  try {
    const { organisationId } = req.params;
    const { 
      weightCategory, 
      gender, 
      roundNumber, 
      tournamentType,
      isLoserBracket,
      status,
      search,
      sortBy = 'roundNumber',
      sortOrder = 'asc',
      page = 1,
      limit = 50
    } = req.query;

    // Organizasyon kontrolü
    const organisation = await Organisation.findById(organisationId);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    // Temel filtreler
    const filters = {};
    if (weightCategory) filters.weightCategory = weightCategory;
    if (gender) filters.gender = gender;
    if (roundNumber) filters.roundNumber = parseInt(roundNumber);
    if (tournamentType) filters.tournamentType = tournamentType;
    if (isLoserBracket !== undefined) filters.isLoserBracket = isLoserBracket === 'true';
    if (status) filters.status = status;

    // Atanmamış maçları al
    let unassignedMatches = await getUnassignedMatches(organisationId, filters);

    // Arama filtresi (oyuncu isimlerine göre)
    if (search && search.trim()) {
      const searchTerm = search.trim().toLowerCase();
      unassignedMatches = unassignedMatches.filter(match => 
        match.matchDetails.player1Name.toLowerCase().includes(searchTerm) ||
        match.matchDetails.player2Name.toLowerCase().includes(searchTerm)
      );
    }

    // Sıralama
    unassignedMatches.sort((a, b) => {
      let aValue, bValue;
      
      switch (sortBy) {
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
        case 'tournamentType':
          aValue = a.matchDetails.tournamentType;
          bValue = b.matchDetails.tournamentType;
          break;
        case 'players':
          aValue = `${a.matchDetails.player1Name} vs ${a.matchDetails.player2Name}`;
          bValue = `${b.matchDetails.player1Name} vs ${b.matchDetails.player2Name}`;
          break;
        case 'status':
          aValue = a.matchDetails.status;
          bValue = b.matchDetails.status;
          break;
        default:
          aValue = a.matchDetails.roundNumber;
          bValue = b.matchDetails.roundNumber;
      }
      
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        const comparison = aValue.localeCompare(bValue);
        return sortOrder === 'desc' ? -comparison : comparison;
      } else {
        const comparison = aValue - bValue;
        return sortOrder === 'desc' ? -comparison : comparison;
      }
    });

    // Sayfalama
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit))); // Max 100, min 1
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;
    
    const paginatedMatches = unassignedMatches.slice(startIndex, endIndex);

    // İstatistikler
    const stats = {
      totalMatches: unassignedMatches.length,
      byRound: {},
      byCategory: {},
      byGender: {},
      byTournamentType: {},
      byStatus: {}
    };

    unassignedMatches.forEach(match => {
      const details = match.matchDetails;
      
      // Round istatistikleri
      const roundKey = `Round ${details.roundNumber}${details.isLoserBracket ? ' (Loser)' : ''}`;
      stats.byRound[roundKey] = (stats.byRound[roundKey] || 0) + 1;
      
      // Kategori istatistikleri
      stats.byCategory[details.weightCategory] = (stats.byCategory[details.weightCategory] || 0) + 1;
      
      // Cinsiyet istatistikleri
      stats.byGender[details.gender] = (stats.byGender[details.gender] || 0) + 1;
      
      // Turnuva tipi istatistikleri
      stats.byTournamentType[details.tournamentType] = (stats.byTournamentType[details.tournamentType] || 0) + 1;
      
      // Durum istatistikleri
      stats.byStatus[details.status] = (stats.byStatus[details.status] || 0) + 1;
    });

    // Benzersiz değerleri al (filtreleme seçenekleri için)
    const availableFilters = {
      weightCategories: [...new Set(unassignedMatches.map(m => m.matchDetails.weightCategory))].sort(),
      genders: [...new Set(unassignedMatches.map(m => m.matchDetails.gender))].sort(),
      rounds: [...new Set(unassignedMatches.map(m => m.matchDetails.roundNumber))].sort((a, b) => a - b),
      tournamentTypes: [...new Set(unassignedMatches.map(m => m.matchDetails.tournamentType))].sort(),
      statuses: [...new Set(unassignedMatches.map(m => m.matchDetails.status))].sort()
    };

    res.json({
      organisationName: organisation.tournamentName,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(unassignedMatches.length / limitNum),
        totalItems: unassignedMatches.length,
        itemsPerPage: limitNum,
        hasNextPage: endIndex < unassignedMatches.length,
        hasPrevPage: pageNum > 1
      },
      filters: {
        applied: {
          weightCategory,
          gender,
          roundNumber,
          tournamentType,
          isLoserBracket,
          status,
          search,
          sortBy,
          sortOrder
        },
        available: availableFilters
      },
      stats,
      matches: paginatedMatches
    });
  } catch (error) {
    console.error("Atanmamış maçları listeleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Minder atamasını güncelle
router.put("/:id", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar atama güncelleyebilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id } = req.params;
    const { status, scheduledTime, startedAt, completedAt, notes } = req.body;

    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (scheduledTime !== undefined) updateData.scheduledTime = scheduledTime ? new Date(scheduledTime) : null;
    if (startedAt !== undefined) updateData.startedAt = startedAt ? new Date(startedAt) : null;
    if (completedAt !== undefined) updateData.completedAt = completedAt ? new Date(completedAt) : null;
    if (notes !== undefined) updateData.notes = notes;

    // Status değişikliklerine göre otomatik zaman ayarları
    if (status === 'in_progress' && !startedAt) {
      updateData.startedAt = new Date();
    }
    if (status === 'completed' && !completedAt) {
      updateData.completedAt = new Date();
    }

    const assignment = await MatAssignment.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate('matId', 'name order')
     .populate('tournamentMatchId', 'weightCategory gender tournamentType')
     .populate('assignedBy', 'name surname');

    if (!assignment) {
      return res.status(404).json({ message: "Minder ataması bulunamadı" });
    }

    res.json(assignment);
  } catch (error) {
    console.error("Minder ataması güncelleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});


// Organizasyon için round'ları listele
router.get("/rounds/:organisationId", auth, async (req, res) => {
  try {
    const { organisationId } = req.params;
    const { weightCategory, gender, tournamentType } = req.query;

    // Organizasyon kontrolü
    const organisation = await Organisation.findById(organisationId);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    const rounds = await getRoundsWithMatchCounts(organisationId, {
      weightCategory,
      gender,
      tournamentType
    });

    res.json(rounds);
  } catch (error) {
    console.error("Round'ları listeleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Round bazında toplu minder atama (tek veya çoklu round)
router.post("/assign-round", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar toplu atama yapabilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { 
      organisationId, 
      matId, 
      roundNumber,
      roundNumbers, // Yeni: Birden fazla round için array
      weightCategory,
      gender,
      tournamentType,
      isLoserBracket
    } = req.body;

    // Zorunlu alan kontrolü
    if (!organisationId || !matId) {
      return res.status(400).json({ 
        message: "Organizasyon ID ve Minder ID gereklidir" 
      });
    }

    // Round numaralarını belirle - tek veya çoklu
    let targetRounds = [];
    if (roundNumbers && Array.isArray(roundNumbers) && roundNumbers.length > 0) {
      targetRounds = roundNumbers.filter(r => typeof r === 'number' && r > 0);
    } else if (roundNumber !== undefined) {
      targetRounds = [roundNumber];
    }

    if (targetRounds.length === 0) {
      return res.status(400).json({ 
        message: "En az bir round numarası gereklidir (roundNumber veya roundNumbers)" 
      });
    }

    // Minder kontrolü
    const mat = await Mat.findById(matId);
    if (!mat) {
      return res.status(404).json({ message: "Minder bulunamadı" });
    }

    if (!mat.isActive) {
      return res.status(400).json({ message: "Minder aktif değil" });
    }

    // Tüm round'lardaki maçları al
    let allRoundMatches = [];
    const roundResults = {};

    for (const round of targetRounds) {
      const roundMatches = await getRoundMatches(organisationId, {
        roundNumber: round,
        weightCategory,
        gender,
        tournamentType,
        isLoserBracket: isLoserBracket === true || isLoserBracket === 'true'
      });
      
      roundResults[round] = {
        found: roundMatches.length,
        matches: roundMatches
      };
      
      allRoundMatches = allRoundMatches.concat(roundMatches);
    }

    if (allRoundMatches.length === 0) {
      return res.status(404).json({ 
        message: "Belirtilen kriterlere uygun maç bulunamadı",
        roundResults
      });
    }

    // Mevcut atamaları toplu olarak kontrol et (performans ve tutarlılık için)
    const matchIdentifiers = allRoundMatches.map(match => {
      if (match.matchIdentifier.roundRobinMatchId) {
        return {
          tournamentMatchId: match.tournamentMatchId,
          'matchIdentifier.roundRobinMatchId': match.matchIdentifier.roundRobinMatchId
        };
      } else {
        return {
          tournamentMatchId: match.tournamentMatchId,
          'matchIdentifier.eliminationMatchNumber': match.matchIdentifier.eliminationMatchNumber,
          'matchIdentifier.isLoserBracket': match.matchIdentifier.isLoserBracket || false
        };
      }
    });

    // Tüm mevcut atamaları tek sorguda al
    const existingAssignments = await MatAssignment.find({
      $or: matchIdentifiers
    }).populate('matId', 'name');

    // Mevcut atamaları map'e çevir
    const existingAssignmentsMap = new Map();
    existingAssignments.forEach(assignment => {
      const key = assignment.matchIdentifier.roundRobinMatchId || 
                  `${assignment.matchIdentifier.eliminationMatchNumber}_${assignment.matchIdentifier.isLoserBracket}`;
      existingAssignmentsMap.set(key, assignment);
    });

    const conflictingMatches = [];
    const assignments = [];

    for (const match of allRoundMatches) {
      // Map'den mevcut atamayı kontrol et
      const matchKey = match.matchIdentifier.roundRobinMatchId || 
                      `${match.matchIdentifier.eliminationMatchNumber}_${match.matchIdentifier.isLoserBracket || false}`;
      
      const existingAssignment = existingAssignmentsMap.get(matchKey);

      if (existingAssignment) {
        conflictingMatches.push({
          matchId: match.matchIdentifier.roundRobinMatchId || match.matchIdentifier.eliminationMatchNumber,
          player1: match.matchDetails.player1Name,
          player2: match.matchDetails.player2Name,
          currentMat: existingAssignment.matId._id,
          currentMatName: existingAssignment.matId.name
        });
        continue;
      }

      // Yeni atama oluştur
      const assignment = new MatAssignment({
        matId,
        organisationId: mat.organisationId,
        tournamentMatchId: match.tournamentMatchId,
        matchIdentifier: match.matchIdentifier,
        matchDetails: match.matchDetails,
        assignedBy: req.user.id,
        assignmentType: 'manual',
        notes: targetRounds.length > 1 ? 
          `Round ${targetRounds.join(', ')} toplu atama` : 
          `Round ${targetRounds[0]} toplu atama`
      });

      await assignment.save();
      
      const populatedAssignment = await MatAssignment.findById(assignment._id)
        .populate('matId', 'name order')
        .populate('tournamentMatchId', 'weightCategory gender tournamentType')
        .populate('assignedBy', 'name surname');
        
      assignments.push(populatedAssignment);
    }

    // Round başına sonuçları hesapla
    const assignmentsByRound = {};
    const conflictsByRound = {};

    targetRounds.forEach(round => {
      assignmentsByRound[round] = assignments.filter(a => a.matchDetails.roundNumber === round).length;
      conflictsByRound[round] = conflictingMatches.filter(c => {
        // Match'in round numarasını bul
        const matchInRound = allRoundMatches.find(m => 
          (m.matchIdentifier.roundRobinMatchId === c.matchId) ||
          (m.matchIdentifier.eliminationMatchNumber === c.matchId)
        );
        return matchInRound && matchInRound.matchDetails.roundNumber === round;
      }).length;
    });

    const roundsText = targetRounds.length > 1 ? 
      `Round ${targetRounds.join(', ')}` : 
      `Round ${targetRounds[0]}`;

    const response = {
      message: `${roundsText} - ${assignments.length} maç başarıyla atandı`,
      assignments,
      totalMatches: allRoundMatches.length,
      assignedCount: assignments.length,
      conflictCount: conflictingMatches.length,
      roundResults: {
        processed: targetRounds,
        summary: targetRounds.map(round => ({
          round,
          totalFound: roundResults[round].found,
          assigned: assignmentsByRound[round] || 0,
          conflicts: conflictsByRound[round] || 0
        }))
      }
    };

    if (conflictingMatches.length > 0) {
      response.conflicts = conflictingMatches;
      response.message += `. ${conflictingMatches.length} maç zaten atanmış durumda.`;
    }

    res.status(201).json(response);
  } catch (error) {
    console.error("Round bazında toplu atama hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Tüm atamaları sıfırla (organizasyon bazında)
router.delete("/reset-all/:organisationId", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin tüm atamaları sıfırlayabilir
    if (user.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok - Sadece Admin tüm atamaları sıfırlayabilir" });
    }

    const { organisationId } = req.params;
    const { confirmationCode } = req.body;

    // Organizasyon kontrolü
    const organisation = await Organisation.findById(organisationId);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    // Güvenlik için confirmation code kontrolü (opsiyonel)
    const expectedCode = `RESET_${organisationId.slice(-6).toUpperCase()}`;
    if (confirmationCode && confirmationCode !== expectedCode) {
      return res.status(400).json({ 
        message: "Geçersiz onay kodu",
        expectedCode: expectedCode
      });
    }

    // Devam eden maçları kontrol et
    const activeAssignments = await MatAssignment.find({
      organisationId,
      status: 'in_progress'
    }).populate('matId', 'name');

    if (activeAssignments.length > 0) {
      const activeMatNames = activeAssignments.map(a => a.matId.name).join(', ');
      return res.status(400).json({ 
        message: `${activeAssignments.length} maç devam ediyor. Önce bu maçları tamamlayın.`,
        activeMats: activeMatNames,
        activeAssignments: activeAssignments.length
      });
    }

    // Mevcut atamaları say
    const totalAssignments = await MatAssignment.countDocuments({ organisationId });
    
    if (totalAssignments === 0) {
      return res.status(200).json({ 
        message: "Zaten hiç atama bulunmuyor",
        deletedCount: 0
      });
    }

    // Tüm atamaları sil
    const deleteResult = await MatAssignment.deleteMany({ organisationId });

    // Log kaydı oluştur
    console.log(`[RESET_ALL_ASSIGNMENTS] User: ${user._id} (${user.name} ${user.surname}) - Organisation: ${organisationId} - Deleted: ${deleteResult.deletedCount} assignments`);

    res.status(200).json({
      message: `Tüm atamalar başarıyla sıfırlandı`,
      deletedCount: deleteResult.deletedCount,
      organisationName: organisation.tournamentName,
      resetBy: `${user.name} ${user.surname}`,
      resetAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Tüm atamaları sıfırlama hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Belirli filtrelere göre atamaları sıfırla
router.delete("/reset-filtered/:organisationId", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar filtrelenmiş sıfırlama yapabilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { organisationId } = req.params;
    const { 
      weightCategory, 
      gender, 
      tournamentType, 
      roundNumber,
      matId,
      status 
    } = req.body;

    // Organizasyon kontrolü
    const organisation = await Organisation.findById(organisationId);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    // Filtre oluştur
    const filter = { organisationId };
    
    if (weightCategory) filter['matchDetails.weightCategory'] = weightCategory;
    if (gender) filter['matchDetails.gender'] = gender;
    if (tournamentType) filter['matchDetails.tournamentType'] = tournamentType;
    if (roundNumber !== undefined) filter['matchDetails.roundNumber'] = roundNumber;
    if (matId) filter.matId = matId;
    if (status) filter.status = status;

    // Devam eden atamaları kontrol et (sadece in_progress olanları)
    const activeFilter = { ...filter, status: 'in_progress' };
    const activeAssignments = await MatAssignment.find(activeFilter).populate('matId', 'name');

    if (activeAssignments.length > 0) {
      const activeMatNames = activeAssignments.map(a => a.matId.name).join(', ');
      return res.status(400).json({ 
        message: `${activeAssignments.length} maç devam ediyor. Önce bu maçları tamamlayın.`,
        activeMats: activeMatNames
      });
    }

    // Silinecek atamaları say
    const totalToDelete = await MatAssignment.countDocuments(filter);
    
    if (totalToDelete === 0) {
      return res.status(200).json({ 
        message: "Belirtilen kriterlere uygun atama bulunamadı",
        deletedCount: 0
      });
    }

    // Filtrelenmiş atamaları sil
    const deleteResult = await MatAssignment.deleteMany(filter);

    // Log kaydı oluştur
    console.log(`[RESET_FILTERED_ASSIGNMENTS] User: ${user._id} - Organisation: ${organisationId} - Filters: ${JSON.stringify(filter)} - Deleted: ${deleteResult.deletedCount}`);

    res.status(200).json({
      message: `${deleteResult.deletedCount} atama başarıyla silindi`,
      deletedCount: deleteResult.deletedCount,
      filters: {
        weightCategory,
        gender,
        tournamentType,
        roundNumber,
        matId,
        status
      },
      resetBy: `${user.name} ${user.surname}`,
      resetAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Filtrelenmiş atamaları sıfırlama hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Round'daki maçları belirli minderden çıkar
router.delete("/unassign-round", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar toplu çıkarma yapabilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { 
      organisationId, 
      matId, 
      roundNumber,
      weightCategory,
      gender,
      tournamentType,
      isLoserBracket
    } = req.body;

    // Zorunlu alan kontrolü
    if (!organisationId || roundNumber === undefined) {
      return res.status(400).json({ 
        message: "Organizasyon ID ve Round numarası gereklidir" 
      });
    }

    // Filtre oluştur
    const filter = { 
      organisationId,
      'matchDetails.roundNumber': roundNumber
    };

    if (matId) filter.matId = matId;
    if (weightCategory) filter['matchDetails.weightCategory'] = weightCategory;
    if (gender) filter['matchDetails.gender'] = gender;
    if (tournamentType) filter['matchDetails.tournamentType'] = tournamentType;
    if (isLoserBracket !== undefined) {
      // String'den boolean'a çevir
      filter['matchIdentifier.isLoserBracket'] = isLoserBracket === true || isLoserBracket === 'true';
    }

    // Devam eden atamaları kontrol et
    const activeAssignments = await MatAssignment.find({
      ...filter,
      status: 'in_progress'
    });

    if (activeAssignments.length > 0) {
      return res.status(400).json({ 
        message: `${activeAssignments.length} maç devam ediyor. Önce bu maçları tamamlayın.`
      });
    }

    // Atamaları sil
    const deleteResult = await MatAssignment.deleteMany(filter);

    res.status(200).json({
      message: `Round ${roundNumber} - ${deleteResult.deletedCount} atama başarıyla kaldırıldı`,
      deletedCount: deleteResult.deletedCount
    });
  } catch (error) {
    console.error("Round bazında toplu çıkarma hatası:", error);
    console.error("Error stack:", error.stack);
    console.error("Request body:", req.body);
    res.status(500).json({ 
      message: error.message,
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Minder atamasını iptal et/sil
router.delete("/:id", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar atama silebilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id } = req.params;

    const assignment = await MatAssignment.findById(id);
    if (!assignment) {
      return res.status(404).json({ message: "Minder ataması bulunamadı" });
    }

    if (assignment.status === 'in_progress') {
      return res.status(400).json({ 
        message: "Devam eden bir atama silinemez. Önce durumunu değiştirin." 
      });
    }

    await MatAssignment.findByIdAndDelete(id);

    res.status(200).json({ message: "Minder ataması başarıyla silindi" });
  } catch (error) {
    console.error("Minder ataması silme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Debug: Belirli maç için mevcut atamaları kontrol et
router.get("/debug/match-assignments/:organisationId", auth, async (req, res) => {
  try {
    const { organisationId } = req.params;
    const { 
      tournamentMatchId, 
      eliminationMatchNumber, 
      roundRobinMatchId, 
      isLoserBracket 
    } = req.query;

    if (!tournamentMatchId) {
      return res.status(400).json({ message: "tournamentMatchId gereklidir" });
    }

    // Belirli maç için tüm atamaları bul
    const query = { 
      organisationId,
      tournamentMatchId 
    };

    if (roundRobinMatchId) {
      query['matchIdentifier.roundRobinMatchId'] = roundRobinMatchId;
    }
    
    if (eliminationMatchNumber) {
      query['matchIdentifier.eliminationMatchNumber'] = parseInt(eliminationMatchNumber);
      query['matchIdentifier.isLoserBracket'] = isLoserBracket === 'true';
    }

    const assignments = await MatAssignment.find(query)
      .populate('matId', 'name order')
      .populate('assignedBy', 'name surname')
      .sort({ createdAt: -1 });

    res.json({
      query,
      found: assignments.length,
      assignments: assignments.map(a => ({
        _id: a._id,
        matName: a.matId?.name || 'Unknown',
        matchIdentifier: a.matchIdentifier,
        status: a.status,
        assignedBy: a.assignedBy ? `${a.assignedBy.name} ${a.assignedBy.surname}` : 'Unknown',
        createdAt: a.createdAt,
        updatedAt: a.updatedAt
      }))
    });
  } catch (error) {
    console.error("Debug maç ataması kontrol hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Atama istatistikleri - sıfırlamadan önce kontrol için
router.get("/stats/:organisationId", auth, async (req, res) => {
  try {
    const { organisationId } = req.params;

    // Organizasyon kontrolü
    const organisation = await Organisation.findById(organisationId);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    // Genel istatistikler
    const totalAssignments = await MatAssignment.countDocuments({ organisationId });
    const assignmentsByStatus = await MatAssignment.aggregate([
      { $match: { organisationId: new mongoose.Types.ObjectId(organisationId) } },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);

    const statusStats = {
      assigned: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0
    };

    assignmentsByStatus.forEach(stat => {
      statusStats[stat._id] = stat.count;
    });

    // Minder bazında istatistikler
    const matStats = await MatAssignment.aggregate([
      { $match: { organisationId: new mongoose.Types.ObjectId(organisationId) } },
      { 
        $lookup: {
          from: 'mats',
          localField: 'matId',
          foreignField: '_id',
          as: 'mat'
        }
      },
      { $unwind: '$mat' },
      { 
        $group: { 
          _id: "$matId", 
          matName: { $first: "$mat.name" },
          count: { $sum: 1 },
          assigned: { $sum: { $cond: [{ $eq: ["$status", "assigned"] }, 1, 0] } },
          in_progress: { $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } }
        }
      },
      { $sort: { matName: 1 } }
    ]);

    // Kategori bazında istatistikler
    const categoryStats = await MatAssignment.aggregate([
      { $match: { organisationId: new mongoose.Types.ObjectId(organisationId) } },
      { 
        $group: { 
          _id: {
            weightCategory: "$matchDetails.weightCategory",
            gender: "$matchDetails.gender",
            tournamentType: "$matchDetails.tournamentType"
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id.gender": 1, "_id.weightCategory": 1 } }
    ]);

    // Round bazında istatistikler
    const roundStats = await MatAssignment.aggregate([
      { $match: { organisationId: new mongoose.Types.ObjectId(organisationId) } },
      { 
        $group: { 
          _id: "$matchDetails.roundNumber",
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    res.json({
      organisationName: organisation.tournamentName,
      summary: {
        totalAssignments,
        ...statusStats
      },
      matStats,
      categoryStats: categoryStats.map(stat => ({
        category: `${stat._id.gender} ${stat._id.weightCategory} (${stat._id.tournamentType})`,
        count: stat.count,
        details: stat._id
      })),
      roundStats: roundStats.map(stat => ({
        round: stat._id,
        count: stat.count
      })),
      canReset: statusStats.in_progress === 0, // Devam eden maç yoksa sıfırlanabilir
      resetWarning: statusStats.in_progress > 0 ? 
        `${statusStats.in_progress} maç devam ediyor. Önce bu maçları tamamlayın.` : null
    });
  } catch (error) {
    console.error("Atama istatistikleri hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Yardımcı fonksiyonlar

// Maç detaylarını al
async function getMatchDetails(tournamentMatch, matchIdentifier) {
  try {
    if (matchIdentifier.roundRobinMatchId) {
      // Round Robin maçı
      for (const round of tournamentMatch.rounds) {
        const match = round.matches.find(m => m.matchId === matchIdentifier.roundRobinMatchId);
        if (match) {
          return {
            roundNumber: round.roundNumber,
            player1Name: match.player1?.name || 'TBD',
            player2Name: match.player2?.name || 'TBD'
          };
        }
      }
    } else if (matchIdentifier.eliminationMatchNumber !== undefined) {
      // Elimination maçı
      const brackets = matchIdentifier.isLoserBracket ? 
        tournamentMatch.loserBrackets : 
        tournamentMatch.brackets;
      
      const match = brackets.find(m => m.matchNumber === matchIdentifier.eliminationMatchNumber);
      if (match) {
        return {
          roundNumber: match.roundNumber,
          player1Name: match.player1?.name || 'TBD',
          player2Name: match.player2?.name || 'TBD'
        };
      }
    }
    return null;
  } catch (error) {
    console.error("Maç detayları alınırken hata:", error);
    return null;
  }
}

// Atanmamış maçları al
async function getUnassignedMatches(organisationId, filters = {}) {
  try {
    // Turnuva maçlarını al
    const tournamentQuery = { organisationId };
    if (filters.weightCategory) tournamentQuery.weightCategory = filters.weightCategory;
    if (filters.gender) tournamentQuery.gender = filters.gender;
    if (filters.tournamentType) tournamentQuery.tournamentType = filters.tournamentType;

    const tournamentMatches = await TournamentMatch.find(tournamentQuery);

    // Mevcut atamaları al
    const existingAssignments = await MatAssignment.find({ organisationId });
    const assignedMatches = new Set();

    existingAssignments.forEach(assignment => {
      const key = `${assignment.tournamentMatchId}_${assignment.matchIdentifier.roundRobinMatchId || assignment.matchIdentifier.eliminationMatchNumber}_${assignment.matchIdentifier.isLoserBracket || false}`;
      assignedMatches.add(key);
    });

    const unassignedMatches = [];

    for (const tournament of tournamentMatches) {
      if (tournament.tournamentType === 'round_robin') {
        // Round Robin maçları
        for (const round of tournament.rounds) {
          if (filters.roundNumber && round.roundNumber !== filters.roundNumber) continue;
          
          for (const match of round.matches) {
            // BYE maçlarını filtrele - sadece bir oyuncusu olan veya BYE içeren maçları atla
            const isByeMatch = (!match.player1 || !match.player2) || 
                              (match.player1?.isBye || match.player1?.name === 'BYE') ||
                              (match.player2?.isBye || match.player2?.name === 'BYE');
            
            if (isByeMatch) continue; // BYE maçlarını atla
            
            const key = `${tournament._id}_${match.matchId}_false`;
            if (!assignedMatches.has(key)) {
              unassignedMatches.push({
                tournamentMatchId: tournament._id,
                matchIdentifier: {
                  roundRobinMatchId: match.matchId,
                  eliminationMatchNumber: null,
                  isLoserBracket: false
                },
                matchDetails: {
                  weightCategory: tournament.weightCategory,
                  gender: tournament.gender,
                  roundNumber: round.roundNumber,
                  tournamentType: tournament.tournamentType,
                  player1Name: match.player1?.name || 'TBD',
                  player2Name: match.player2?.name || 'TBD',
                  status: match.status
                }
              });
            }
          }
        }
      } else {
        // Elimination maçları (Winner Bracket)
        for (const match of tournament.brackets) {
          if (filters.roundNumber && match.roundNumber !== filters.roundNumber) continue;
          
          // BYE maçlarını filtrele - sadece bir oyuncusu olan veya BYE içeren maçları atla
          const isByeMatch = (!match.player1 || !match.player2) || 
                            (match.player1?.isBye || match.player1?.name === 'BYE') ||
                            (match.player2?.isBye || match.player2?.name === 'BYE');
          
          if (isByeMatch) continue; // BYE maçlarını atla
          
          const key = `${tournament._id}_${match.matchNumber}_false`;
          if (!assignedMatches.has(key)) {
            unassignedMatches.push({
              tournamentMatchId: tournament._id,
              matchIdentifier: {
                roundRobinMatchId: null,
                eliminationMatchNumber: match.matchNumber,
                isLoserBracket: false
              },
              matchDetails: {
                weightCategory: tournament.weightCategory,
                gender: tournament.gender,
                roundNumber: match.roundNumber,
                tournamentType: tournament.tournamentType,
                player1Name: match.player1?.name || 'TBD',
                player2Name: match.player2?.name || 'TBD',
                status: match.status
              }
            });
          }
        }

        // Loser Bracket maçları (Double Elimination için)
        if (tournament.tournamentType === 'double_elimination' && tournament.loserBrackets) {
          for (const match of tournament.loserBrackets) {
            if (filters.roundNumber && match.roundNumber !== filters.roundNumber) continue;
            
            // BYE maçlarını filtrele - sadece bir oyuncusu olan veya BYE içeren maçları atla
            const isByeMatch = (!match.player1 || !match.player2) || 
                              (match.player1?.isBye || match.player1?.name === 'BYE') ||
                              (match.player2?.isBye || match.player2?.name === 'BYE');
            
            if (isByeMatch) continue; // BYE maçlarını atla
            
            const key = `${tournament._id}_${match.matchNumber}_true`;
            if (!assignedMatches.has(key)) {
              unassignedMatches.push({
                tournamentMatchId: tournament._id,
                matchIdentifier: {
                  roundRobinMatchId: null,
                  eliminationMatchNumber: match.matchNumber,
                  isLoserBracket: true
                },
                matchDetails: {
                  weightCategory: tournament.weightCategory,
                  gender: tournament.gender,
                  roundNumber: match.roundNumber,
                  tournamentType: tournament.tournamentType,
                  player1Name: match.player1?.name || 'TBD',
                  player2Name: match.player2?.name || 'TBD',
                  status: match.status
                }
              });
            }
          }
        }
      }
    }

    return unassignedMatches;
  } catch (error) {
    console.error("Atanmamış maçlar alınırken hata:", error);
    return [];
  }
}

// Otomatik atama yap
async function performAutoAssignment(unassignedMatches, mats, assignedById, strategy) {
  const assignments = [];
  
  try {
    // Stratejiye göre atama
    if (strategy === 'round_robin') {
      // Round'lara göre grupla ve sırayla ata
      const groupedByRound = {};
      unassignedMatches.forEach(match => {
        const round = match.matchDetails.roundNumber;
        if (!groupedByRound[round]) groupedByRound[round] = [];
        groupedByRound[round].push(match);
      });

      let matIndex = 0;
      for (const round of Object.keys(groupedByRound).sort((a, b) => a - b)) {
        for (const match of groupedByRound[round]) {
          const mat = mats[matIndex % mats.length];
          
          const assignment = new MatAssignment({
            matId: mat._id,
            organisationId: mat.organisationId,
            tournamentMatchId: match.tournamentMatchId,
            matchIdentifier: match.matchIdentifier,
            matchDetails: match.matchDetails,
            assignedBy: assignedById,
            assignmentType: 'automatic'
          });

          await assignment.save();
          
          const populatedAssignment = await MatAssignment.findById(assignment._id)
            .populate('matId', 'name order')
            .populate('tournamentMatchId', 'weightCategory gender tournamentType')
            .populate('assignedBy', 'name surname');
            
          assignments.push(populatedAssignment);
          matIndex++;
        }
      }
    } else if (strategy === 'sequential') {
      // Sıralı atama
      let matIndex = 0;
      for (const match of unassignedMatches) {
        const mat = mats[matIndex % mats.length];
        
        const assignment = new MatAssignment({
          matId: mat._id,
          organisationId: mat.organisationId,
          tournamentMatchId: match.tournamentMatchId,
          matchIdentifier: match.matchIdentifier,
          matchDetails: match.matchDetails,
          assignedBy: assignedById,
          assignmentType: 'automatic'
        });

        await assignment.save();
        
        const populatedAssignment = await MatAssignment.findById(assignment._id)
          .populate('matId', 'name order')
          .populate('tournamentMatchId', 'weightCategory gender tournamentType')
          .populate('assignedBy', 'name surname');
          
        assignments.push(populatedAssignment);
        matIndex++;
      }
    } else if (strategy === 'balanced') {
      // Dengeli atama - her mindere eşit sayıda maç
      const matchesPerMat = Math.ceil(unassignedMatches.length / mats.length);
      
      for (let i = 0; i < unassignedMatches.length; i++) {
        const match = unassignedMatches[i];
        const matIndex = Math.floor(i / matchesPerMat);
        const mat = mats[Math.min(matIndex, mats.length - 1)];
        
        const assignment = new MatAssignment({
          matId: mat._id,
          organisationId: mat.organisationId,
          tournamentMatchId: match.tournamentMatchId,
          matchIdentifier: match.matchIdentifier,
          matchDetails: match.matchDetails,
          assignedBy: assignedById,
          assignmentType: 'automatic'
        });

        await assignment.save();
        
        const populatedAssignment = await MatAssignment.findById(assignment._id)
          .populate('matId', 'name order')
          .populate('tournamentMatchId', 'weightCategory gender tournamentType')
          .populate('assignedBy', 'name surname');
          
        assignments.push(populatedAssignment);
      }
    }

    return assignments;
  } catch (error) {
    console.error("Otomatik atama sırasında hata:", error);
    throw error;
  }
}

// Round'ları maç sayılarıyla birlikte listele
async function getRoundsWithMatchCounts(organisationId, filters = {}) {
  try {
    // Turnuva maçlarını al
    const tournamentQuery = { organisationId };
    if (filters.weightCategory) tournamentQuery.weightCategory = filters.weightCategory;
    if (filters.gender) tournamentQuery.gender = filters.gender;
    if (filters.tournamentType) tournamentQuery.tournamentType = filters.tournamentType;

    const tournamentMatches = await TournamentMatch.find(tournamentQuery);

    // Mevcut atamaları al
    const existingAssignments = await MatAssignment.find({ organisationId });
    const assignedMatches = new Set();

    existingAssignments.forEach(assignment => {
      const key = `${assignment.tournamentMatchId}_${assignment.matchIdentifier.roundRobinMatchId || assignment.matchIdentifier.eliminationMatchNumber}_${assignment.matchIdentifier.isLoserBracket || false}`;
      assignedMatches.add(key);
    });

    const roundsMap = new Map();

    for (const tournament of tournamentMatches) {
      const tournamentInfo = {
        tournamentId: tournament._id,
        weightCategory: tournament.weightCategory,
        gender: tournament.gender,
        tournamentType: tournament.tournamentType
      };

      if (tournament.tournamentType === 'round_robin') {
        // Round Robin maçları
        for (const round of tournament.rounds) {
          const roundKey = `${tournament.tournamentType}_${tournament.weightCategory}_${tournament.gender}_${round.roundNumber}_false`;
          
          if (!roundsMap.has(roundKey)) {
            roundsMap.set(roundKey, {
              roundNumber: round.roundNumber,
              tournamentType: tournament.tournamentType,
              weightCategory: tournament.weightCategory,
              gender: tournament.gender,
              isLoserBracket: false,
              totalMatches: 0,
              assignedMatches: 0,
              unassignedMatches: 0,
              tournaments: []
            });
          }

          const roundData = roundsMap.get(roundKey);
          roundData.tournaments.push(tournamentInfo);
          
          for (const match of round.matches) {
            // BYE maçlarını filtrele - istatistiklere dahil etme
            const isByeMatch = (!match.player1 || !match.player2) || 
                              (match.player1?.isBye || match.player1?.name === 'BYE') ||
                              (match.player2?.isBye || match.player2?.name === 'BYE');
            
            if (isByeMatch) continue; // BYE maçlarını istatistiklere dahil etme
            
            const key = `${tournament._id}_${match.matchId}_false`;
            roundData.totalMatches++;
            
            if (assignedMatches.has(key)) {
              roundData.assignedMatches++;
            } else {
              roundData.unassignedMatches++;
            }
          }
        }
      } else {
        // Elimination maçları (Winner Bracket)
        const winnerRounds = new Map();
        for (const match of tournament.brackets) {
          if (!winnerRounds.has(match.roundNumber)) {
            winnerRounds.set(match.roundNumber, []);
          }
          winnerRounds.get(match.roundNumber).push(match);
        }

        for (const [roundNumber, matches] of winnerRounds) {
          const roundKey = `${tournament.tournamentType}_${tournament.weightCategory}_${tournament.gender}_${roundNumber}_false`;
          
          if (!roundsMap.has(roundKey)) {
            roundsMap.set(roundKey, {
              roundNumber: roundNumber,
              tournamentType: tournament.tournamentType,
              weightCategory: tournament.weightCategory,
              gender: tournament.gender,
              isLoserBracket: false,
              totalMatches: 0,
              assignedMatches: 0,
              unassignedMatches: 0,
              tournaments: []
            });
          }

          const roundData = roundsMap.get(roundKey);
          roundData.tournaments.push(tournamentInfo);
          
          for (const match of matches) {
            // BYE maçlarını filtrele - istatistiklere dahil etme
            const isByeMatch = (!match.player1 || !match.player2) || 
                              (match.player1?.isBye || match.player1?.name === 'BYE') ||
                              (match.player2?.isBye || match.player2?.name === 'BYE');
            
            if (isByeMatch) continue; // BYE maçlarını istatistiklere dahil etme
            
            const key = `${tournament._id}_${match.matchNumber}_false`;
            roundData.totalMatches++;
            
            if (assignedMatches.has(key)) {
              roundData.assignedMatches++;
            } else {
              roundData.unassignedMatches++;
            }
          }
        }

        // Loser Bracket maçları (Double Elimination için)
        if (tournament.tournamentType === 'double_elimination' && tournament.loserBrackets) {
          const loserRounds = new Map();
          for (const match of tournament.loserBrackets) {
            if (!loserRounds.has(match.roundNumber)) {
              loserRounds.set(match.roundNumber, []);
            }
            loserRounds.get(match.roundNumber).push(match);
          }

          for (const [roundNumber, matches] of loserRounds) {
            const roundKey = `${tournament.tournamentType}_${tournament.weightCategory}_${tournament.gender}_${roundNumber}_true`;
            
            if (!roundsMap.has(roundKey)) {
              roundsMap.set(roundKey, {
                roundNumber: roundNumber,
                tournamentType: tournament.tournamentType,
                weightCategory: tournament.weightCategory,
                gender: tournament.gender,
                isLoserBracket: true,
                totalMatches: 0,
                assignedMatches: 0,
                unassignedMatches: 0,
                tournaments: []
              });
            }

            const roundData = roundsMap.get(roundKey);
            roundData.tournaments.push(tournamentInfo);
            
            for (const match of matches) {
              // BYE maçlarını filtrele - istatistiklere dahil etme
              const isByeMatch = (!match.player1 || !match.player2) || 
                                (match.player1?.isBye || match.player1?.name === 'BYE') ||
                                (match.player2?.isBye || match.player2?.name === 'BYE');
              
              if (isByeMatch) continue; // BYE maçlarını istatistiklere dahil etme
              
              const key = `${tournament._id}_${match.matchNumber}_true`;
              roundData.totalMatches++;
              
              if (assignedMatches.has(key)) {
                roundData.assignedMatches++;
              } else {
                roundData.unassignedMatches++;
              }
            }
          }
        }
      }
    }

    // Map'i array'e çevir ve sırala
    const rounds = Array.from(roundsMap.values()).sort((a, b) => {
      // Önce tournament type'a göre sırala
      if (a.tournamentType !== b.tournamentType) {
        return a.tournamentType.localeCompare(b.tournamentType);
      }
      // Sonra weight category'ye göre
      if (a.weightCategory !== b.weightCategory) {
        return a.weightCategory.localeCompare(b.weightCategory);
      }
      // Sonra gender'a göre
      if (a.gender !== b.gender) {
        return a.gender.localeCompare(b.gender);
      }
      // Sonra round number'a göre
      if (a.roundNumber !== b.roundNumber) {
        return a.roundNumber - b.roundNumber;
      }
      // Son olarak loser bracket'e göre
      return a.isLoserBracket ? 1 : -1;
    });

    return rounds;
  } catch (error) {
    console.error("Round'ları maç sayılarıyla alınırken hata:", error);
    return [];
  }
}

// Belirli bir round'daki maçları al
async function getRoundMatches(organisationId, filters = {}) {
  try {
    const { roundNumber, weightCategory, gender, tournamentType, isLoserBracket = false } = filters;

    // Turnuva maçlarını al
    const tournamentQuery = { organisationId };
    if (weightCategory) tournamentQuery.weightCategory = weightCategory;
    if (gender) tournamentQuery.gender = gender;
    if (tournamentType) tournamentQuery.tournamentType = tournamentType;

    const tournamentMatches = await TournamentMatch.find(tournamentQuery);

    const roundMatches = [];

    for (const tournament of tournamentMatches) {
      if (tournament.tournamentType === 'round_robin') {
        // Round Robin maçları
        for (const round of tournament.rounds) {
          if (round.roundNumber === roundNumber) {
            for (const match of round.matches) {
              // BYE maçlarını filtrele - round bazında atamaya dahil etme
              const isByeMatch = (!match.player1 || !match.player2) || 
                                (match.player1?.isBye || match.player1?.name === 'BYE') ||
                                (match.player2?.isBye || match.player2?.name === 'BYE');
              
              if (isByeMatch) continue; // BYE maçlarını atla
              
              roundMatches.push({
                tournamentMatchId: tournament._id,
                matchIdentifier: {
                  roundRobinMatchId: match.matchId,
                  eliminationMatchNumber: null,
                  isLoserBracket: false
                },
                matchDetails: {
                  weightCategory: tournament.weightCategory,
                  gender: tournament.gender,
                  roundNumber: round.roundNumber,
                  tournamentType: tournament.tournamentType,
                  player1Name: match.player1?.name || 'TBD',
                  player2Name: match.player2?.name || 'TBD',
                  status: match.status
                }
              });
            }
          }
        }
      } else {
        // Elimination maçları
        const brackets = isLoserBracket ? tournament.loserBrackets : tournament.brackets;
        
        if (brackets) {
          for (const match of brackets) {
            if (match.roundNumber === roundNumber) {
              // BYE maçlarını filtrele - round bazında atamaya dahil etme
              const isByeMatch = (!match.player1 || !match.player2) || 
                                (match.player1?.isBye || match.player1?.name === 'BYE') ||
                                (match.player2?.isBye || match.player2?.name === 'BYE');
              
              if (isByeMatch) continue; // BYE maçlarını atla
              
              roundMatches.push({
                tournamentMatchId: tournament._id,
                matchIdentifier: {
                  roundRobinMatchId: null,
                  eliminationMatchNumber: match.matchNumber,
                  isLoserBracket: isLoserBracket
                },
                matchDetails: {
                  weightCategory: tournament.weightCategory,
                  gender: tournament.gender,
                  roundNumber: match.roundNumber,
                  tournamentType: tournament.tournamentType,
                  player1Name: match.player1?.name || 'TBD',
                  player2Name: match.player2?.name || 'TBD',
                  status: match.status
                }
              });
            }
          }
        }
      }
    }

    return roundMatches;
  } catch (error) {
    console.error("Round maçları alınırken hata:", error);
    return [];
  }
}

module.exports = router;
