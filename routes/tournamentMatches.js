const express = require("express");
const router = express.Router();
const TournamentMatch = require("../models/tournamentMatch");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const auth = require("../middleware/auth");
  
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
  
// --- OKU VE DÜZELT: GET isteklerinde state'i finalize et ve tek tip obje döndür ---
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
  
      if (changed) await tournamentMatch.save();
  
            const fresh = await TournamentMatch.findById(tournamentMatch._id).populate({
        path: 'organisationId',
        select: 'tournamentName tournamentDate tournamentPlace'
      });

      const stats = fresh.getStats();
      const baseObj = fresh.toObject();
      
             // Double elimination için displayNumber'ları burada tekrar ata
       if (baseObj.tournamentType === 'double_elimination') {
         console.log('ensureStateOnRead: DisplayNumber\'lar atanıyor...');
         
         let displayCounter = 1;
         
         // Round 1: Winner bracket
         const round1Matches = baseObj.brackets.filter(b => b.roundNumber === 1);
         for (const match of round1Matches) {
           match.displayNumber = displayCounter++;
         }
         
         // Round 1: Loser bracket
         for (const match of baseObj.loserBrackets || []) {
           match.displayNumber = displayCounter++;
         }
         
         // Round 2: Winner bracket
         const round2Matches = baseObj.brackets.filter(b => b.roundNumber === 2);
         for (const match of round2Matches) {
           match.displayNumber = displayCounter++;
         }
         
         // Round 3: Winner bracket Final
         const finalMatches = baseObj.brackets.filter(b => b.roundNumber === 3);
         for (const match of finalMatches) {
           match.displayNumber = displayCounter++;
         }
         
         console.log(`ensureStateOnRead: Toplam ${displayCounter - 1} maç için displayNumber atandı`);
         console.log('ensureStateOnRead: Loser bracket displayNumber\'ları:');
         for (const match of baseObj.loserBrackets || []) {
           console.log(`  Match ${match.matchNumber}: displayNumber = ${match.displayNumber}`);
         }
       }
       
       // attachDisplayNumbers devre dışı - yukarıda zaten doğru displayNumber'lar atanıyor
       // const withDisplay = attachDisplayNumbers(baseObj);
       const withDisplay = baseObj; // Direkt baseObj'yi kullan
       return { body: { ...withDisplay, stats }, fresh };
    } catch (err) {
      console.error('ensureStateOnRead hatası:', err);
      const stats = tournamentMatch.getStats();
      // attachDisplayNumbers devre dışı
      // const withDisplay = attachDisplayNumbers(tournamentMatch.toObject());
      const withDisplay = tournamentMatch.toObject(); // Direkt toObject() kullan
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
    console.log('=== DOUBLE ELIMINATION TURNUVA ===');
    console.log('Tournament Type:', tournamentMatch.tournamentType);
    
    // Round 1'deki kaybedenleri topla
    const round1Losers = [];
    for (const bracket of sortedBrackets) {
      if (bracket.roundNumber === 1 && bracket.status === 'completed' && bracket.winner) {
        // BYE maçı mı kontrol et (bir oyuncu null ise BYE maçıdır)
        const isByeMatch = !bracket.player1 || !bracket.player2;
        
        if (!isByeMatch) {
          // Normal maç - kaybedeni bul
          const loser = bracket.winner === 'player1' ? bracket.player2 : bracket.player1;
          if (loser) {
            round1Losers.push(loser);
            console.log(`Round 1, Match ${bracket.matchNumber}: Kaybeden: ${loser.name || 'Bilinmeyen'}`);
          }
        } else {
          // BYE maçı - BYE kaybeden olarak sayılır ve kazananla eşleşir
          const winner = bracket.winner === 'player1' ? bracket.player1 : bracket.player2;
          if (winner) {
            // BYE'yi kaybeden olarak ekle (null olarak)
            round1Losers.push(null); // BYE placeholder
            console.log(`Round 1, Match ${bracket.matchNumber}: BYE maçı - ${winner.name || 'Bilinmeyen'} geçti, BYE kaybeden olarak eklendi`);
          }
        }
      }
    }
    
    console.log(`Round 1'de toplam ${round1Losers.length} kaybeden var`);
    
    // Her GET'te loser bracket'i tamamen sil ve yeniden oluştur
    if (round1Losers.length > 0) {
      console.log('Loser bracket tamamen siliniyor ve yeniden oluşturuluyor...');
      
      // Loser bracket'i tamamen temizle
      tournamentMatch.loserBrackets = [];
      
      // Round 1 kaybedenlerini iki şeritte eşleştir
      const newLoserMatches = [];
      let matchNumberA = 1000; // Şerit A: 1000-1099
      let matchNumberB = 1100; // Şerit B: 1100-1199
      
      // Kaybedenleri iki gruba böl
      const midPoint = Math.ceil(round1Losers.length / 2);
      const laneA = round1Losers.slice(0, midPoint);
      const laneB = round1Losers.slice(midPoint);
      
      console.log(`Şerit A'ya ${laneA.length} oyuncu, Şerit B'ye ${laneB.length} oyuncu atanıyor...`);
      
      // Şerit A: Kaybedenleri eşleştir
      if (laneA.length > 0) {
        for (let i = 0; i < laneA.length; i += 2) {
          const player1 = laneA[i];
          const player2 = laneA[i + 1] || null;
          
          const match = {
        roundNumber: 1,
            matchNumber: matchNumberA++,
            player1: player1,
            player2: player2,
        status: 'scheduled',
        winner: null,
        score: { player1Score: 0, player2Score: 0 },
        scheduledTime: null,
        completedAt: null,
        nextMatchNumber: null,
        nextMatchSlot: 'player1',
            notes: 'Şerit A - Round 1 Repechage'
          };
          
          newLoserMatches.push(match);
          if (player1 === null) {
            console.log(`Şerit A - Match ${match.matchNumber}: BYE vs ${player2 ? player2.name : 'Bilinmeyen'}`);
          } else if (player2 === null) {
            console.log(`Şerit A - Match ${match.matchNumber}: ${player1.name || 'Bilinmeyen'} vs BYE`);
          } else {
            console.log(`Şerit A - Match ${match.matchNumber}: ${player1.name || 'Bilinmeyen'} vs ${player2.name || 'Bilinmeyen'}`);
          }
        }
      }
      
      // Şerit B: Kaybedenleri eşleştir
      if (laneB.length > 0) {
        for (let i = 0; i < laneB.length; i += 2) {
          const player1 = laneB[i];
          const player2 = laneB[i + 1] || null;
          
          const match = {
            roundNumber: 1,
            matchNumber: matchNumberB++,
            player1: player1,
            player2: player2,
          status: 'scheduled',
          winner: null,
          score: { player1Score: 0, player2Score: 0 },
          scheduledTime: null,
          completedAt: null,
          nextMatchNumber: null,
          nextMatchSlot: 'player1',
            notes: 'Şerit B - Round 1 Repechage'
          };
          
          newLoserMatches.push(match);
          if (player1 === null) {
            console.log(`Şerit B - Match ${match.matchNumber}: BYE vs ${player2 ? player2.name : 'Bilinmeyen'}`);
          } else if (player2 === null) {
            console.log(`Şerit B - Match ${match.matchNumber}: ${player1.name || 'Bilinmeyen'} vs BYE`);
      } else {
            console.log(`Şerit B - Match ${match.matchNumber}: ${player1.name || 'Bilinmeyen'} vs ${player2.name || 'Bilinmeyen'}`);
          }
        }
      }
      
      // Tek oyunculu maçları otomatik tamamla
      for (const match of newLoserMatches) {
        if (match.player2 === null) { // Tek oyunculu maç
      match.status = 'completed';
          match.winner = 'player1';
      match.completedAt = new Date();
          match.notes = match.notes + ' | Otomatik geçiş - Tek oyuncu';
          console.log(`Match ${match.matchNumber} otomatik tamamlandı: ${match.player1.name || 'Bilinmeyen'} geçti`);
        }
      }
      
             // Yeni loser bracket'i ata
       tournamentMatch.loserBrackets = newLoserMatches;
       hasChanges = true;
       console.log(`${newLoserMatches.length} adet yeni loser match oluşturuldu`);
       
       // DisplayNumber'ları düzenle - Round bazında sıralama
       console.log('DisplayNumber\'lar düzenleniyor...');
       console.log('Loser bracket maç sayısı:', tournamentMatch.loserBrackets.length);
       let displayCounter = 1;
       
       // Round 1: Önce winner bracket, sonra loser bracket
       console.log('=== ROUND 1 ===');
       
       // Winner bracket Round 1 maçları
       const round1Matches = sortedBrackets.filter(b => b.roundNumber === 1);
       console.log(`Winner Round 1 maç sayısı: ${round1Matches.length}`);
       for (const match of round1Matches) {
         match.displayNumber = displayCounter++;
         console.log(`Winner Round 1 Match ${match.matchNumber}: displayNumber = ${match.displayNumber}`);
       }
       
       // Loser bracket Round 1 maçları
       console.log(`Loser bracket maçları işleniyor...`);
       for (const match of tournamentMatch.loserBrackets) {
         match.displayNumber = displayCounter++;
         console.log(`Loser Round 1 Match ${match.matchNumber}: displayNumber = ${match.displayNumber} (displayCounter: ${displayCounter-1})`);
       }
       
       // Round 2: Winner bracket Round 2 maçları
       console.log('=== ROUND 2 ===');
       
       // Winner bracket Round 2 maçları
       const round2Matches = sortedBrackets.filter(b => b.roundNumber === 2);
       console.log(`Winner Round 2 maç sayısı: ${round2Matches.length}`);
       for (const match of round2Matches) {
         match.displayNumber = displayCounter++;
         console.log(`Winner Round 2 Match ${match.matchNumber}: displayNumber = ${match.displayNumber}`);
       }
       
       // Round 3: Winner bracket Final
       console.log('=== ROUND 3 ===');
       
       // Winner bracket Final (Round 3)
       const finalMatches = sortedBrackets.filter(b => b.roundNumber === 3);
       console.log(`Winner Final maç sayısı: ${finalMatches.length}`);
       for (const match of finalMatches) {
         match.displayNumber = displayCounter++;
         console.log(`Winner Final Match ${match.matchNumber}: displayNumber = ${match.displayNumber}`);
       }
       
       console.log(`Toplam ${displayCounter - 1} maç için displayNumber atandı`);
       console.log('Loser bracket maçlarının son displayNumber değerleri:');
       for (const match of tournamentMatch.loserBrackets) {
         console.log(`Match ${match.matchNumber}: displayNumber = ${match.displayNumber}`);
       }
     }
     
     console.log('================================');
  }
  
  // Değişiklikler varsa kaydet
  console.log('hasChanges değeri:', hasChanges);
  if (hasChanges) {
    tournamentMatch.brackets = sortedBrackets;
    console.log('Değişiklikler kaydediliyor...');
    
    // Kaydetmeden önce displayNumber'ları kontrol et
    console.log('Kaydetmeden önce loser bracket displayNumber\'ları:');
    for (const match of tournamentMatch.loserBrackets) {
      console.log(`Match ${match.matchNumber}: displayNumber = ${match.displayNumber}`);
    }
    
    await tournamentMatch.save();
    console.log('Değişiklikler kaydedildi');
    
    // Kaydettikten sonra displayNumber'ları kontrol et
    console.log('Kaydettikten sonra loser bracket displayNumber\'ları:');
    for (const match of tournamentMatch.loserBrackets) {
      console.log(`Match ${match.matchNumber}: displayNumber = ${match.displayNumber}`);
    }
  } else {
    console.log('Değişiklik yok, kaydetme yapılmadı');
  }
  
  return tournamentMatch;
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

