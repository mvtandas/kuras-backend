const express = require("express");
const router = express.Router();
const TournamentMatch = require("../models/tournamentMatch");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const auth = require("../middleware/auth");
const mongoose = require('mongoose');

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
  } else if (data.tournamentType === 'single_elimination' && data.brackets) {
    data.brackets.forEach(match => {
      // BYE oyuncularını temizle
      if (match.player1 && (match.player1.name === "BYE" || match.player1.participantId === "bye")) {
        match.player1 = null;
      }
      if (match.player2 && (match.player2.name === "BYE" || match.player2.participantId === "bye")) {
        match.player2 = null;
      }
    });
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

// Yeni turnuva maçları oluştur
router.post("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar maç oluşturabilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { 
      organisationId, 
      weightCategory, 
      gender, 
      tournamentType, 
      rounds, 
      brackets,
      participants 
    } = req.body;

    // Zorunlu alan kontrolü
    if (!organisationId || !weightCategory || !gender || !tournamentType) {
      return res.status(400).json({ message: "Zorunlu alanları doldurun" });
    }

    // Organizasyonun var olduğunu kontrol et
    const organisation = await Organisation.findById(organisationId);
    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    // Aynı kategori ve cinsiyet için zaten turnuva var mı kontrol et
    const existingTournament = await TournamentMatch.findOne({
      organisationId,
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

    // Eğer katılımcılar verilmişse otomatik maç oluştur
    if (participants && participants.length > 0) {
      if (tournamentType === 'round_robin') {
        tournamentRounds = createRoundRobinMatches(participants);
      } else if (tournamentType === 'single_elimination') {
        tournamentBrackets = createSingleEliminationBrackets(participants);
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
      }
    }

    const tournamentMatch = new TournamentMatch({
      organisationId,
      weightCategory,
      gender,
      tournamentType,
      rounds: tournamentRounds,
      brackets: tournamentBrackets,
      status: 'active'
    });

    await tournamentMatch.save();
    res.status(201).json(tournamentMatch);
  } catch (error) {
    console.error("Turnuva maçı oluşturma hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Turnuva maçlarını listele
router.get("/", auth, async (req, res) => {
  try {
    const { organisationId, weightCategory, gender, status } = req.query;
    
    const filters = {};
    if (organisationId) filters.organisationId = organisationId;
    if (weightCategory) filters.weightCategory = weightCategory;
    if (gender) filters.gender = gender;
    if (status) filters.status = status;

    const matches = await TournamentMatch.find(filters)
      .populate({
        path: 'organisationId',
        select: 'tournamentName tournamentDate tournamentPlace'
      })
      .sort({ createdAt: -1 });

    // Her turnuva için istatistikleri ekle
    const matchesWithStats = matches.map(match => {
      const stats = match.getStats();
      return {
        ...match.toObject(),
        stats
      };
    });

    res.json(matchesWithStats);
  } catch (error) {
    console.error("Turnuva maçları listeleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Single elimination turnuvalarında kazananları ilerletme fonksiyonu
async function processAdvancement(tournamentMatch) {
  if (tournamentMatch.tournamentType !== 'single_elimination') {
    return tournamentMatch;
  }
  
  let hasChanges = false;
  
  // Brackets'i roundNumber'a göre sırala
  const sortedBrackets = tournamentMatch.brackets.sort((a, b) => a.roundNumber - b.roundNumber);
  
  // Round'ları grupla
  const roundGroups = {};
  sortedBrackets.forEach(bracket => {
    if (!roundGroups[bracket.roundNumber]) {
      roundGroups[bracket.roundNumber] = [];
    }
    roundGroups[bracket.roundNumber].push(bracket);
  });
  
  // Her round için kontrol et
  for (const roundNumber of Object.keys(roundGroups).sort((a, b) => a - b)) {
    const roundMatches = roundGroups[roundNumber];
    
    // Bu round'daki gerçek maçları (her iki oyuncusu da olan) kontrol et
    const realMatches = roundMatches.filter(match => 
      match.player1 && match.player2
    );
    
    // Bu round'daki bye maçları kontrol et
    const byeMatches = roundMatches.filter(match => 
      (match.player1 && !match.player2) || (!match.player1 && match.player2)
    );
    
    // Bu round'daki tüm gerçek maçların tamamlanıp tamamlanmadığını kontrol et
    const allRealMatchesCompleted = realMatches.every(match => 
      match.status === 'completed'
    );
    
    // Eğer bu round'daki tüm gerçek maçlar tamamlandıysa, bye maçları da tamamla
    if (realMatches.length > 0 && allRealMatchesCompleted && byeMatches.length > 0) {
      for (let byeMatch of byeMatches) {
        if (byeMatch.status !== 'completed') {
          const winner = byeMatch.player1 || byeMatch.player2;
          const winnerSlot = byeMatch.player1 ? 'player1' : 'player2';
          
          // Bye maçını tamamla
          byeMatch.status = 'completed';
          byeMatch.winner = winnerSlot;
          byeMatch.completedAt = new Date();
          byeMatch.notes = 'Otomatik geçiş - Round tamamlandı';
          hasChanges = true;
          
          // Kazananı bir sonraki tura ilerlet
          if (byeMatch.nextMatchNumber) {
            const nextMatch = sortedBrackets.find(b => b.matchNumber === byeMatch.nextMatchNumber);
            if (nextMatch) {
              if (byeMatch.nextMatchSlot === 'player1') {
                nextMatch.player1 = winner;
              } else if (byeMatch.nextMatchSlot === 'player2') {
                nextMatch.player2 = winner;
              }
              hasChanges = true;
            }
          }
        }
      }
    }
  }
  
  // Normal kazanan ilerletme işlemleri
  for (let bracket of sortedBrackets) {
    // Normal maç kazananı kontrolü
    if (bracket.status === 'completed' && bracket.winner && bracket.nextMatchNumber) {
      const winner = bracket.winner === 'player1' ? bracket.player1 : bracket.player2;
      
      if (winner) {
        const nextMatch = sortedBrackets.find(b => b.matchNumber === bracket.nextMatchNumber);
        if (nextMatch) {
          // Kazananın zaten yerleştirilip yerleştirilmediğini kontrol et
          const isAlreadyPlaced = (bracket.nextMatchSlot === 'player1' && nextMatch.player1?.participantId === winner.participantId) ||
                                 (bracket.nextMatchSlot === 'player2' && nextMatch.player2?.participantId === winner.participantId);
          
          if (!isAlreadyPlaced) {
            if (bracket.nextMatchSlot === 'player1') {
              nextMatch.player1 = winner;
            } else if (bracket.nextMatchSlot === 'player2') {
              nextMatch.player2 = winner;
            }
            hasChanges = true;
          }
        }
      }
    }
  }
  
  // Değişiklikler varsa kaydet
  if (hasChanges) {
    tournamentMatch.brackets = sortedBrackets;
    await tournamentMatch.save();
  }
  
  return tournamentMatch;
}

// Belirli bir turnuva maçını getir
router.get("/:id", auth, async (req, res) => {
  try {
    let tournamentMatch = await TournamentMatch.findById(req.params.id)
      .populate({
        path: 'organisationId',
        select: 'tournamentName tournamentDate tournamentPlace'
      });

    if (!tournamentMatch) {
      return res.status(404).json({ message: "Turnuva maçı bulunamadı" });
    }

    // Single elimination turnuvalarında kazananları ilerlet
    tournamentMatch = await processAdvancement(tournamentMatch);

    // İstatistikleri ekle
    const stats = tournamentMatch.getStats();
    const result = {
      ...tournamentMatch.toObject(),
      stats
    };

    res.json(result);
  } catch (error) {
    console.error("Turnuva maçı getirme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Turnuva maçlarını güncelle
router.put("/:id", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar maç güncelleyebilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id } = req.params;
    const updates = req.body;

    const tournamentMatch = await TournamentMatch.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!tournamentMatch) {
      return res.status(404).json({ message: "Turnuva maçı bulunamadı" });
    }

    res.json(tournamentMatch);
  } catch (error) {
    console.error("Turnuva maçı güncelleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Turnuva maçlarını sil
router.delete("/:id", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin silebilir
    if (user.role.name !== "Admin") {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id } = req.params;
    const deletedMatch = await TournamentMatch.findByIdAndDelete(id);

    if (!deletedMatch) {
      return res.status(404).json({ message: "Turnuva maçı bulunamadı" });
    }

    res.status(200).json({ message: "Turnuva maçı başarıyla silindi" });
  } catch (error) {
    console.error("Turnuva maçı silme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Belirli bir maçı güncelle (skor, kazanan vs.)
router.patch("/:id/matches/:matchId", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar maç güncelleyebilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id, matchId } = req.params;
    const { score, winner, status, notes } = req.body;

    const tournamentMatch = await TournamentMatch.findById(id);
    
    if (!tournamentMatch) {
      return res.status(404).json({ message: "Turnuva maçı bulunamadı" });
    }

    if (tournamentMatch.tournamentType === 'round_robin') {
      // Round robin maçını güncelle
      let matchFound = false;
      
      for (let round of tournamentMatch.rounds) {
        const match = round.matches.find(m => m.matchId === matchId);
        if (match) {
          if (score) match.score = score;
          if (winner !== undefined) match.winner = winner;
          if (status) match.status = status;
          if (notes !== undefined) match.notes = notes;
          
          if (status === 'completed') {
            match.completedAt = new Date();
          }
          
          matchFound = true;
          break;
        }
      }
      
      if (!matchFound) {
        return res.status(404).json({ message: "Maç bulunamadı" });
      }
    } else {
      // Single elimination maçını güncelle
      const match = tournamentMatch.brackets.find(m => m.matchNumber === parseInt(matchId));
      
      if (!match) {
        return res.status(404).json({ message: "Maç bulunamadı" });
      }
      
      if (score) match.score = score;
      if (winner !== undefined) match.winner = winner;
      if (status) match.status = status;
      if (notes !== undefined) match.notes = notes;
      
      if (status === 'completed') {
        match.completedAt = new Date();
      }
      
      // Kazananı bir sonraki maça yerleştir
      if (winner && match.nextMatchNumber) {
        tournamentMatch.advanceWinner(matchId);
      }
    }

    await tournamentMatch.save();
    
    // Güncellenmiş turnuvayı döndür
    const updatedMatch = await TournamentMatch.findById(id)
      .populate({
        path: 'organisationId',
        select: 'tournamentName tournamentDate tournamentPlace'
      });

    const stats = updatedMatch.getStats();
    const result = {
      ...updatedMatch.toObject(),
      stats
    };

    res.json(result);
  } catch (error) {
    console.error("Maç güncelleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Bye maçını manuel olarak tamamla
router.post("/:id/matches/:matchId/process-bye", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin ve Coach'lar bye işleyebilir
    if (!["Admin", "Coach"].includes(user.role.name)) {
      return res.status(403).json({ message: "Yetkiniz yok" });
    }

    const { id, matchId } = req.params;

    const tournamentMatch = await TournamentMatch.findById(id);
    
    if (!tournamentMatch) {
      return res.status(404).json({ message: "Turnuva maçı bulunamadı" });
    }

    if (tournamentMatch.tournamentType !== 'single_elimination') {
      return res.status(400).json({ message: "Bu işlem sadece single elimination turnuvalar için geçerlidir" });
    }

    // Maçı bul
    const match = tournamentMatch.brackets.find(m => m.matchNumber === parseInt(matchId));
    
    if (!match) {
      return res.status(404).json({ message: "Maç bulunamadı" });
    }

    // Bye durumu kontrol et
    const isByeMatch = (match.player1 && !match.player2) || (!match.player1 && match.player2);
    
    if (!isByeMatch) {
      return res.status(400).json({ message: "Bu maç bye durumunda değil" });
    }

    if (match.status === 'completed') {
      return res.status(400).json({ message: "Bu maç zaten tamamlanmış" });
    }

    // Bye maçını tamamla
    const winner = match.player1 || match.player2;
    const winnerSlot = match.player1 ? 'player1' : 'player2';
    
    match.status = 'completed';
    match.winner = winnerSlot;
    match.completedAt = new Date();
    match.notes = 'Manuel Bye İşlemi';

    // Kazananı bir sonraki tura ilerlet
    if (match.nextMatchNumber) {
      const nextMatch = tournamentMatch.brackets.find(b => b.matchNumber === match.nextMatchNumber);
      if (nextMatch) {
        if (match.nextMatchSlot === 'player1') {
          nextMatch.player1 = winner;
        } else if (match.nextMatchSlot === 'player2') {
          nextMatch.player2 = winner;
        }
      }
    }

    await tournamentMatch.save();
    
    // Güncellenmiş turnuvayı döndür
    const updatedMatch = await TournamentMatch.findById(id)
      .populate({
        path: 'organisationId',
        select: 'tournamentName tournamentDate tournamentPlace'
      });

    const stats = updatedMatch.getStats();
    const result = {
      ...updatedMatch.toObject(),
      stats
    };

    res.json(result);
  } catch (error) {
    console.error("Bye maç işleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Organizasyon için uygun katılımcıları getir (maç oluşturma için)
router.get("/:organisationId/eligible-participants", auth, async (req, res) => {
  try {
    const { organisationId } = req.params;
    const { weightCategory, gender } = req.query;

    if (!weightCategory || !gender) {
      return res.status(400).json({ message: "Kilo kategorisi ve cinsiyet gereklidir" });
    }

    // Organizasyonu bul
    const organisation = await Organisation.findById(organisationId)
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
      });

    if (!organisation) {
      return res.status(404).json({ message: "Organizasyon bulunamadı" });
    }

    // Belirtilen kilo ve cinsiyete göre katılımcıları filtrele
    const eligibleParticipants = organisation.participants.filter(p => 
      p.athlete && 
      p.weight.toString() === weightCategory &&
      p.athlete.gender === gender
    );

    // Katılımcıları formatla
    const formattedParticipants = eligibleParticipants.map(p => ({
      participantId: p._id,
      athleteId: p.athlete._id,
      name: `${p.athlete.name} ${p.athlete.surname}`,
      city: p.athlete.city ? p.athlete.city.name : '',
      club: p.athlete.club ? p.athlete.club.name : '',
      coach: p.coach ? `${p.coach.name} ${p.coach.surname}` : ''
    }));

    res.json(formattedParticipants);
  } catch (error) {
    console.error("Uygun katılımcıları getirme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Turnuva istatistiklerini getir
router.get("/:id/stats", auth, async (req, res) => {
  try {
    const tournamentMatch = await TournamentMatch.findById(req.params.id);

    if (!tournamentMatch) {
      return res.status(404).json({ message: "Turnuva maçı bulunamadı" });
    }

    const stats = tournamentMatch.getStats();
    res.json(stats);
  } catch (error) {
    console.error("Turnuva istatistikleri getirme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router; 