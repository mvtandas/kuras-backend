const express = require("express");
const router = express.Router();
const TournamentMatch = require("../models/tournamentMatch");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const auth = require("../middleware/auth");
// const mongoose = require('mongoose'); // not used

// ======== IJF Repechage (aynı-yarı) – türet/uzlaştır yardımcıları ========

function isCompleted(m){ return m && m.status==='completed' && (m.winner==='player1'||m.winner==='player2'); }
function loserOf(m){ return isCompleted(m) ? (m.winner==='player1'? m.player2 : m.player1) : null; }
function winnerOf(m){ return isCompleted(m) ? (m.winner==='player1'? m.player1 : m.player2) : null; }
function nextPow2(x){ return Math.pow(2, Math.ceil(Math.log2(Math.max(1, x)))); }

function inferDrawSizeFromWB(wb){
  if (!Array.isArray(wb) || !wb.length) return 0;
  const firstRoundMatches = wb.filter(m => m.roundNumber === 1).length;
  const N = firstRoundMatches * 2;
  return nextPow2(Math.max(2, N));
}

function findWBFinalSemis(wb){
  if (!wb?.length) return { final:null, semis:[], maxRound:0 };
  const maxR = Math.max(...wb.map(x=>x.roundNumber||0));
  const final = wb.find(m=>m.roundNumber===maxR && !m.nextMatchNumber) || null;
  const semis = wb
    .filter(m=>m.roundNumber===maxR-1 && m.player1 && m.player2)
    .sort((a,b)=>a.matchNumber-b.matchNumber);
  return { final, semis, maxRound:maxR };
}

// finalist'in kazandığı tüm WB maçlarındaki kaybedenleri (erken tur önce) döndür
function collectLosersToFinalist(wb, finalistPlayer){
  if (!finalistPlayer?.participantId) return [];
  const won = wb
    .filter(m => isCompleted(m) && winnerOf(m)?.participantId === finalistPlayer.participantId && m.player1 && m.player2)
    .sort((a,b)=>(a.roundNumber-b.roundNumber)||(a.matchNumber-b.matchNumber));
  return won
    .map(m => ({ player: loserOf(m), fromMatch: m.matchNumber, roundNumber: m.roundNumber }))
    .filter(x => x.player?.participantId);
}

// Semi A kazananı → Repechage A havuzu, Semi B kazananı → Repechage B havuzu
// Semi kaybedenleri havuzdan çıkar (onlar bronzda bekleyecek)
function buildSameSidePools(wb, semis){
  const [semiA, semiB] = semis;

  const semiAWinner = (semiA.status==='completed' && semiA.winner) ? semiA[semiA.winner] : null;
  const semiBWinner = (semiB.status==='completed' && semiB.winner) ? semiB[semiB.winner] : null;

  const semiALoser  = (semiA.status==='completed' && semiA.winner) ? semiA[semiA.winner==='player1' ? 'player2':'player1'] : null;
  const semiBLoser  = (semiB.status==='completed' && semiB.winner) ? semiB[semiB.winner==='player1' ? 'player2':'player1'] : null;

  const poolA = semiAWinner ? collectLosersToFinalist(wb, semiAWinner) : [];
  const poolB = semiBWinner ? collectLosersToFinalist(wb, semiBWinner) : [];

  const norm = arr => arr.sort((a,b)=>(a.roundNumber-b.roundNumber)||(a.fromMatch-b.fromMatch)).map(x=>x.player);

  // yarı final kaybedenlerini havuzdan çıkar
  const stripSemiLoser = (list, semiLoser) => {
    if (!semiLoser?.participantId) return list;
    return list.filter(p => p?.participantId !== semiLoser.participantId);
  };

  return {
    poolA: stripSemiLoser(norm(poolA), semiALoser),
    poolB: stripSemiLoser(norm(poolB), semiBLoser),
    semiALoser, semiBLoser
  };
}

// statik şerit topolojisi (1000-1098; 1099 = şerit final/bz öncesi düğüm)
function buildStaticLaneTopology(startNumber, entrantsCapacity){
  const cap = nextPow2(Math.max(1, entrantsCapacity));
  const rounds = [];
  let layer = Math.ceil(cap/2);
  while (true){ rounds.push(layer); if (layer<=1) break; layer = Math.ceil(layer/2); }

  const lane = startNumber===1000 ? 'A':'B';
  const matches=[]; const flat=[]; let cur=startNumber;

  for (let r=0;r<rounds.length;r++){
    const arr=[];
    for (let i=0;i<rounds[r];i++){
      const mm = {
        roundNumber: r+1, matchNumber: cur++,
        player1:null, player2:null, lane,
        status:'scheduled', winner:null,
        score:{player1Score:0, player2Score:0},
        scheduledTime:null, completedAt:null,
        nextMatchNumber:null, nextMatchSlot:(i%2===0?'player1':'player2'),
        notes:''
      };
      matches.push(mm); arr.push(mm);
    }
    flat.push(arr);
  }

  // şerit finali
  const laneFinal = {
    roundNumber: rounds.length+1, matchNumber: startNumber+99,
    player1:null, player2:null, lane,
    status:'scheduled', winner:null,
    score:{player1Score:0, player2Score:0},
    scheduledTime:null, completedAt:null,
    nextMatchNumber:null, nextMatchSlot:'player1',
    notes:''
  };
  matches.push(laneFinal);

  // bağlar
  for (let r=0;r<flat.length;r++){
    const arr=flat[r];
    if (r===flat.length-1){
      for (let i=0;i<arr.length;i++){
        arr[i].nextMatchNumber = startNumber+99;
        arr[i].nextMatchSlot   = (i%2===0?'player1':'player2');
      }
    } else {
      const nxt=flat[r+1];
      for (let i=0;i<arr.length;i++){
        const nextIdx=Math.floor(i/2);
        arr[i].nextMatchNumber=nxt[nextIdx].matchNumber;
        arr[i].nextMatchSlot  =(i%2===0?'player1':'player2');
      }
    }
  }
  return matches;
}

function buildStaticRepechageTopologyFromWB(wb){
  const N = inferDrawSizeFromWB(wb);
  if (!N || N<2) return [];
  const half = N/2;
  const perLaneCapacity = Math.max(1, half-1); // finalist hariç
  return [
    ...buildStaticLaneTopology(1000, perLaneCapacity),
    ...buildStaticLaneTopology(1100, perLaneCapacity),
  ];
}

