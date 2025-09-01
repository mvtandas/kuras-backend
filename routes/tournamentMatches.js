const express = require("express");
const router = express.Router();
const TournamentMatch = require("../models/tournamentMatch");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const auth = require("../middleware/auth");
// const mongoose = require('mongoose'); // not used

// --- HELPERS: notes için idempotent ekleme ---
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addNoteOnce(existing, label) {
  const e = String(existing || '');
  const pat = new RegExp(`(?:^|\\s*\\|\\s*)${escapeRegExp(label)}\\b`, 'gi');
  const cleaned = e
    .replace(pat, '')
    .replace(/(?:\\s*\\|\\s*){2,}/g, ' | ')
    .replace(/^\\s*\\|\\s*|\\s*\\|\\s*$/g, '')
    .trim();
  return cleaned ? `${cleaned} | ${label}` : label;
}

// --- DISPLAY NUMBERING: final en sonda, 1000/1100'ler sıraya katılır ---
function buildDisplayNumberMap(tmObj) {
  const map = {};
  let c = 1;

  const wb = [...(tmObj.brackets || [])]
    .sort((a,b)=>(a.roundNumber-b.roundNumber)||(a.matchNumber-b.matchNumber));

  // winner bracket finalini bul (nextMatchNumber yok ve en yüksek round)
  const maxRound = wb.reduce((m, x)=>Math.max(m, x.roundNumber||0), 0);
  const finalMatch = wb.find(m => (m.roundNumber === maxRound) && !m.nextMatchNumber);

  // 1) winner bracket (final hariç)
  for (const m of wb) {
    if (finalMatch && m.matchNumber === finalMatch.matchNumber) continue;
    map[m.matchNumber] = c++;
  }

  // 2) Final en sonda, losers'ın mevcut display'ine göre
  const losersMax = Math.max(0, ...((tmObj.loserBrackets||[]).map(x => x.displayNumber || 0)));
  const baseForFinal = Math.max(c - 1, losersMax) + 1;
  if (finalMatch) map[finalMatch.matchNumber] = baseForFinal;

  return map;
}

// Loser bracket için graph seviyesini hesaplayıp displayNumber atamaya yardımcılar
function computeLevels(matches) {
  const byNum = Object.fromEntries(matches.map(m => [m.matchNumber, m]));
  const parents = {};
  matches.forEach(m => {
    if (m.nextMatchNumber != null) {
      (parents[m.nextMatchNumber] ||= []).push(m.matchNumber);
    }
  });
  const memo = {};
  const lvl = (mn) => {
    if (memo[mn] != null) return memo[mn];
    const ps = parents[mn] || [];
    return (memo[mn] = ps.length ? 1 + Math.max(...ps.map(lvl)) : 0);
  };
  matches.forEach(m => { m._level = lvl(m.matchNumber); });
}

function lane(m) { return m.matchNumber >= 1100 ? 'B' : 'A'; }

function renumberLosers(losers, baseDisplay = 15) {
  computeLevels(losers);
  losers.sort((a,b) =>
    a._level - b._level ||
    lane(a).localeCompare(lane(b)) ||
    a.matchNumber - b.matchNumber
  );
  let d = baseDisplay;
  losers.forEach(m => { m.displayNumber = d++; });
}

function attachDisplayNumbers(tmObj) {
  const map = buildDisplayNumberMap(tmObj);
  const add = (arr=[]) => arr.map(m => ({
    ...m,
    displayNumber: (m.displayNumber ?? map[m.matchNumber] ?? m.matchNumber),
  }));
  return {
    ...tmObj,
    brackets: add(tmObj.brackets),
    loserBrackets: add(tmObj.loserBrackets),
  };
}

function findWinnerFinal(brackets=[]) {
  if (!brackets.length) return null;
  const maxRound = brackets.reduce((m,x)=>Math.max(m, x.roundNumber||0), 0);
  return brackets.find(m => (m.roundNumber === maxRound) && !m.nextMatchNumber) || null;
}

function areBronzesCompleted(loserBrackets=[]) {
  if (!loserBrackets.length) return true; // hiç yoksa engelleme
  const laneA = loserBrackets.filter(m => m.matchNumber >= 1000 && m.matchNumber < 1100);
  const laneB = loserBrackets.filter(m => m.matchNumber >= 1100 && m.matchNumber < 1200);

  const lastOf = (arr) => {
    if (!arr.length) return null;
    return arr.reduce((best, cur) => {
      if (!best) return cur;
      if (cur.roundNumber > best.roundNumber) return cur;
      if (cur.roundNumber === best.roundNumber && cur.matchNumber > best.matchNumber) return cur;
      return best;
    }, null);
  };

  const bronzeA = lastOf(laneA);
  const bronzeB = lastOf(laneB);

  const mustCheck = [bronzeA, bronzeB].filter(Boolean);
  if (!mustCheck.length) return true;
  return mustCheck.every(m => m.status === 'completed');
}