// Belirli bir maçın detaylarını getir
router.get("/:id/matches/:matchId", auth, async (req, res) => {
  try {
    const { id, matchId } = req.params;

    const tournamentMatch = await TournamentMatch.findById(id)
      .populate({
        path: 'organisationId',
        select: 'tournamentName tournamentDate tournamentPlace'
      });
    
    if (!tournamentMatch) {
      return res.status(404).json({ message: "Turnuva maçı bulunamadı" });
    }

    let match = null;
    let matchType = null;
    let roundInfo = null;

    if (tournamentMatch.tournamentType === 'round_robin') {
      // Round robin maçını bul
      for (let round of tournamentMatch.rounds) {
        const foundMatch = round.matches.find(m => m.matchId === matchId);
        if (foundMatch) {
          match = foundMatch;
          matchType = 'round_robin';
          roundInfo = {
            roundNumber: round.roundNumber,
            totalMatches: round.matches.length
          };
          break;
        }
      }
    } else {
      // Single/Double elimination maçını bul
      match = tournamentMatch.brackets.find(m => m.matchNumber === parseInt(matchId));
      matchType = 'elimination';
      
      if (match) {
        roundInfo = {
          roundNumber: match.roundNumber,
          nextMatchNumber: match.nextMatchNumber,
          nextMatchSlot: match.nextMatchSlot
        };
      } else if (tournamentMatch.tournamentType === 'double_elimination') {
        // Loser bracket'te ara
        match = tournamentMatch.loserBrackets.find(m => m.matchNumber === parseInt(matchId));
        if (match) {
          matchType = 'loser_bracket';
          roundInfo = {
            roundNumber: match.roundNumber,
            nextMatchNumber: match.nextMatchNumber,
            nextMatchSlot: match.nextMatchSlot
          };
        }
      }
    }
    
    if (!match) {
      return res.status(404).json({ message: "Maç bulunamadı" });
    }

    // Maç detaylarını formatla
    const matchDetails = {
      matchId: matchId,
      matchType: matchType,
      tournamentInfo: {
        tournamentId: tournamentMatch._id,
        tournamentName: tournamentMatch.organisationId?.tournamentName || 'Bilinmeyen Turnuva',
        tournamentDate: tournamentMatch.organisationId?.tournamentDate,
        tournamentPlace: tournamentMatch.organisationId?.tournamentPlace,
        weightCategory: tournamentMatch.weightCategory,
        gender: tournamentMatch.gender,
        tournamentType: tournamentMatch.tournamentType
      },
      roundInfo: roundInfo,
      players: {
        player1: match.player1 ? {
          name: match.player1.name || 'Bilinmeyen',
          city: match.player1.city || '',
          club: match.player1.club || '',
          participantId: match.player1.participantId
        } : null,
        player2: match.player2 ? {
          name: match.player2.name || 'Bilinmeyen',
          city: match.player2.city || '',
          club: match.player2.club || '',
          participantId: match.player2.participantId
        } : null
      },
      matchStatus: {
        status: match.status || 'scheduled',
        winner: match.winner || null,
        score: match.score || { player1Score: 0, player2Score: 0 },
        scheduledTime: match.scheduledTime || null,
        completedAt: match.completedAt || null,
        notes: match.notes || ''
      },
      isByeMatch: !match.player1 || !match.player2,
      displayNumber: match.displayNumber || match.matchNumber
    };

    res.json(matchDetails);
  } catch (error) {
    console.error("Maç detayları getirme hatası:", error);
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
            // Fallback: bir sonraki maçı bul ve slot'a yerleştir (çifte yerleşimi önle)
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
    
    // Mat assignment status'larını güncelle
    try {
      const MatAssignment = require("../models/matAssignment");
      
      // Güncellenen maçın assignment'ını bul
      let assignmentFilter = {
        organisationId: tournamentMatch.organisationId,
        tournamentMatchId: tournamentMatch._id
      };
      
      if (tournamentMatch.tournamentType === 'round_robin') {
        assignmentFilter['matchIdentifier.roundRobinMatchId'] = matchId;
      } else {
        assignmentFilter['matchIdentifier.eliminationMatchNumber'] = parseInt(matchId);
        // Loser bracket kontrolü
        if (tournamentMatch.tournamentType === 'double_elimination') {
          const isLoserBracket = tournamentMatch.loserBrackets.some(m => m.matchNumber === parseInt(matchId));
          assignmentFilter['matchIdentifier.isLoserBracket'] = isLoserBracket;
        }
      }
      
      const assignment = await MatAssignment.findOne(assignmentFilter);
      if (assignment) {
        // Assignment status'unu maç durumuna göre güncelle
        if (status === 'completed' && assignment.status !== 'completed') {
          assignment.status = 'completed';
          assignment.completedAt = new Date();
          await assignment.save();
          console.log(`Assignment ${assignment._id} status'u 'completed' olarak güncellendi`);
        } else if (status === 'in_progress' && assignment.status !== 'in_progress') {
          assignment.status = 'in_progress';
          assignment.startedAt = new Date();
          await assignment.save();
          console.log(`Assignment ${assignment._id} status'u 'in_progress' olarak güncellendi`);
        } else if (status === 'scheduled' && assignment.status === 'completed') {
          assignment.status = 'assigned';
          assignment.completedAt = null;
          assignment.startedAt = null;
          await assignment.save();
          console.log(`Assignment ${assignment._id} status'u 'assigned' olarak güncellendi`);
        }
      }
    } catch (assignmentError) {
      console.error("Assignment status güncelleme hatası:", assignmentError);
      // Assignment hatası ana işlemi etkilemesin
    }
    
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