// 1. tur slotlarına sırayla yerleştir
function placeLaneEntrants(lb, lane, entrants){
  const firstRound = lb
    .filter(m => (m.matchNumber>= (lane==='A'?1000:1100)) && (m.matchNumber< (lane==='A'?1100:1200)) && m.roundNumber===1 && m.matchNumber!==(lane==='A'?1099:1199))
    .sort((a,b)=>a.matchNumber-b.matchNumber);
  let idx=0;
  for (const m of firstRound){
    if (idx<entrants.length && !m.player1) m.player1 = entrants[idx++];
    if (idx<entrants.length && !m.player2) m.player2 = entrants[idx++];
    if (idx>=entrants.length) break;
  }
}

// BYE otomatik ileri
function autoAdvanceByesIn(lb){
  const byNum = Object.fromEntries(lb.map(m=>[m.matchNumber,m]));
  const ordered = [...lb].sort((a,b)=>(a.roundNumber-b.roundNumber)||(a.matchNumber-b.matchNumber));
  for (const m of ordered){
    const has1=!!m.player1, has2=!!m.player2;
    if ((has1 ^ has2) && m.status!=='completed'){
      const winnerSlot = has1 ? 'player1' : 'player2';
      const winnerObj  = has1 ? m.player1 : m.player2;
      m.status='completed'; m.winner=winnerSlot; m.completedAt=new Date();
      m.notes = addNoteOnce(m.notes,'Otomatik BYE');
      if (m.nextMatchNumber){
        const nxt=byNum[m.nextMatchNumber];
        if (nxt){ (m.nextMatchSlot==='player1' ? (nxt.player1=winnerObj) : (nxt.player2=winnerObj)); }
      }
    }
  }
}

// Bronz bağları: aynı yarı
function attachBronzesSameSide(lb, semiALoser, semiBLoser){
  const bronzeA = lb.find(m => m.matchNumber===1099);
  const bronzeB = lb.find(m => m.matchNumber===1199);
  if (bronzeA){ bronzeA.notes = addNoteOnce(bronzeA.notes,'Bronz A'); if (semiALoser) bronzeA.player2 = semiALoser; }
  if (bronzeB){ bronzeB.notes = addNoteOnce(bronzeB.notes,'Bronz B'); if (semiBLoser) bronzeB.player2 = semiBLoser; }
}

// saved LB ile türetileni uzlaştır (topoloji derived, skorlar uyumluysa korunur)
function reconcileLB(savedLB, derivedLB){
  const dMap = new Map(derivedLB.map(m => [m.matchNumber, m]));
  const sMap = new Map(savedLB.map(m => [m.matchNumber, m]));
  const merged = [];

  for (const [no, d] of dMap.entries()){
    const s = sMap.get(no);
    if (!s){
      merged.push({ ...d });
      continue;
    }

    const base = {
      roundNumber: d.roundNumber, matchNumber: d.matchNumber,
      nextMatchNumber: d.nextMatchNumber, nextMatchSlot: d.nextMatchSlot,
      notes: d.notes || s.notes || ''
    };

    let m = {
      ...base,
      player1: d.player1 || null,
      player2: d.player2 || null,
      status: 'scheduled', winner: null,
      score: { player1Score:0, player2Score:0 },
      scheduledTime: s.scheduledTime || null,
      completedAt: null,
    };

    const sameP1 = s.player1?.participantId && m.player1?.participantId && s.player1.participantId===m.player1.participantId;
    const sameP2 = s.player2?.participantId && m.player2?.participantId && s.player2.participantId===m.player2.participantId;
    const sameSet = (sameP1 || (!s.player1 && !m.player1)) && (sameP2 || (!s.player2 && !m.player2));

    if (sameSet && isCompleted(s)){
      m.status='completed'; m.winner=s.winner; m.score=s.score||{player1Score:0,player2Score:0};
      m.completedAt=s.completedAt||new Date(); m.notes=s.notes||m.notes;
    } else if (!sameSet && (s.player1||s.player2||isCompleted(s))){
      m.notes = addNoteOnce(m.notes, 'LB re-sync: önceki sonuç/yerleşim geçersiz kılındı');
    } else {
      m.notes = s.notes || m.notes;
    }

    merged.push(m);
  }
  return merged;
}

// GET'te: WB'den doğru LB üret, kayıtlı LB ile uzlaştır, BYE ve bronzları bağla
function maintainLBOnRead_SameSide(wb, savedLB){
  const staticLB = buildStaticRepechageTopologyFromWB(wb);
  if (!staticLB.length){
    return { lb: [], changed: (savedLB?.length||0) > 0, reason: 'no-topology' };
  }

  const { semis } = findWBFinalSemis(wb);

  // semiler yoksa boş topoloji ile hizala
  if (semis.length < 2){
    const merged = reconcileLB(savedLB||[], staticLB);
    return { lb: merged, changed: JSON.stringify(savedLB||[])!==JSON.stringify(merged), reason: 'semis-not-ready' };
  }

  // finalist havuzlarını kur
  const { poolA, poolB, semiALoser, semiBLoser } = buildSameSidePools(wb, semis);

  const derived = JSON.parse(JSON.stringify(staticLB));
  placeLaneEntrants(derived, 'A', poolA);
  placeLaneEntrants(derived, 'B', poolB);
  autoAdvanceByesIn(derived);
  attachBronzesSameSide(derived, semiALoser, semiBLoser);

  const merged = reconcileLB(savedLB||[], derived);
  autoAdvanceByesIn(merged);
  attachBronzesSameSide(merged, semiALoser, semiBLoser);

  const changed = JSON.stringify(savedLB||[]) !== JSON.stringify(merged);
  return { lb: merged, changed, reason: changed ? 'reconciled' : 'ok' };
}