// Şerit finalinin ardına bir bronz maçı üretir ve finalin next'ini bu maça bağlar
function makeBronzeAfterLane(finalMatch, semiLoser, bronzeNumber) {
  if (!finalMatch) return null;
  const bronze = {
    roundNumber: (finalMatch.roundNumber || 0) + 1,
    matchNumber: bronzeNumber,
    player1: null,
    player2: semiLoser || null,
    status: 'scheduled',
    winner: null,
    score: { player1Score: 0, player2Score: 0 },
    scheduledTime: null,
    completedAt: null,
    nextMatchNumber: null,
    nextMatchSlot: 'player1',
    notes: ''
  };
  finalMatch.nextMatchNumber = bronze.matchNumber;
  finalMatch.nextMatchSlot = 'player1';
  return bronze;
}

// --- OKU VE DÜZELT: GET isteklerinde state’i finalize et ve tek tip obje döndür ---
async function ensureStateOnRead(tournamentMatch, { forceRebuild = true } = {}) {
  try {
    let changed = false;

    if (forceRebuild && tournamentMatch.tournamentType === 'double_elimination') {
      const lb = tournamentMatch.loserBrackets || [];
      const hasCompletedLB = lb.some(m => m.status === 'completed');
      if (!hasCompletedLB && lb.length) {
        tournamentMatch.loserBrackets = [];
        changed = true;
      }
    }

    tournamentMatch = await processAdvancement(tournamentMatch);

    if (tournamentMatch.tournamentType === 'double_elimination') {
      const beforeNotes = (tournamentMatch.loserBrackets||[]).map(m => m.notes || '').join('§');
      labelBronzeMatches(tournamentMatch.loserBrackets);
      const afterNotes  = (tournamentMatch.loserBrackets||[]).map(m => m.notes || '').join('§');
      if (beforeNotes !== afterNotes) changed = true;
      if (autoCompleteByeInLoserBrackets(tournamentMatch)) changed = true;
      await processLoserBracketAdvancement(tournamentMatch);
    }

    if (changed) await tournamentMatch.save();

    const fresh = await TournamentMatch.findById(tournamentMatch._id).populate({
      path: 'organisationId',
      select: 'tournamentName tournamentDate tournamentPlace'
    });

    const stats = fresh.getStats();
    const baseObj = fresh.toObject();
    // LoserBrackets için graph-temelli displayNumber ataması
    if (Array.isArray(baseObj.loserBrackets) && baseObj.loserBrackets.length) {
      const losersClone = baseObj.loserBrackets.map(m => ({ ...m }));
      // winner finalini bul ve winner-final-hariç sayısı kadar offset ver
      const wb = baseObj.brackets || [];
      const wbMaxRound = wb.reduce((m,x)=>Math.max(m, x.roundNumber||0), 0);
      const wbFinal = wb.find(m => (m.roundNumber === wbMaxRound) && !m.nextMatchNumber);
      const wbCountWithoutFinal = wb.filter(m => !wbFinal || m.matchNumber !== wbFinal.matchNumber).length;
      const baseStart = wbCountWithoutFinal + 1;
      renumberLosers(losersClone, baseStart);
      // displayNumber'ları geri yaz
      const dispByNum = Object.fromEntries(losersClone.map(m => [m.matchNumber, m.displayNumber]));
      baseObj.loserBrackets = baseObj.loserBrackets.map(m => ({ ...m, displayNumber: dispByNum[m.matchNumber] ?? m.displayNumber }));
    }
    const withDisplay = attachDisplayNumbers(baseObj);
    return { body: { ...withDisplay, stats }, fresh };
  } catch (err) {
    console.error('ensureStateOnRead hatası:', err);
    const stats = tournamentMatch.getStats();
    const withDisplay = attachDisplayNumbers(tournamentMatch.toObject());
    return { body: { ...withDisplay, stats }, fresh: tournamentMatch };
  }
}

// Gelen veriyi temizleyen fonksiyon
function cleanTournamentData(data) {
  if (data.tournamentType === 'round_robin' && data.rounds) {
    data.rounds.forEach(round => {
      round.matches.forEach(match => {
        // BYE oyuncularını temizle
        if (match.player1 && (match.player1.isBye || match.player1.name === "BYE" || match.player1.participantId === "bye")) {
          match.player1 = null;
        }
        if (match.player2 && (match.player2.isBye || match.player2.name === "BYE" || match.player2.participantId === "bye")) {
          match.player2 = null;
        }
      });
    });
  } else if ((data.tournamentType === 'single_elimination' || data.tournamentType === 'double_elimination') && data.brackets) {
    data.brackets.forEach(match => {
      // BYE oyuncularını temizle
      if (match.player1 && (match.player1.isBye || match.player1.name === "BYE" || match.player1.participantId === "bye")) {
        match.player1 = null;
      }
      if (match.player2 && (match.player2.isBye || match.player2.name === "BYE" || match.player2.participantId === "bye")) {
        match.player2 = null;
      }
    });
    
    // Double elimination için loser brackets da temizle
    if (data.tournamentType === 'double_elimination' && data.loserBrackets) {
      data.loserBrackets.forEach(match => {
        if (match.player1 && (match.player1.isBye || match.player1.name === "BYE" || match.player1.participantId === "bye")) {
          match.player1 = null;
        }
        if (match.player2 && (match.player2.isBye || match.player2.name === "BYE" || match.player2.participantId === "bye")) {
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
  let n = participants.length;
  const padded = [...participants];
  // 2'nin kuvvetine pad et (denge için BYE placeholder)
  const nextPow2 = Math.pow(2, Math.ceil(Math.log2(Math.max(2, n))));
  const byesToAdd = nextPow2 - n;
  for (let i = 0; i < byesToAdd; i++) {
    padded.push({ name: 'BYE', isBye: true, city: 'BYE', club: 'BYE' });
  }
  n = padded.length;
  
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
    
    const player1 = padded[player1Index];
    const player2 = padded[player2Index];
    
    // Eğer her iki oyuncu da yoksa, bu maçı atla
    if (!player1 && !player2) {
      continue;
    }
    
    const match = {
      roundNumber,
      matchNumber,
      player1: player1 && !player1.isBye ? player1 : null,
      player2: player2 && !player2.isBye ? player2 : null,
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
        notes: ''
      };
      
      winnerBrackets.push(match);
      matchNumber++;
    }
  }
  
  // Loser bracket başlangıçta boş bırakılır; repechage finalistler belirlenince dinamik kurulacak
  
  return { winnerBrackets, loserBrackets };
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
      gender,
      tournamentType
    });

    if (existingTournament) {
      return res.status(400).json({ 
        message: "Bu kategori ve cinsiyet için zaten bir turnuva mevcut" 
      });
    }

    let tournamentRounds = [];
    let tournamentBrackets = [];
    let tournamentLoserBrackets = [];

    // Debug: gelen veriyi kontrol et
    console.log('Tournament match creation - received data:', {
      tournamentType,
      bracketCount: brackets ? brackets.length : 0,
      loserBracketCount: req.body.loserBrackets ? req.body.loserBrackets.length : 0,
      hasParticipants: participants && participants.length > 0
    });

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
        // Double elimination: loser bracket her zaman dinamik kurulacak
        tournamentBrackets = brackets || [];
        tournamentLoserBrackets = [];
        
        if (tournamentBrackets.length > 0) {
          const cleanedData = cleanTournamentData({ 
            tournamentType, 
            brackets: tournamentBrackets
          });
          tournamentBrackets = cleanedData.brackets || [];
          tournamentLoserBrackets = []; // yine boş
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
      organisationId,
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

    // Her turnuvayı okurken state'i finalize et
    const results = await Promise.all(matches.map(m => ensureStateOnRead(m, { forceRebuild: true })));
    res.set('Cache-Control', 'no-store');
    return res.json(results.map(r => r.body));
  } catch (error) {
    console.error("Turnuva maçları listeleme hatası:", error);
    res.status(500).json({ message: error.message });
  }
});