// --- HELPERS: notes için idempotent ekleme ---
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addNoteOnce(existing, label) {
  const e = String(existing || '').trim();
  const pat = new RegExp(`(?:^|\\s*\\|\\s*)${escapeRegExp(label)}\\b`, 'gi');
  const cleaned = e
    .replace(pat, '')
    .replace(/(?:\s*\|\s*){2,}/g, ' | ')
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
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
  const finalMatch = wb.find(m => m.roundNumber === maxRound && !m.nextMatchNumber);

  // 1) winner bracket (final hariç)
  for (const m of wb) {
    if (finalMatch && m.matchNumber === finalMatch.matchNumber) continue;
    map[m.matchNumber] = c++;
  }

  // 2) Final en sonda, losers'ın mevcut display'ine göre
  const losersMax = Math.max(0, ...(tmObj.loserBrackets||[]).map(x => x.displayNumber || 0));
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
  
  // IJF tarzı: 1099 ve 1199 numaralı maçlar bronz maçları
  const bronzeA = loserBrackets.find(m => m.matchNumber === 1099);
  const bronzeB = loserBrackets.find(m => m.matchNumber === 1199);

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

// --- OKU VE DÜZELT: GET isteklerinde state'i finalize et ve tek tip obje döndür ---
async function ensureStateOnRead(tournamentMatch, { forceRebuild = true } = {}) {
  try {
    let changed = false;
    
    // IJF Repechage sistemi - sadece liste döndür
    if (tournamentMatch.tournamentType === 'double_elimination') {
      console.log('IJF Repechage listesi oluşturuluyor...');
      const ijfList = getSimpleIJFRepechage(tournamentMatch.brackets || []);
      
      // Turnuva objesine IJF listesini ekle
      tournamentMatch.ijfRepechageList = ijfList;
      changed = true;
    }
    
    // Basit işlemler
    tournamentMatch = await processAdvancement(tournamentMatch);
    
    if (changed) {
      console.log('Turnuva IJF listesi ile güncellendi, kaydediliyor...');
      await tournamentMatch.save();
    }
    
    const fresh = await TournamentMatch.findById(tournamentMatch._id).populate({
      path: 'organisationId',
      select: 'tournamentName tournamentDate tournamentPlace'
    });
    
    const stats = fresh.getStats();
    const baseObj = fresh.toObject();
    const withDisplay = attachDisplayNumbers(baseObj);
    
    return { body: { ...withDisplay, stats }, fresh, changed };
  } catch (error) {
    console.error('ensureStateOnRead hatası:', error);
    const stats = tournamentMatch.getStats();
    const withDisplay = attachDisplayNumbers(tournamentMatch.toObject());
    return { body: { ...withDisplay, stats }, fresh: tournamentMatch, changed: false };
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

        // LB statik topolojiyi baştan kur ve kaydet (slotlar boş)
        const staticLB = buildRepechageTopology(tournamentBrackets);
        tournamentLoserBrackets = staticLB;
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
          
          // Manuel WB geldiğinde de statik LB topolojisi kur
          const staticLB = buildRepechageTopology(tournamentBrackets);
          tournamentLoserBrackets = staticLB;
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
  
  // Double elimination için loser bracket artık GET'te maintainLBOnRead_SameSide ile yönetiliyor
  // await processDoubleEliminationLoserBrackets(tournamentMatch);
  
  // Değişiklikler varsa kaydet
  if (hasChanges) {
    tournamentMatch.brackets = sortedBrackets;
    await tournamentMatch.save();
  }
  
  return tournamentMatch;
}

// Artık kullanılmayan processDoubleEliminationLoserBrackets fonksiyonu kaldırıldı
// LB artık maintainLBOnRead_SameSide ile yönetiliyor



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

// Bronz maçlarını etiketler (IJF tarzı iki şerit için)
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

  // IJF tarzı: 1099 ve 1199 numaralı maçlar bronz maçları
  const bronzeA = loserBrackets.find(m => m.matchNumber === 1099);
  const bronzeB = loserBrackets.find(m => m.matchNumber === 1199);

  if (bronzeA) bronzeA.notes = addNoteOnce(bronzeA.notes, 'Bronz A');
  if (bronzeB) bronzeB.notes = addNoteOnce(bronzeB.notes, 'Bronz B');
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
        // Guard öncesi repechage artık GET mantığı ile yönetiliyor
        // await processDoubleEliminationLoserBrackets(tournamentMatch);
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
    
    // Güncellenmiş turnuvayı döndür (displayNumber ile)
    const updatedMatch = await TournamentMatch.findById(id)
      .populate({
        path: 'organisationId',
        select: 'tournamentName tournamentDate tournamentPlace'
      });

    // WB ilerletme sonrası LB'yi de GET mantığı ile düzelt
    if (updatedMatch.tournamentType === 'double_elimination') {
      const chk = maintainLoserBrackets(updatedMatch.brackets || [], updatedMatch.loserBrackets || []);
      if (chk.changed) { updatedMatch.loserBrackets = chk.lb; await updatedMatch.save(); }
      else { updatedMatch.loserBrackets = chk.lb; }
    }

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

// ======== YENİ: Temiz Double-Elimination Repechage Sistemi ========

// Temel yardımcı fonksiyonlar
function isCompleted(match) { 
  return match && match.status === 'completed' && (match.winner === 'player1' || match.winner === 'player2'); 
}

function getWinner(match) { 
  return isCompleted(match) ? match[match.winner] : null; 
}

function getLoser(match) { 
  return isCompleted(match) ? match[match.winner === 'player1' ? 'player2' : 'player1'] : null; 
}

function nextPowerOf2(n) { 
  return Math.pow(2, Math.ceil(Math.log2(Math.max(2, n)))); 
}

// Winner bracket'ten draw size hesapla
function getDrawSize(wb) {
  if (!Array.isArray(wb) || wb.length === 0) return 0;
  const firstRoundMatches = wb.filter(m => m.roundNumber === 1).length;
  return nextPowerOf2(firstRoundMatches * 2);
}

// Winner bracket'ten final ve yarı final maçlarını bul
function getWBFinalAndSemis(wb) {
  if (!wb?.length) return { final: null, semis: [], maxRound: 0 };
  
  const maxRound = Math.max(...wb.map(m => m.roundNumber || 0));
  
  // Final: En yüksek round'da ve nextMatchNumber'ı olmayan maç
  const final = wb.find(m => m.roundNumber === maxRound && !m.nextMatchNumber);
  
  // Yarı final: Final'den bir önceki round'da ve her iki oyuncusu da olan maçlar
  const semis = wb
    .filter(m => m.roundNumber === maxRound - 1 && m.player1 && m.player2)
    .sort((a, b) => a.matchNumber - b.matchNumber);
  
  return { final, semis, maxRound };
}

// Finalist'e kaybeden tüm oyuncuları topla (erken tur önce)
// IJF tarzı: Sadece yarı finalistlere kaybedenleri topla
function collectLosersToFinalist(wb, finalist) {
  if (!finalist?.participantId) return [];
  
  const losers = [];
  for (const match of wb) {
    if (!isCompleted(match) || !match.player1 || !match.player2) continue;
    
    const winner = getWinner(match);
    if (winner?.participantId === finalist.participantId) {
      const loser = getLoser(match);
      if (loser?.participantId) {
        losers.push({
          player: loser,
          fromMatch: match.matchNumber,
          roundNumber: match.roundNumber
        });
      }
    }
  }
  
  // Erken tur önce sırala
  return losers.sort((a, b) => (a.roundNumber - b.roundNumber) || (a.fromMatch - b.fromMatch));
}

// Aynı yarı havuzlarını kur
function buildSameSidePools(wb, semis) {
  if (semis.length < 2) return { poolA: [], poolB: [], semiALoser: null, semiBLoser: null };
  
  const [semiA, semiB] = semis;
  
  // Yarı final kazananları
  const semiAWinner = getWinner(semiA);
  const semiBWinner = getWinner(semiB);
  
  // Yarı final kaybedenleri
  const semiALoser = getLoser(semiA);
  const semiBLoser = getLoser(semiB);
  
  // IJF tarzı: Sadece yarı finalistlere kaybedenleri topla
  // Bu, klasik double elimination'dan farklı
  const poolA = semiAWinner ? collectLosersToFinalist(wb, semiAWinner) : [];
  const poolB = semiBWinner ? collectLosersToFinalist(wb, semiBWinner) : [];
  
  // Yarı final kaybedenlerini havuzdan çıkar (onlar bronzda bekleyecek)
  const filterSemiLoser = (list, semiLoser) => {
    if (!semiLoser?.participantId) return list;
    return list.filter(item => item.player?.participantId !== semiLoser.participantId);
  };
  
  return {
    poolA: filterSemiLoser(poolA, semiALoser),
    poolB: filterSemiLoser(poolB, semiBLoser),
    semiALoser,
    semiBLoser
  };
}

// Tek şerit topolojisi oluştur
function buildLaneTopology(startNumber, capacity) {
  const matches = [];
  const rounds = [];
  
  // Her turdaki maç sayısını hesapla
  let current = Math.ceil(capacity / 2);
  while (current >= 1) {
    rounds.push(current);
    if (current === 1) break;
    current = Math.ceil(current / 2);
  }
  
  let matchNumber = startNumber;
  
  // Her tur için maçları oluştur
  for (let round = 0; round < rounds.length; round++) {
    const matchesInRound = rounds[round];
    
    for (let i = 0; i < matchesInRound; i++) {
      const match = {
        roundNumber: round + 1,
        matchNumber: matchNumber++,
        player1: null,
        player2: null,
        lane: startNumber === 1000 ? 'A' : 'B',
        status: 'scheduled',
        winner: null,
        score: { player1Score: 0, player2Score: 0 },
        scheduledTime: null,
        completedAt: null,
        nextMatchNumber: null,
        nextMatchSlot: (i % 2 === 0 ? 'player1' : 'player2'),
        notes: ''
      };
      
      matches.push(match);
    }
  }
  
  // Şerit finali (bronz öncesi)
  const laneFinal = {
    roundNumber: rounds.length + 1,
    matchNumber: startNumber + 99, // 1099 veya 1199
    player1: null,
    player2: null,
    lane: startNumber === 1000 ? 'A' : 'B',
    status: 'scheduled',
    winner: null,
    score: { player1Score: 0, player2Score: 0 },
    scheduledTime: null,
    completedAt: null,
    nextMatchNumber: null,
    nextMatchSlot: 'player1',
    notes: ''
  };
  
  matches.push(laneFinal);
  
  // Maçları birbirine bağla
  let matchIndex = 0;
  for (let round = 0; round < rounds.length - 1; round++) {
    const currentRoundMatches = rounds[round];
    const nextRoundMatches = rounds[round + 1];
    
    for (let i = 0; i < currentRoundMatches; i++) {
      const currentMatch = matches[matchIndex];
      const nextMatchIndex = matchIndex + currentRoundMatches + Math.floor(i / 2);
      const nextMatch = matches[nextMatchIndex];
      
      if (nextMatch) {
        currentMatch.nextMatchNumber = nextMatch.matchNumber;
        currentMatch.nextMatchSlot = (i % 2 === 0 ? 'player1' : 'player2');
      }
      
      matchIndex++;
    }
  }
  
  // Son tur maçlarını şerit finaline bağla
  for (let i = 0; i < rounds[rounds.length - 1]; i++) {
    const match = matches[matchIndex + i];
    match.nextMatchNumber = startNumber + 99;
    match.nextMatchSlot = (i % 2 === 0 ? 'player1' : 'player2');
  }
  
  return matches;
}

// Tam repechage topolojisi oluştur
function buildRepechageTopology(wb) {
  const drawSize = getDrawSize(wb);
  if (drawSize < 4) return [];
  
  const halfSize = drawSize / 2;
  const laneCapacity = Math.max(1, halfSize - 1); // finalist hariç
  
  return [
    ...buildLaneTopology(1000, laneCapacity), // Şerit A
    ...buildLaneTopology(1100, laneCapacity)  // Şerit B
  ];
}

// 1. tur slotlarına oyuncuları yerleştir
function placeEntrantsInLane(lb, lane, entrants) {
  const firstRoundMatches = lb
    .filter(m => {
      const laneStart = lane === 'A' ? 1000 : 1100;
      const laneEnd = lane === 'A' ? 1100 : 1200;
      return m.matchNumber >= laneStart && m.matchNumber < laneEnd && 
             m.roundNumber === 1 && m.matchNumber !== (laneStart + 99);
    })
    .sort((a, b) => a.matchNumber - b.matchNumber);
  
  let entrantIndex = 0;
  for (const match of firstRoundMatches) {
    if (entrantIndex < entrants.length && !match.player1) {
      match.player1 = entrants[entrantIndex++];
    }
    if (entrantIndex < entrants.length && !match.player2) {
      match.player2 = entrants[entrantIndex++];
    }
    if (entrantIndex >= entrants.length) break;
  }
}

// BYE'leri otomatik ilerlet
function autoAdvanceByes(lb) {
  const matchMap = Object.fromEntries(lb.map(m => [m.matchNumber, m]));
  const orderedMatches = [...lb].sort((a, b) => (a.roundNumber - b.roundNumber) || (a.matchNumber - b.matchNumber));
  
  for (const match of orderedMatches) {
    const hasPlayer1 = !!match.player1;
    const hasPlayer2 = !!match.player2;
    
    // Tek oyuncu varsa (BYE durumu)
    if ((hasPlayer1 && !hasPlayer2) || (!hasPlayer1 && hasPlayer2)) {
      if (match.status !== 'completed') {
        const winner = hasPlayer1 ? match.player1 : match.player2;
        const winnerSlot = hasPlayer1 ? 'player1' : 'player2';
        
        // Maçı tamamla
        match.status = 'completed';
        match.winner = winnerSlot;
        match.completedAt = new Date();
        match.notes = addNoteOnce(match.notes, 'Otomatik BYE');
        
        // Kazananı bir sonraki maça ilerlet
        if (match.nextMatchNumber) {
          const nextMatch = matchMap[match.nextMatchNumber];
          if (nextMatch) {
            if (match.nextMatchSlot === 'player1') {
              nextMatch.player1 = winner;
            } else {
              nextMatch.player2 = winner;
            }
          }
        }
      }
    }
  }
}

// Bronz maçlarını bağla
function connectBronzeMatches(lb, semiALoser, semiBLoser) {
  const bronzeA = lb.find(m => m.matchNumber === 1099);
  const bronzeB = lb.find(m => m.matchNumber === 1199);
  
  if (bronzeA) {
    bronzeA.notes = addNoteOnce(bronzeA.notes, 'Bronz A');
    if (semiBLoser) bronzeA.player2 = semiBLoser;
  }
  
  if (bronzeB) {
    bronzeB.notes = addNoteOnce(bronzeB.notes, 'Bronz B');
    if (semiALoser) bronzeB.player2 = semiALoser;
  }
}

// Kayıtlı LB ile türetileni uzlaştır
function reconcileLoserBrackets(savedLB, derivedLB) {
  const derivedMap = new Map(derivedLB.map(m => [m.matchNumber, m]));
  const savedMap = new Map(savedLB.map(m => [m.matchNumber, m]));
  const merged = [];
  
  for (const [matchNumber, derived] of derivedMap.entries()) {
    const saved = savedMap.get(matchNumber);
    
    if (!saved) {
      // Yeni maç
      merged.push({ ...derived });
      continue;
    }
    
    // Mevcut maç - temel yapıyı koru
    const base = {
      roundNumber: derived.roundNumber,
      matchNumber: derived.matchNumber,
      nextMatchNumber: derived.nextMatchNumber,
      nextMatchSlot: derived.nextMatchSlot,
      notes: derived.notes || saved.notes || ''
    };
    
    let match = {
      ...base,
      player1: derived.player1 || null,
      player2: derived.player2 || null,
      status: 'scheduled',
      winner: null,
      score: { player1Score: 0, player2Score: 0 },
      scheduledTime: saved.scheduledTime || null,
      completedAt: null
    };
    
    // Oyuncular aynıysa sonuçları koru
    const samePlayers = 
      (saved.player1?.participantId === match.player1?.participantId || (!saved.player1 && !match.player1)) &&
      (saved.player2?.participantId === match.player2?.participantId || (!saved.player2 && !match.player2));
    
    if (samePlayers && isCompleted(saved)) {
      match.status = 'completed';
      match.winner = saved.winner;
      match.score = saved.score || { player1Score: 0, player2Score: 0 };
      match.completedAt = saved.completedAt || new Date();
      match.notes = saved.notes || match.notes;
    } else if (!samePlayers && (saved.player1 || saved.player2 || isCompleted(saved))) {
      match.notes = addNoteOnce(match.notes, 'LB re-sync: önceki sonuç/yerleşim geçersiz kılındı');
    }
    
    merged.push(match);
  }
  
  return merged;
}

// Eski karmaşık maintainLoserBrackets fonksiyonu kaldırıldı

// IJF tarzı bronz maçları oluşturur
// Artık kullanılmayan eski fonksiyonlar kaldırıldı

// Artık kullanılmayan eski fonksiyonlar kaldırıldı

// Mevcut turnuvadaki yanlış bronz maçlarını temizler
function cleanupExistingBronzeMatches(tournamentMatch) {
  const lb = tournamentMatch.loserBrackets || [];
  
  // 1099 ve 1199 numaralı maçları bul
  const bronzeA = lb.find(m => m.matchNumber === 1099);
  const bronzeB = lb.find(m => m.matchNumber === 1199);
  
  if (bronzeA) {
    // Aynı oyuncu tekrarını temizle
    if (bronzeA.player1?.participantId === bronzeA.player2?.participantId) {
      bronzeA.player1 = null;
      bronzeA.player2 = null;
      bronzeA.status = 'scheduled';
      bronzeA.winner = null;
      bronzeA.score = { player1Score: 0, player2Score: 0 };
      bronzeA.completedAt = null;
      bronzeA.notes = 'Bronz A';
    }
  }
  
  if (bronzeB) {
    // Aynı oyuncu tekrarını temizle
    if (bronzeB.player1?.participantId === bronzeB.player2?.participantId) {
      bronzeB.player1 = null;
      bronzeB.player2 = null;
      bronzeB.status = 'scheduled';
      bronzeB.winner = null;
      bronzeB.score = { player1Score: 0, player2Score: 0 };
      bronzeB.completedAt = null;
      bronzeB.notes = 'Bronz B';
    }
  }
}

// Emergency fix: Sistem tamamen bozulmuş, acil düzeltme
function emergencyFixRepechage(tournamentMatch) {
  console.log('EMERGENCY FIX: Repechage sistemi tamamen yeniden kuruluyor');
  
  const lb = tournamentMatch.loserBrackets || [];
  
  // Tüm mevcut repechage maçlarını temizle
  tournamentMatch.loserBrackets = [];
  
  // Winner bracket'ten yarı final kaybedenlerini bul
  const wb = tournamentMatch.brackets || [];
  const maxRound = Math.max(...wb.map(b => b.roundNumber || 0));
  const semis = wb
    .filter(m => m.roundNumber === maxRound - 1 && m.player1 && m.player2)
    .sort((a, b) => a.matchNumber - b.matchNumber);
  
  if (semis.length < 2) return;
  
  const [semiA, semiB] = semis;
  
  // Yarı final kaybedenlerini bul
  const getSemiLoser = (semi) =>
    (semi && semi.status === 'completed' && semi.winner)
      ? (semi.winner === 'player1' ? semi.player2 : semi.player1)
      : null;
  
  const semiALoser = getSemiLoser(semiA);
  const semiBLoser = getSemiLoser(semiB);
  
  // Yarı finalistlerin kaybettiği oyuncuları bul
  const getLosersForLane = (semiFinalist) => {
    if (!semiFinalist?.participantId) return [];
    
    const losers = [];
    for (const m of wb) {
      if (m.status !== 'completed' || !m.player1 || !m.player2 || !m.winner) continue;
      
      const winner = m[m.winner];
      const loser = m[m.winner === 'player1' ? 'player2' : 'player1'];
      
      if (!winner?.participantId || !loser?.participantId) continue;
      
      if (winner.participantId === semiFinalist.participantId) {
        losers.push({
          player: loser,
          matchNumber: m.matchNumber,
          roundNumber: m.roundNumber,
        });
      }
    }
    
    return losers.sort((a, b) => (a.roundNumber - b.roundNumber) || (a.matchNumber - b.matchNumber));
  };
  
  // Her yarı finalist için ayrı şerit oluştur
  const laneA_participants = semiA.player1 ? [semiA.player1, semiA.player2] : [];
  const laneB_participants = semiB.player1 ? [semiB.player1, semiB.player2] : [];
  
  const laneA_losers = [];
  const laneB_losers = [];
  
  for (const participant of laneA_participants) {
    if (participant?.participantId) {
      const losers = getLosersForLane(participant);
      laneA_losers.push(...losers);
    }
  }
  
  for (const participant of laneB_participants) {
    if (participant?.participantId) {
      const losers = getLosersForLane(participant);
      laneB_losers.push(...losers);
    }
  }
  
  // Yarı final kaybedenlerini şeritlerin sonuna ekle
  if (semiALoser) {
    laneA_losers.push({
      player: semiALoser,
      matchNumber: 0,
      roundNumber: maxRound,
      lostTo: 'semi_final'
    });
  }
  
  if (semiBLoser) {
    laneB_losers.push({
      player: semiBLoser,
      matchNumber: 0,
      roundNumber: maxRound,
      lostTo: 'semi_final'
    });
  }
  
  // IJF tarzı repechage yeniden oluştur
  const newLB = createIJFRepechage(laneA_losers, laneB_losers);
  tournamentMatch.loserBrackets = newLB;
  
  // Bronz maçları oluştur
  createIJFBronzeMatches(tournamentMatch);
  
  // Etiketleme ve kaydetme
  labelBronzeMatches(tournamentMatch.loserBrackets);
  autoCompleteByeInLoserBrackets(tournamentMatch);
  
  console.log('EMERGENCY FIX: Repechage sistemi yeniden kuruldu');
}

// Winner bracket'ta yanlış final maçlarını düzelt
function fixIncorrectFinals(wb) {
  if (!wb?.length) return wb;
  
  const maxRound = Math.max(...wb.map(m => m.roundNumber || 0));
  
  // Sadece en yüksek round'daki ve nextMatchNumber'ı olmayan maç final olmalı
  for (const match of wb) {
    if (match.roundNumber === maxRound && match.nextMatchNumber) {
      // Bu maç final olmamalı, nextMatchNumber'ı temizle
      match.nextMatchNumber = null;
      match.nextMatchSlot = null;
      console.log(`Düzeltildi: Maç ${match.matchNumber} artık final değil`);
    }
  }
  
  return wb;
}

// Mevcut turnuva verisindeki yanlış final maçlarını düzelt
function fixTournamentFinals(tournamentMatch) {
  const wb = tournamentMatch.brackets || [];
  if (!wb.length) return tournamentMatch;
  
  const maxRound = Math.max(...wb.map(m => m.roundNumber || 0));
  let changed = false;
  
  console.log(`\n=== FINAL MAÇLARINI DÜZELT ===`);
  console.log(`Maksimum round: ${maxRound}`);
  
  // Sadece en yüksek round'daki ve nextMatchNumber'ı olmayan maç final olmalı
  for (const match of wb) {
    if (match.roundNumber === maxRound && match.nextMatchNumber) {
      // Bu maç final olmamalı, nextMatchNumber'ı temizle
      console.log(`❌ Maç ${match.matchNumber} yanlış final: nextMatchNumber = ${match.nextMatchNumber}`);
      match.nextMatchNumber = null;
      match.nextMatchSlot = null;
      changed = true;
      console.log(`✅ Maç ${match.matchNumber} düzeltildi: artık final değil`);
    }
  }
  
  // Yarı final maçlarını da kontrol et (final'den bir önceki round)
  const semiRound = maxRound - 1;
  for (const match of wb) {
    if (match.roundNumber === semiRound && match.nextMatchNumber) {
      console.log(`❌ Maç ${match.matchNumber} yanlış yarı final: nextMatchNumber = ${match.nextMatchNumber}`);
      match.nextMatchNumber = null;
      match.nextMatchSlot = null;
      changed = true;
      console.log(`✅ Maç ${match.matchNumber} düzeltildi: yarı final`);
    }
  }
  
  if (changed) {
    console.log('✅ Turnuva final maçları düzeltildi');
  } else {
    console.log('✅ Turnuva final maçları zaten doğru');
  }
  
  return tournamentMatch;
}

// Eski karmaşık IJF fonksiyonu kaldırıldı

// Eski karmaşık createRepechageLane fonksiyonu kaldırıldı
    if (roundMatches.length > 1) {
      for (let i = 0; i < roundMatches.length; i++) {
        if (roundMatches[i].player2) { // Sadece gerçek maçlar için
          const nextMatchIndex = Math.floor(i / 2);
          const nextMatchNumber = matchNumber + nextMatchIndex;
          roundMatches[i].nextMatchNumber = nextMatchNumber;
          roundMatches[i].nextMatchSlot = (i % 2 === 0) ? 'player1' : 'player2';
        }
      }
// Eski kod parçası kaldırıldı

// Eski IJF endpoint'i kaldırıldı

// Eski debug endpoint'i kaldırıldı
          if (!isCompleted(match) || !match.player1 || !match.player2) continue;
          const winner = getWinner(match);
          if (winner?.participantId === finalist.participantId) {
            const loser = getLoser(match);
            if (loser?.participantId) {
              poolA.push({
                playerName: loser.name,
                fromMatch: match.matchNumber,
                roundNumber: match.roundNumber,
                lostToFinalist: finalist.name
              });
            }
          }
        }
      }
      
      // Pool B - Emirhan Yılmaz ve Muzaffer Buğra Sezer'e kaybedenler
      const poolB = [];
      for (const finalist of semiBFinalists) {
        for (const match of wb) {
          if (!isCompleted(match) || !match.player1 || !match.player2) continue;
          const winner = getWinner(match);
          if (winner?.participantId === finalist.participantId) {
            const loser = getLoser(match);
            if (loser?.participantId) {
              poolB.push({
                playerName: loser.name,
                fromMatch: match.matchNumber,
                roundNumber: match.roundNumber,
                lostToFinalist: finalist.name
              });
            }
          }
        }
      }
      
      // Yarı final kaybedenlerini filtrele
      const semiALoser = getLoser(semiA);
      const semiBLoser = getLoser(semiB);
      
      debug.poolA = poolA
        .filter(item => item.playerName !== semiALoser?.name && item.playerName !== semiBLoser?.name)
        .sort((a, b) => (a.roundNumber - b.roundNumber) || (a.fromMatch - b.fromMatch));
      
      debug.poolB = poolB
        .filter(item => item.playerName !== semiALoser?.name && item.playerName !== semiBLoser?.name)
        .sort((a, b) => (a.roundNumber - b.roundNumber) || (a.fromMatch - b.fromMatch));
    }
    
    res.json({
      success: true,
      message: 'IJF Repechage Debug Bilgileri',
      debug: debug
    });
    
  } catch (error) {
    console.error('IJF Debug hatası:', error);
    res.status(500).json({ error: "Sunucu hatası", details: error.message });
  }
});