// Single elimination ve double elimination turnuvalarında kazananları ilerletme fonksiyonu
async function processAdvancement(tournamentMatch) {
  if (tournamentMatch.tournamentType !== 'single_elimination' && tournamentMatch.tournamentType !== 'double_elimination') {
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
  
  // Double elimination için loser bracket oluşturma
  if (tournamentMatch.tournamentType === 'double_elimination') {
    await processDoubleEliminationLoserBrackets(tournamentMatch);
  }
  
  // Değişiklikler varsa kaydet
  if (hasChanges) {
    tournamentMatch.brackets = sortedBrackets;
    await tournamentMatch.save();
  }
  
  return tournamentMatch;
}

// --- YENİ: Double Elimination için loser bracket işleme (yarı-finalist bazlı) ---
async function processDoubleEliminationLoserBrackets(tournamentMatch) {
  try {
    console.log('processDoubleEliminationLoserBrackets (rebuild-first strategy)');

    const wb = tournamentMatch.brackets || [];
    if (wb.length === 0) return;

    const maxRound = Math.max(...wb.map(b => b.roundNumber || 0));
    if (!Number.isFinite(maxRound) || maxRound < 2) return;

    // Yarı finaller: finalden bir önceki round
    const semis = wb
      .filter(m => m.roundNumber === maxRound - 1 && m.player1 && m.player2)
      .sort((a, b) => a.matchNumber - b.matchNumber);

    if (semis.length < 2) return;

    const [semiA, semiB] = semis;

    // Kaybedenleri (tamamlanmışsa) veya şimdilik null
    const getSemiLoser = (semi) =>
      (semi && semi.status === 'completed' && semi.winner)
        ? (semi.winner === 'player1' ? semi.player2 : semi.player1)
        : null;

    const semiALoser = getSemiLoser(semiA);
    const semiBLoser = getSemiLoser(semiB);

    // Bir oyuncunun hangi kazanana kaybettiğini sırayla getir
    const losersTo = (winnerId) => {
      const items = [];
      for (const m of wb) {
        if (m.status !== 'completed' || !m.player1 || !m.player2 || !m.winner) continue;
        const w = m[m.winner];
        const l = m[m.winner === 'player1' ? 'player2' : 'player1'];
        if (!w?.participantId || !l?.participantId) continue;
        if (w.participantId === winnerId) {
          items.push({
            player: l,
            matchNumber: m.matchNumber,
            roundNumber: m.roundNumber,
          });
        }
      }
      items.sort((a, b) => (a.roundNumber - b.roundNumber) || (a.matchNumber - b.matchNumber));
      return items;
    };

    const semiAIds = [semiA.player1?.participantId, semiA.player2?.participantId].filter(Boolean);
    const semiBIds = [semiB.player1?.participantId, semiB.player2?.participantId].filter(Boolean);

    const laneA_blocks = [losersTo(semiAIds[0] || ''), losersTo(semiAIds[1] || '')];
    const laneB_blocks = [losersTo(semiBIds[0] || ''), losersTo(semiBIds[1] || '')];

    // Blok sırası korunarak düzle (ör. [Sedef, Esma] + [Fatma, Derya])
    const laneA_list = [...laneA_blocks[0], ...laneA_blocks[1]];
    const laneB_list = [...laneB_blocks[0], ...laneB_blocks[1]];

    // Yarı final kaybedenleri repechage içinden çıkar (sadece bronza rakip olacaklar)
    const strip = (list, semiLoser) => {
      if (!semiLoser?.participantId) return;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].player?.participantId === semiLoser.participantId) list.splice(i, 1);
      }
    };
    strip(laneA_list, semiALoser);
    strip(laneB_list, semiBLoser);

    // Eğer loser bracket'te herhangi bir tamamlanmış maç yoksa baştan kurmak daha güvenli
    const lb = tournamentMatch.loserBrackets || [];
    const hasCompletedLB = lb.some(m => m.status === 'completed');

    if (!hasCompletedLB) {
      // Baştan iki şeritlik repechage üret
      const newLB = createTwoLaneRepechage(laneA_list, laneB_list); // 1000-seri A, 1100-seri B

      // Şeritlerin bronz final maçlarını bul (son maçlar)
      const laneA_all = newLB.filter(m => m.matchNumber >= 1000 && m.matchNumber < 1100);
      const laneB_all = newLB.filter(m => m.matchNumber >= 1100 && m.matchNumber < 1200);
      const lastOf = (arr) => {
        if (arr.length === 0) return null;
        return arr.reduce((best, cur) => {
          if (!best) return cur;
          if (cur.roundNumber > best.roundNumber) return cur;
          if (cur.roundNumber === best.roundNumber && cur.matchNumber > best.matchNumber) return cur;
          return best;
        }, null);
      };
      const finalA = lastOf(laneA_all);
      const finalB = lastOf(laneB_all);

      // Şerit finalinin ardına bronz maçları oluştur ve bağla
      const bronzeA = makeBronzeAfterLane(finalA, semiBLoser, 1099);
      const bronzeB = makeBronzeAfterLane(finalB, semiALoser, 1199);
      if (bronzeA) newLB.push(bronzeA);
      if (bronzeB) newLB.push(bronzeB);

      tournamentMatch.loserBrackets = newLB;
      labelBronzeMatches(tournamentMatch.loserBrackets);
      autoCompleteByeInLoserBrackets(tournamentMatch);
      await tournamentMatch.save();
      return;
    }

    // Eğer LB'de sonuçlar varsa, yapıyı bozmadan sadece yarı final kaybedenlerini bronza sabitle ve diğer maçlardan temizle
    const laneA_now = lb.filter(m => m.matchNumber >= 1000 && m.matchNumber < 1100);
    const laneB_now = lb.filter(m => m.matchNumber >= 1100 && m.matchNumber < 1200);
    const lastOfNow = (arr) => {
      if (arr.length === 0) return null;
      return arr.reduce((best, cur) => {
        if (!best) return cur;
        if (cur.roundNumber > best.roundNumber) return cur;
        if (cur.roundNumber === best.roundNumber && cur.matchNumber > best.matchNumber) return cur;
        return best;
      }, null);
    };
    const finalA_now = lastOfNow(laneA_now);
    const finalB_now = lastOfNow(laneB_now);

    if (finalA_now && semiALoser) {
      finalA_now.player2 = semiALoser;
      // aynı oyuncu başka bir LB maçında görünmesin
      for (const m of laneA_now) {
        if (m === finalA_now) continue;
        if (m.player1?.participantId === semiALoser.participantId) m.player1 = null;
        if (m.player2?.participantId === semiALoser.participantId) m.player2 = null;
      }
    }
    if (finalB_now && semiBLoser) {
      finalB_now.player2 = semiBLoser;
      for (const m of laneB_now) {
        if (m === finalB_now) continue;
        if (m.player1?.participantId === semiBLoser.participantId) m.player1 = null;
        if (m.player2?.participantId === semiBLoser.participantId) m.player2 = null;
      }
    }

    labelBronzeMatches(tournamentMatch.loserBrackets);
    const changed = autoCompleteByeInLoserBrackets(tournamentMatch);
    if (changed) await tournamentMatch.save();

    await processLoserBracketAdvancement(tournamentMatch);
    labelBronzeMatches(tournamentMatch.loserBrackets);
    await tournamentMatch.save();
  } catch (error) {
    console.error('processDoubleEliminationLoserBrackets hatası:', error);
    throw error;
  }
}

// Tek şeritli (lane) repechage ağacı oluşturur ve bronz maça kadar bağlar
// --- GÜNCEL: Tek şeritli repechage ağacı (blok sırasına dokunmaz) ---
function buildRepechageLane(losers, startNumber = 1000) {
  const brackets = [];
  const n = losers.length;
  if (n === 1) {
    const only = losers[0]?.player || null;
    brackets.push({
      roundNumber: 1,
      matchNumber: startNumber + 90,
      player1: only,
      player2: null,
      status: 'scheduled',
      winner: null,
      score: { player1Score: 0, player2Score: 0 },
      scheduledTime: null,
      completedAt: null,
      nextMatchNumber: null,
      nextMatchSlot: 'player1',
      notes: ''
    });
    return { brackets, lastMatchNumber: startNumber + 90 };
  }
  if (n < 2) return { brackets, lastMatchNumber: null };

  // Her turdaki maç sayısı
  const matchesPerRound = [];
  let current = Math.ceil(n / 2);
  while (current >= 1) {
    matchesPerRound.push(current);
    if (current === 1) break;
    current = Math.ceil(current / 2);
  }

  let matchNumber = startNumber;
  const roundStartIndex = [];
  let totalCreated = 0;

  for (let r = 0; r < matchesPerRound.length; r++) {
    roundStartIndex[r] = totalCreated;
    for (let j = 0; j < matchesPerRound[r]; j++) {
      brackets.push({
        roundNumber: r + 1,
        matchNumber: matchNumber++,
        player1: null,
        player2: null,
        status: 'scheduled',
        winner: null,
        score: { player1Score: 0, player2Score: 0 },
        scheduledTime: null,
        completedAt: null,
        nextMatchNumber: null,
        nextMatchSlot: 'player1',
        notes: ''
      });
      totalCreated++;
    }
  }

  // Çocuk -> ebeveyn bağları
  for (let r = 0; r < matchesPerRound.length - 1; r++) {
    const thisStart = roundStartIndex[r];
    const nextStart = roundStartIndex[r + 1];
    const thisCount = matchesPerRound[r];
    for (let i = 0; i < thisCount; i++) {
      const childIdx = thisStart + i;
      const parentIdx = nextStart + Math.floor(i / 2);
      brackets[childIdx].nextMatchNumber = brackets[parentIdx].matchNumber;
      brackets[childIdx].nextMatchSlot = (i % 2 === 0) ? 'player1' : 'player2';
    }
  }

  // 1. tur yerleşimi — GELEN SIRA KORUNUR (bloklar sırası bozulmaz)
  const firstRoundMatches = brackets.filter(b => b.roundNumber === 1);
  let idx = 0;
  for (const m of firstRoundMatches) {
    m.player1 = losers[idx++]?.player || null;
    m.player2 = losers[idx++]?.player || null;
  }

  const lastMatchNumber = brackets[brackets.length - 1]?.matchNumber ?? null;
  return { brackets, lastMatchNumber };
}