// IJF Repechage test endpoint'i (basit)
router.get("/:id/test-ijf", async (req, res) => {
  try {
    const tournamentMatch = await TournamentMatch.findById(req.params.id);
    if (!tournamentMatch) {
      return res.status(404).json({ error: "Turnuva maçı bulunamadı" });
    }
    
    const wb = tournamentMatch.brackets || [];
    const maxRound = Math.max(...wb.map(m => m.roundNumber || 0));
    
    // Yarı finalleri bul
    const semis = wb
      .filter(m => m.roundNumber === maxRound - 1 && m.player1 && m.player2)
      .sort((a, b) => a.matchNumber - b.matchNumber);
    
    const result = {
      maxRound: maxRound,
      semiCount: semis.length,
      message: 'IJF Repechage Test'
    };
    
    if (semis.length >= 2) {
      const [semiA, semiB] = semis;
      
      result.semiA = {
        matchNumber: semiA.matchNumber,
        player1: semiA.player1?.name,
        player2: semiA.player2?.name,
        winner: semiA.winner,
        loser: getLoser(semiA)?.name
      };
      
      result.semiB = {
        matchNumber: semiB.matchNumber,
        player1: semiB.player1?.name,
        player2: semiB.player2?.name,
        winner: semiB.winner,
        loser: getLoser(semiB)?.name
      };
      
      // Yarı finalistlere kaybedenleri say
      const semiAFinalists = [semiA.player1, semiA.player2].filter(Boolean);
      const semiBFinalists = [semiB.player1, semiB.player2].filter(Boolean);
      
      let poolACount = 0;
      let poolBCount = 0;
      
      for (const finalist of semiAFinalists) {
        for (const match of wb) {
          if (isCompleted(match) && getWinner(match)?.participantId === finalist.participantId) {
            poolACount++;
          }
        }
      }
      
      for (const finalist of semiBFinalists) {
        for (const match of wb) {
          if (isCompleted(match) && getWinner(match)?.participantId === finalist.participantId) {
            poolBCount++;
          }
        }
      }
      
      result.poolACount = poolACount;
      result.poolBCount = poolBCount;
    }
    
    res.json(result);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// IJF Repechage test endpoint'i (seviye bilgili)
router.get("/:id/test-ijf", async (req, res) => {
  try {
    const tournamentMatch = await TournamentMatch.findById(req.params.id);
    if (!tournamentMatch) {
      return res.status(404).json({ error: "Turnuva maçı bulunamadı" });
    }
    
    const wb = tournamentMatch.brackets || [];
    const maxRound = Math.max(...wb.map(m => m.roundNumber || 0));
    
    // Yarı finalleri bul
    const semis = wb
      .filter(m => m.roundNumber === maxRound - 1 && m.player1 && m.player2)
      .sort((a, b) => a.matchNumber - b.matchNumber);
    
    const result = {
      maxRound: maxRound,
      semiCount: semis.length,
      message: 'IJF Repechage Test - Seviye Bilgili'
    };
    
    if (semis.length >= 2) {
      const [semiA, semiB] = semis;
      
      result.semiA = {
        matchNumber: semiA.matchNumber,
        player1: semiA.player1?.name,
        player2: semiA.player2?.name,
        winner: semiA.winner,
        loser: getLoser(semiA)?.name
      };
      
      result.semiB = {
        matchNumber: semiB.matchNumber,
        player1: semiB.player1?.name,
        player2: semiB.player2?.name,
        winner: semiB.winner,
        loser: getLoser(semiB)?.name
      };
      
      // Yarı finalistlere kaybedenleri detaylı analiz et
      const semiAFinalists = [semiA.player1, semiA.player2].filter(Boolean);
      const semiBFinalists = [semiB.player1, semiB.player2].filter(Boolean);
      
      const poolA = [];
      const poolB = [];
      
      // Pool A analizi
      for (const finalist of semiAFinalists) {
        for (const match of wb) {
          if (isCompleted(match) && getWinner(match)?.participantId === finalist.participantId) {
            const loser = getLoser(match);
            if (loser?.participantId) {
              poolA.push({
                playerName: loser.name,
                fromMatch: match.matchNumber,
                roundNumber: match.roundNumber,
                lostToFinalist: finalist.name
              });
            }
          }
        }
      }
      
      // Pool B analizi
      for (const finalist of semiBFinalists) {
        for (const match of wb) {
          if (isCompleted(match) && getWinner(match)?.participantId === finalist.participantId) {
            const loser = getLoser(match);
            if (loser?.participantId) {
              poolB.push({
                playerName: loser.name,
                fromMatch: match.matchNumber,
                roundNumber: match.roundNumber,
                lostToFinalist: finalist.name
              });
            }
          }
        }
      }
      
      // Seviyeye göre sırala
      result.poolA = poolA
        .sort((a, b) => (a.roundNumber - b.roundNumber) || (a.fromMatch - b.fromMatch))
        .map(item => `${item.playerName} (Round ${item.roundNumber}, Maç ${item.fromMatch})`);
      
      result.poolB = poolB
        .sort((a, b) => (a.roundNumber - b.roundNumber) || (a.fromMatch - b.fromMatch))
        .map(item => `${item.playerName} (Round ${item.roundNumber}, Maç ${item.fromMatch})`);
      
      result.summary = {
        poolASize: result.poolA.length,
        poolBSize: result.poolB.length,
        totalRepechage: result.poolA.length + result.poolB.length
      };
    }
    
    res.json(result);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Basit IJF Repechage sistemi - sadece yarı finalistlere kaybedenleri listeler
function getSimpleIJFRepechage(wb) {
  if (!wb?.length) return { poolA: [], poolB: [] };
  
  const maxRound = Math.max(...wb.map(m => m.roundNumber || 0));
  console.log(`\n=== BASIT IJF REPECHAGE ===`);
  console.log(`Maksimum round: ${maxRound}`);
  
  // Yarı finalleri bul (final'den bir önceki round)
  const semis = wb
    .filter(m => m.roundNumber === maxRound - 1 && m.player1 && m.player2)
    .sort((a, b) => a.matchNumber - b.matchNumber);
  
  console.log(`Yarı final sayısı: ${semis.length}`);
  
  if (semis.length < 2) {
    console.log('Yeterli yarı final yok');
    return { poolA: [], poolB: [] };
  }
  
  const [semiA, semiB] = semis;
  console.log(`Yarı A: Maç ${semiA.matchNumber} - ${semiA.player1.name} vs ${semiA.player2.name}`);
  console.log(`Yarı B: Maç ${semiB.matchNumber} - ${semiB.player1.name} vs ${semiB.player2.name}`);
  
  // Yarı finalistleri bul
  const semiAFinalists = [semiA.player1, semiA.player2].filter(Boolean);
  const semiBFinalists = [semiB.player1, semiB.player2].filter(Boolean);
  
  // Yarı finalistlere kaybeden oyuncuları topla
  const getLosersToSemiFinalists = (semiFinalists, poolName) => {
    const losers = [];
    
    for (const finalist of semiFinalists) {
      if (!finalist?.participantId) continue;
      
      console.log(`\n${poolName}: ${finalist.name}'e kaybedenleri arıyorum...`);
      
      // Bu finalist'in kazandığı tüm maçlardaki kaybedenleri bul
      for (const match of wb) {
        if (!isCompleted(match) || !match.player1 || !match.player2) continue;
        
        const winner = getWinner(match);
        if (winner?.participantId === finalist.participantId) {
          const loser = getLoser(match);
          if (loser?.participantId) {
            console.log(`  ✓ Maç ${match.matchNumber}: ${loser.name} (Round ${match.roundNumber})`);
            losers.push({
              player: loser,
              fromMatch: match.matchNumber,
              roundNumber: match.roundNumber,
              lostToFinalist: finalist
            });
          }
        }
      }
    }
    
    // Seviyeye göre sırala (erken tur önce)
    const sorted = losers.sort((a, b) => {
      if (a.roundNumber !== b.roundNumber) {
        return a.roundNumber - b.roundNumber;
      }
      return a.fromMatch - b.fromMatch;
    });
    
    console.log(`\n${poolName} final liste (${sorted.length} oyuncu):`);
    sorted.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.player.name} (Round ${item.roundNumber}, Maç ${item.fromMatch})`);
    });
    
    return sorted;
  };
  
  // Her yarı için kaybedenleri topla
  const poolA = getLosersToSemiFinalists(semiAFinalists, 'Pool A');
  const poolB = getLosersToSemiFinalists(semiBFinalists, 'Pool B');
  
  console.log(`\n--- TOPLAM REPECHAGE OYUNCULARI ---`);
  console.log(`Pool A: ${poolA.length} oyuncu`);
  console.log(`Pool B: ${poolB.length} oyuncu`);
  console.log(`Toplam: ${poolA.length + poolB.length} oyuncu`);
  
  return { poolA, poolB };
}

// Basit IJF test endpoint'i
router.get("/:id/test-ijf", auth, async (req, res) => {
  try {
    const tournamentMatch = await TournamentMatch.findById(req.params.id);
    if (!tournamentMatch) {
      return res.status(404).json({ error: "Turnuva maçı bulunamadı" });
    }
    
    if (tournamentMatch.tournamentType !== 'double_elimination') {
      return res.status(400).json({ error: "Bu işlem sadece double elimination turnuvalar için geçerlidir" });
    }
    
    const ijfList = getSimpleIJFRepechage(tournamentMatch.brackets || []);
    
    res.json({
      success: true,
      message: 'IJF Repechage listesi',
      data: ijfList
    });
    
  } catch (error) {
    console.error('IJF test hatası:', error);
    res.status(500).json({ error: "Sunucu hatası", details: error.message });
  }
});

module.exports = router; 