// İki şeritli repechage ağacı oluşturur (A ve B finalistlerine kaybedenler ayrı şeritlerde)
// --- GÜNCEL: İki şeritli repechage üretimi (A=1000 serisi, B=1100 serisi) ---
function createTwoLaneRepechage(losersForLaneA, losersForLaneB, laneNumbers = {}) {
  const aStart = laneNumbers.laneAStart ?? 1000;
  const bStart = laneNumbers.laneBStart ?? (aStart + 100);

  const laneA = buildRepechageLane(losersForLaneA, aStart);
  const laneB = buildRepechageLane(losersForLaneB, bStart);

  if (laneNumbers.laneABronze && laneA.brackets.length) {
    laneA.brackets[laneA.brackets.length - 1].matchNumber = laneNumbers.laneABronze;
  }
  if (laneNumbers.laneBBronze && laneB.brackets.length) {
    laneB.brackets[laneB.brackets.length - 1].matchNumber = laneNumbers.laneBBronze;
  }

  return [...laneA.brackets, ...laneB.brackets];
}

// Tek ağaçlı repechage (artık kullanılmayabilir, geriye uyumluluk için bırakıldı)
function createRepechageBrackets(repechageLosers) {
  const brackets = [];
  const n = repechageLosers.length;
  if (n < 2) return brackets;

  console.log('createRepechageBrackets çağrıldı, repechageLosers:', n);

  // Tur başına maç sayıları (ör: n=4 -> [2,1])
  const matchesPerRound = [];
  let current = Math.ceil(n / 2);
  while (current >= 1) {
    matchesPerRound.push(current);
    if (current === 1) break;
    current = Math.ceil(current / 2);
  }

  let matchNumber = 1000;
  const roundStartIndex = [];
  let totalCreated = 0;

  // Turların maçlarını oluştur
  for (let r = 0; r < matchesPerRound.length; r++) {
    roundStartIndex[r] = totalCreated;
    for (let j = 0; j < matchesPerRound[r]; j++) {
      brackets.push({
        roundNumber: r + 1,
        matchNumber: matchNumber++,
        player1: null,
        player2: null,
        status: 'scheduled',
        winner: null,
        score: { player1Score: 0, player2Score: 0 },
        scheduledTime: null,
        completedAt: null,
        nextMatchNumber: null,
        nextMatchSlot: 'player1',
        notes: ''
      });
      totalCreated++;
    }
  }

  // Çocuk -> ebeveyn bağları ve slot ataması
  for (let r = 0; r < matchesPerRound.length - 1; r++) {
    const thisStart = roundStartIndex[r];
    const nextStart = roundStartIndex[r + 1];
    const thisCount = matchesPerRound[r];
    for (let i = 0; i < thisCount; i++) {
      const childIdx = thisStart + i;
      const parentIdx = nextStart + Math.floor(i / 2);
      brackets[childIdx].nextMatchNumber = brackets[parentIdx].matchNumber;
      brackets[childIdx].nextMatchSlot = (i % 2 === 0) ? 'player1' : 'player2';
    }
  }

  console.log('Oluşturulan repechage bracket sayısı:', brackets.length);
  return brackets;
}

// Loser bracket'te BYE olan maçları (tek oyunculu) otomatik tamamlar ve kazananı ilerletir
function autoCompleteByeInLoserBrackets(tournamentMatch) {
  let changed = false;
  const sorted = [...tournamentMatch.loserBrackets].sort((a, b) => a.roundNumber - b.roundNumber);
  const groups = {};
  for (const m of sorted) {
    if (!groups[m.roundNumber]) groups[m.roundNumber] = [];
    groups[m.roundNumber].push(m);
  }

  const rounds = Object.keys(groups).map(Number).sort((a, b) => a - b);
  for (const round of rounds) {
    const roundMatches = groups[round];
    const realMatches = roundMatches.filter(m => m.player1 && m.player2);
    const byeMatches  = roundMatches.filter(m => (m.player1 && !m.player2) || (!m.player1 && m.player2));

    const shouldAuto = (realMatches.length === 0) || realMatches.every(m => m.status === 'completed');
    if (byeMatches.length > 0 && shouldAuto) {
      for (const m of byeMatches) {
        if (m.status !== 'completed') {
          const winnerObj = m.player1 || m.player2;
          const winnerSlot = m.player1 ? 'player1' : 'player2';
          m.status = 'completed';
          m.winner = winnerSlot;
          m.completedAt = new Date();
          m.notes = addNoteOnce(m.notes, 'Otomatik geçiş - Repechage');
          if (m.nextMatchNumber && winnerObj) {
            const next = tournamentMatch.loserBrackets.find(x => x.matchNumber === m.nextMatchNumber);
            if (next) {
              if (m.nextMatchSlot === 'player1') next.player1 = winnerObj; else next.player2 = winnerObj;
            }
          }
          changed = true;
        }
      }
    }
  }
  return changed;
}

// Bronz maçlarını etiketler (iki şerit için son maçları 'Bronz A' ve 'Bronz B')
function labelBronzeMatches(loserBrackets) {
  if (!Array.isArray(loserBrackets) || loserBrackets.length === 0) return;

  // Tüm maçlardan eski "Bronz A/B" etiketlerini temizle
  for (const m of loserBrackets) {
    m.notes = String(m.notes || '')
      .replace(/(?:^|\s*\|\s*)Bronz A\b/gi, '')
      .replace(/(?:^|\s*\|\s*)Bronz B\b/gi, '')
      .replace(/(?:\s*\|\s*){2,}/g, ' | ')
      .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
      .trim();
  }

  // Şeritleri numara aralığına göre tespit et
  const laneA = loserBrackets.filter(m => m.matchNumber >= 1000 && m.matchNumber < 1100);
  const laneB = loserBrackets.filter(m => m.matchNumber >= 1100 && m.matchNumber < 1200);

  const lastOf = (arr) => {
    if (arr.length === 0) return null;
    return arr.reduce((best, cur) => {
      if (!best) return cur;
      if (cur.roundNumber > best.roundNumber) return cur;
      if (cur.roundNumber === best.roundNumber && cur.matchNumber > best.matchNumber) return cur;
      return best;
    }, null);
  };

  const finalA = loserBrackets.find(m => m.matchNumber === 1099) || lastOf(laneA);
  const finalB = loserBrackets.find(m => m.matchNumber === 1199) || lastOf(laneB);

  if (finalA) finalA.notes = addNoteOnce(finalA.notes, 'Bronz A');
  if (finalB) finalB.notes = addNoteOnce(finalB.notes, 'Bronz B');
}

// Loser bracket'te kazananları ilerletme
async function processLoserBracketAdvancement(tournamentMatch) {
  const sortedLoserBrackets = tournamentMatch.loserBrackets.sort((a, b) => a.roundNumber - b.roundNumber);
  
  for (let bracket of sortedLoserBrackets) {
    if (bracket.status === 'completed' && bracket.winner && bracket.nextMatchNumber) {
      const winner = bracket.winner === 'player1' ? bracket.player1 : bracket.player2;
      if (winner) {
        const nextMatch = sortedLoserBrackets.find(b => b.matchNumber === bracket.nextMatchNumber);
        if (nextMatch) {
          if (bracket.nextMatchSlot === 'player1') {
            if (!nextMatch.player1 || nextMatch.player1.participantId !== winner.participantId) nextMatch.player1 = winner;
          } else if (bracket.nextMatchSlot === 'player2') {
            if (!nextMatch.player2 || nextMatch.player2.participantId !== winner.participantId) nextMatch.player2 = winner;
          }
        }
      }
    }
  }
  
  await tournamentMatch.save();
}

// Belirli bir turnuva maçını getir
router.get("/:id", auth, async (req, res) => {
  try {
    const base = await TournamentMatch.findById(req.params.id)
      .populate({
        path: 'organisationId',
        select: 'tournamentName tournamentDate tournamentPlace'
      });

    if (!base) return res.status(404).json({ message: "Turnuva maçı bulunamadı" });

    const { body } = await ensureStateOnRead(base, { forceRebuild: true });
    res.set('Cache-Control', 'no-store');
    return res.json(body);
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
      // Single elimination veya double elimination maçını güncelle
      let match = tournamentMatch.brackets.find(m => m.matchNumber === parseInt(matchId));
      let isLoserBracket = false;
      
      // Eğer winner bracket'te bulunamazsa, loser bracket'te ara
      if (!match && tournamentMatch.tournamentType === 'double_elimination') {
        match = tournamentMatch.loserBrackets.find(m => m.matchNumber === parseInt(matchId));
        isLoserBracket = true;
      }
      
      if (!match) {
        return res.status(404).json({ message: "Maç bulunamadı" });
      }
      
      // Final guard: Repechage tamamlanmadan final tamamlanamaz
      const isWinnerFinal = !isLoserBracket && tournamentMatch.tournamentType === 'double_elimination' && (() => {
        const fm = findWinnerFinal(tournamentMatch.brackets || []);
        return fm && fm.matchNumber === parseInt(matchId, 10);
      })();
      if (isWinnerFinal) {
        // Guard öncesi repechage'ı kur/güncelle (gerekirse)
        await processDoubleEliminationLoserBrackets(tournamentMatch);
      }
      if (isWinnerFinal && (status === 'completed' || winner)) {
        const bronzesDone = areBronzesCompleted(tournamentMatch.loserBrackets || []);
        if (!bronzesDone) {
          return res.status(400).json({ message: "Repechage (Bronz A/B) tamamlanmadan final tamamlanamaz." });
        }
      }

      if (score) match.score = score;
      if (winner !== undefined) {
        if (winner !== 'player1' && winner !== 'player2') {
          return res.status(400).json({ message: "winner 'player1' veya 'player2' olmalı" });
        }
        match.winner = winner;
      }
      if (status) match.status = status;
      if (notes !== undefined) match.notes = notes;
      
      if (status === 'completed') {
        match.completedAt = new Date();
      }
      
      // Kazananı bir sonraki maça yerleştir
      if (winner && match.nextMatchNumber) {
        if (isLoserBracket) {
          // Loser bracket'te kazananı ilerlet (çifte yerleşimi önle)
          const nextMatch = tournamentMatch.loserBrackets.find(m => m.matchNumber === match.nextMatchNumber);
          const w = match[winner];
          if (nextMatch && w) {
            if (match.nextMatchSlot === 'player1') {
              if (!nextMatch.player1 || nextMatch.player1.participantId !== w.participantId) nextMatch.player1 = w;
            } else if (match.nextMatchSlot === 'player2') {
              if (!nextMatch.player2 || nextMatch.player2.participantId !== w.participantId) nextMatch.player2 = w;
            }
          }
        } else {
          // Winner bracket'te kazananı ilerlet
          if (typeof tournamentMatch.advanceWinner === 'function') {
            tournamentMatch.advanceWinner(parseInt(matchId, 10));
          } else {
            // Fallback: bir sonraki maçı bul ve slot’a yerleştir (çifte yerleşimi önle)
            const m = tournamentMatch.brackets.find(m => m.matchNumber === parseInt(matchId, 10));
            if (m?.nextMatchNumber) {
              const next = tournamentMatch.brackets.find(b => b.matchNumber === m.nextMatchNumber);
              const w = m[winner];
              if (next && w) {
                if (m.nextMatchSlot === 'player1') {
                  if (!next.player1 || next.player1.participantId !== w.participantId) next.player1 = w;
                } else if (m.nextMatchSlot === 'player2') {
                  if (!next.player2 || next.player2.participantId !== w.participantId) next.player2 = w;
                }
              }
            }
          }
        }
      }
    }

    await tournamentMatch.save();
    
    // Güncellenmiş turnuvayı döndür (displayNumber ile)
    const updatedMatch = await TournamentMatch.findById(id)
      .populate({
        path: 'organisationId',
        select: 'tournamentName tournamentDate tournamentPlace'
      });

    const stats = updatedMatch.getStats();
    const baseObj = updatedMatch.toObject();
    const withDisplay = attachDisplayNumbers(baseObj);
    res.json({ ...withDisplay, stats });
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