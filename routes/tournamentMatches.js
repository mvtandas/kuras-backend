const express = require("express");
const router = express.Router();
const TournamentMatch = require("../models/tournamentMatch");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const auth = require("../middleware/auth");

/*
=============================================================================
                         IJF REPECHAGE SYSTEM OVERVIEW
=============================================================================

This file implements a RELIABLE IJF-style double elimination tournament system
with static loser bracket topology and dynamic reconciliation.

🎯 KEY PRINCIPLES:
1. STATIC TOPOLOGY: Loser bracket structure is created once and saved permanently
2. DYNAMIC RECONCILIATION: On GET requests, LB is reconciled with current WB state  
3. CLEAR BOUNDARIES: WB advancement ≠ LB management (separate functions)
4. IJF COMPLIANCE: Only finalist-losers enter repechage, semi-losers wait at bronze

📋 PIPELINE FLOW:
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. TOURNAMENT CREATION (POST)                                           │
│    ├─ createDoubleEliminationBrackets() → WB + Static LB topology      │
│    └─ buildStaticRepechageTopologyFromWB() → Empty slots, fixed links  │
├─────────────────────────────────────────────────────────────────────────┤
│ 2. EVERY GET REQUEST                                                    │
│    ├─ ensureStateOnRead() → Triggers reconciliation                    │
│    ├─ maintainLBOnRead_SameSide() → Updates entrants, auto-BYE, bronze │
│    └─ Returns reconciled tournament state                              │
├─────────────────────────────────────────────────────────────────────────┤
│ 3. MATCH UPDATES (PATCH)                                               │
│    ├─ processAdvancement() → WB advancement only                       │
│    ├─ Final completion guard → Ensures bronzes completed first         │
│    └─ LB reconciliation triggered on next GET                          │
└─────────────────────────────────────────────────────────────────────────┘

🔧 HELPER FUNCTIONS:
- buildStaticLaneTopology(): Creates lane A/B structure (1000-1099, 1100-1199)
- buildSameSidePools(): Collects finalist-losers into separate pools
- autoAdvanceByesIn(): Idempotent BYE advancement
- attachBronzesSameSide(): Places semi-losers at bronze matches
- reconcileLB(): Merges saved state with derived state

🚫 REMOVED COMPLEXITY:
- No dynamic LB creation on match completion
- No complex loser advancement during WB matches  
- No scattered repechage logic across endpoints

=============================================================================
*/

// ======== IJF Repechage (aynı-yarı) – türet/uzlaştır yardımcıları ========

function isCompleted(m){ return m && m.status==='completed' && (m.winner==='player1'||m.winner==='player2'); }
// ======== REMOVED: Old simple versions - using enhanced versions below ========
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

// ======== FIXED: Collects losers to semi-finalist by round analysis ========
// Finds who this semi-finalist beat in ROUND 1 (direct approach)
function collectLosersToFinalist(wb, finalistPlayer){
  if (!finalistPlayer?.participantId) return [];
  
  const losers = [];
  
  console.log(`\n--- ${finalistPlayer.name}'e kaybedenleri arıyorum ---`);
  
  // Round 1'deki maçları kontrol et - bu finalist hangi maçta kazandı?
  const round1Matches = wb.filter(m => m.roundNumber === 1);
  console.log(`  Round 1 maçları: ${round1Matches.map(m => `Maç ${m.matchNumber} (${m.player1?.name || 'null'} vs ${m.player2?.name || 'null'})`).join(', ')}`);
  
  for (const match of round1Matches) {
    console.log(`  Maç ${match.matchNumber} kontrol ediliyor: status=${match.status}, winner=${match.winner}, isCompleted=${isCompleted(match)}`);
    if (!isCompleted(match)) {
      console.log(`    ❌ Maç ${match.matchNumber} tamamlanmamış, atlanıyor`);
      continue;
    }
    
    const winner = getWinner(match);
    console.log(`    Maç ${match.matchNumber} kazananı: ${winner?.name} (${winner?.participantId})`);
    console.log(`    Aranan finalist: ${finalistPlayer.name} (${finalistPlayer.participantId})`);
    
    // String karşılaştırması yap
    const winnerId = String(winner?.participantId);
    const finalistId = String(finalistPlayer.participantId);
    
    if (winnerId !== finalistId) {
      console.log(`    ❌ Bu maçı ${finalistPlayer.name} kazanmamış, atlanıyor`);
      console.log(`    DEBUG: winnerId="${winnerId}", finalistId="${finalistId}"`);
      continue;
    }
    
    // Normal maç: kaybedeni ekle
    if (match.player1 && match.player2) {
      const loser = getLoser(match);
      if (loser?.participantId) {
        console.log(`  ✓ Round 1 Maç ${match.matchNumber}: ${loser.name} (normal maç)`);
        losers.push({
          player: loser,
          fromMatch: match.matchNumber,
          roundNumber: match.roundNumber
        });
      }
    }
    // BYE maçı: BYE'ı not et
    else if ((match.player1 && !match.player2) || (!match.player1 && match.player2)) {
      console.log(`  ⚠ Round 1 Maç ${match.matchNumber}: BYE maçı - BYE ekleniyor`);
      // BYE durumunda kaybeden olmadığını belirt
      losers.push({
        player: { name: 'BYE', participantId: null, isBye: true },
        fromMatch: match.matchNumber,
        roundNumber: match.roundNumber,
        isBye: true
      });
    }
  }
  
  // Round 2'deki maçları da kontrol et (semi-final)
  const round2Matches = wb.filter(m => m.roundNumber === 2);
  
  for (const match of round2Matches) {
    if (!isCompleted(match)) continue;
    
    const winner = getWinner(match);
    if (winner?.participantId !== finalistPlayer.participantId) continue;
    
    // Normal maç: kaybedeni ekle
    if (match.player1 && match.player2) {
      const loser = getLoser(match);
      if (loser?.participantId) {
        console.log(`  ✓ Round 2 Maç ${match.matchNumber}: ${loser.name} (semi-final kaybedeni)`);
        losers.push({
          player: loser,
          fromMatch: match.matchNumber,
          roundNumber: match.roundNumber,
          isSemiLoser: true
        });
      }
    }
  }
  
  return losers;
}

// ======== UPDATED: IJF Same-Side Pools Logic ========
// Builds repechage pools according to IJF rules: only losers to semi-finalists enter repechage
function buildSameSidePools(wb, semis){
  const [semiA, semiB] = semis;

  const semiAWinner = (semiA.status==='completed' && semiA.winner) ? semiA[semiA.winner] : null;
  const semiBWinner = (semiB.status==='completed' && semiB.winner) ? semiB[semiB.winner] : null;

  const semiALoser  = (semiA.status==='completed' && semiA.winner) ? semiA[semiA.winner==='player1' ? 'player2':'player1'] : null;
  const semiBLoser  = (semiB.status==='completed' && semiB.winner) ? semiB[semiB.winner==='player1' ? 'player2':'player1'] : null;

  console.log(`\n=== IJF SAME-SIDE POOLS ANALYSIS ===`);
  console.log(`Semi A: ${semiA.player1?.name} vs ${semiA.player2?.name} → Winner: ${semiAWinner?.name}, Loser: ${semiALoser?.name}`);
  console.log(`Semi B: ${semiB.player1?.name} vs ${semiB.player2?.name} → Winner: ${semiBWinner?.name}, Loser: ${semiBLoser?.name}`);

  // IJF Logic: Find all players who lost to SEMI-FINALISTS (not finalists)
  const semiAFinalists = [semiA.player1, semiA.player2].filter(Boolean);
  const semiBFinalists = [semiB.player1, semiB.player2].filter(Boolean);

  console.log(`\nSemi A Finalists: ${semiAFinalists.map(p => p.name).join(', ')}`);
  console.log(`Semi B Finalists: ${semiBFinalists.map(p => p.name).join(', ')}`);

  // Pool A: Players who lost to Semi A participants
  const poolA = [];
  for (const semiFinalist of semiAFinalists) {
    const losersToThis = collectLosersToFinalist(wb, semiFinalist);
    console.log(`\n${semiFinalist.name}'e kaybeden oyuncular:`);
    losersToThis.forEach(l => console.log(`  - ${l.player.name} (Maç ${l.fromMatch}, Round ${l.roundNumber})`));
    poolA.push(...losersToThis);
  }

  // Pool B: Players who lost to Semi B participants  
  const poolB = [];
  for (const semiFinalist of semiBFinalists) {
    const losersToThis = collectLosersToFinalist(wb, semiFinalist);
    console.log(`\n${semiFinalist.name}'e kaybeden oyuncular:`);
    losersToThis.forEach(l => console.log(`  - ${l.player.name} (Maç ${l.fromMatch}, Round ${l.roundNumber})`));
    poolB.push(...losersToThis);
  }

  // Separate Round 1 losers (repechage) from Round 2 losers (bronze matches)
  const processPool = (poolItems, poolName) => {
    const round1Losers = [];
    const round2Losers = [];
    const seen = new Set();
    
    console.log(`\n${poolName} işleniyor:`);
    
    for (const item of poolItems.sort((a,b)=>(a.roundNumber-b.roundNumber)||(a.fromMatch-b.fromMatch))) {
      // Skip duplicates
      if (seen.has(item.player?.participantId)) continue;
      seen.add(item.player?.participantId);
      
      if (item.roundNumber === 1) {
        if (item.isBye) {
          console.log(`  - Round 1: BYE (${item.player.name})`);
          round1Losers.push({ ...item.player, isBye: true });
        } else {
          console.log(`  - Round 1: ${item.player.name} (Maç ${item.fromMatch})`);
          round1Losers.push(item.player);
        }
      } else if (item.roundNumber === 2 && item.isSemiLoser) {
        console.log(`  - Round 2: ${item.player.name} (Semi-final kaybedeni - bronze'a gidecek)`);
        round2Losers.push(item.player);
      }
    }
    
    return { round1Losers, round2Losers };
  };

  const poolAResult = processPool(poolA, 'Pool A');
  const poolBResult = processPool(poolB, 'Pool B');

  const uniquePoolA = poolAResult.round1Losers;
  const uniquePoolB = poolBResult.round1Losers;

  console.log(`\n=== FINAL REPECHAGE POOLS ===`);
  console.log(`Pool A (${uniquePoolA.length} oyuncu): ${uniquePoolA.map(p => p.name).join(', ')}`);
  console.log(`Pool B (${uniquePoolB.length} oyuncu): ${uniquePoolB.map(p => p.name).join(', ')}`);
  console.log(`Semi A Loser (Bronze B'de bekliyor): ${semiALoser?.name || 'None'}`);
  console.log(`Semi B Loser (Bronze A'da bekliyor): ${semiBLoser?.name || 'None'}`);

  return {
    poolA: uniquePoolA,
    poolB: uniquePoolB,
    semiALoser, 
    semiBLoser
  };
}

// Basit şerit topolojisi: Sadece 1 round + bronze (gereksiz maçlar yok)
function buildSimpleLaneTopology(startNumber, roundCount){
  const lane = startNumber===1000 ? 'A':'B';
  const matches = [];
  
  // Sadece 1. round maçı
  const firstRound = {
    roundNumber: 1, matchNumber: startNumber,
    player1: null, player2: null, lane,
    status: 'scheduled', winner: null,
    score: {player1Score: 0, player2Score: 0},
    scheduledTime: null, completedAt: null,
    nextMatchNumber: startNumber + 99, nextMatchSlot: 'player1',
    notes: ''
  };
  matches.push(firstRound);
  
  // Bronze maçı (1099 veya 1199)
  const bronze = {
    roundNumber: 2, matchNumber: startNumber + 99,
    player1: null, player2: null, lane,
    status: 'scheduled', winner: null,
    score: {player1Score: 0, player2Score: 0},
    scheduledTime: null, completedAt: null,
    nextMatchNumber: null, nextMatchSlot: 'player1',
    notes: ''
  };
  matches.push(bronze);
  
  return matches;
}

// Eski karmaşık topoloji (artık kullanılmıyor)
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
  // Sadece 1. round maçlarından gerçek oyuncu sayısını al
  const round1Matches = wb.filter(m => m.roundNumber === 1);
  const actualParticipants = round1Matches.length * 2; // Her maç 2 oyuncu
  
  // Her lane için sadece 1 round + bronze oluştur
  const laneA = buildSimpleLaneTopology(1000, 1); // 1 round + bronze
  const laneB = buildSimpleLaneTopology(1100, 1); // 1 round + bronze
  
  return [...laneA, ...laneB];
}

// 1. tur slotlarına sırayla yerleştir (artık sadece 1 maç var)
function placeLaneEntrants(lb, lane, entrants){
  console.log(`\n--- Placing ${entrants.length} entrants in Lane ${lane} ---`);
  console.log(`Entrants:`, entrants.map(e => e.player?.name || e.name));
  
  // Sadece 1. round maçını bul (1000 veya 1100)
  const firstRoundMatch = lb.find(m => 
    m.matchNumber === (lane==='A' ? 1000 : 1100) && 
    m.roundNumber === 1
  );
    
  console.log(`First round match in Lane ${lane}: Maç ${firstRoundMatch?.matchNumber}`);
  
  if (firstRoundMatch && entrants.length >= 2) {
    // İlk 2 oyuncuyu yerleştir
    firstRoundMatch.player1 = entrants[0];
    firstRoundMatch.player2 = entrants[1];
    console.log(`  Maç ${firstRoundMatch.matchNumber} player1: ${entrants[0].player?.name || entrants[0].name}`);
    console.log(`  Maç ${firstRoundMatch.matchNumber} player2: ${entrants[1].player?.name || entrants[1].name}`);
  } else if (firstRoundMatch && entrants.length === 1) {
    // Sadece 1 oyuncu varsa
    firstRoundMatch.player1 = entrants[0];
    console.log(`  Maç ${firstRoundMatch.matchNumber} player1: ${entrants[0].player?.name || entrants[0].name}`);
    console.log(`  Maç ${firstRoundMatch.matchNumber} player2: null (BYE)`);
  }
  
  console.log(`--- Lane ${lane} placement completed ---`);
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

// ======== UPDATED: IJF Bronze Match Connections ========
// IJF Rule: Semi A loser goes to Bronze B, Semi B loser goes to Bronze A (cross-connection)
function attachBronzesSameSide(lb, semiALoser, semiBLoser){
  const bronzeA = lb.find(m => m.matchNumber===1099);
  const bronzeB = lb.find(m => m.matchNumber===1199);
  
  if (bronzeA){ 
    bronzeA.notes = addNoteOnce(bronzeA.notes,'Bronz A'); 
    // IJF: Semi B loser goes to Bronze A
    if (semiBLoser) {
      bronzeA.player2 = semiBLoser;
      console.log(`✅ Bronze A: Semi B loser ${semiBLoser.name} placed at player2`);
    }
  }
  
  if (bronzeB){ 
    bronzeB.notes = addNoteOnce(bronzeB.notes,'Bronz B'); 
    // IJF: Semi A loser goes to Bronze B  
    if (semiALoser) {
      bronzeB.player2 = semiALoser;
      console.log(`✅ Bronze B: Semi A loser ${semiALoser.name} placed at player2`);
    }
  }
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
  
  console.log(`\n=== REPECHAGE PLACEMENT DEBUG ===`);
  console.log(`Pool A (${poolA.length} oyuncu):`, poolA.map(p => p.player?.name || p.name));
  console.log(`Pool B (${poolB.length} oyuncu):`, poolB.map(p => p.player?.name || p.name));
  console.log(`Semi A Loser:`, semiALoser?.name);
  console.log(`Semi B Loser:`, semiBLoser?.name);

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

// ======== EMERGENCY FIX FUNCTIONS ========
// These functions detect and fix broken tournament structures

// Validates tournament structure and identifies issues that need emergency fixing
function validateTournamentStructure(wb, savedLB) {
  const issues = [];
  let needsEmergencyFix = false;
  
  // Check 1: Missing loser bracket entirely
  if (!savedLB || savedLB.length === 0) {
    issues.push('Missing loser bracket');
    needsEmergencyFix = true;
  }
  
  // Check 2: Wrong number of LB matches for the draw size
  if (wb.length > 0 && savedLB.length > 0) {
    const expectedDrawSize = inferDrawSizeFromWB(wb);
    const expectedLBMatches = buildStaticRepechageTopologyFromWB(wb).length;
    
    if (savedLB.length !== expectedLBMatches) {
      issues.push(`LB match count mismatch: expected ${expectedLBMatches}, got ${savedLB.length}`);
      needsEmergencyFix = true;
    }
  }
  
  // Check 3: Missing bronze matches (1099, 1199)
  if (savedLB.length > 0) {
    const hasBronzeA = savedLB.some(m => m.matchNumber === 1099);
    const hasBronzeB = savedLB.some(m => m.matchNumber === 1199);
    
    if (!hasBronzeA || !hasBronzeB) {
      issues.push('Missing bronze matches (1099/1199)');
      needsEmergencyFix = true;
    }
  }
  
  // Check 4: Broken match number ranges
  if (savedLB.length > 0) {
    const laneAMatches = savedLB.filter(m => m.matchNumber >= 1000 && m.matchNumber < 1100);
    const laneBMatches = savedLB.filter(m => m.matchNumber >= 1100 && m.matchNumber < 1200);
    
    if (laneAMatches.length === 0 && laneBMatches.length === 0) {
      issues.push('No valid lane matches found');
      needsEmergencyFix = true;
    }
  }
  
  // Check 5: Corrupted nextMatchNumber links
  if (savedLB.length > 0) {
    const matchNumbers = new Set(savedLB.map(m => m.matchNumber));
    const brokenLinks = savedLB.filter(m => 
      m.nextMatchNumber && 
      m.nextMatchNumber !== null && 
      !matchNumbers.has(m.nextMatchNumber)
    );
    
    if (brokenLinks.length > 0) {
      issues.push(`${brokenLinks.length} broken nextMatchNumber links`);
      needsEmergencyFix = true;
    }
  }
  
  return { needsEmergencyFix, issues };
}

// Cleans up common issues that don't require full rebuild
function cleanupCommonIssues(tournamentMatch) {
  const fixes = [];
  let fixed = false;
  
  if (tournamentMatch.tournamentType !== 'double_elimination') {
    return { fixed: false, fixes: [] };
  }
  
  const lb = tournamentMatch.loserBrackets || [];
  
  // Fix 1: Remove duplicate players in bronze matches
  const bronzeA = lb.find(m => m.matchNumber === 1099);
  const bronzeB = lb.find(m => m.matchNumber === 1199);
  
  if (bronzeA && bronzeA.player1?.participantId === bronzeA.player2?.participantId && bronzeA.player1) {
    bronzeA.player2 = null;
    bronzeA.status = 'scheduled';
    bronzeA.winner = null;
    bronzeA.completedAt = null;
    fixes.push('Removed duplicate player in Bronze A');
    fixed = true;
  }
  
  if (bronzeB && bronzeB.player1?.participantId === bronzeB.player2?.participantId && bronzeB.player1) {
    bronzeB.player2 = null;
    bronzeB.status = 'scheduled';
    bronzeB.winner = null;
    bronzeB.completedAt = null;
    fixes.push('Removed duplicate player in Bronze B');
    fixed = true;
  }
  
  // Fix 2: Ensure bronze matches have correct notes
  if (bronzeA && !bronzeA.notes?.includes('Bronz A')) {
    bronzeA.notes = addNoteOnce(bronzeA.notes || '', 'Bronz A');
    fixes.push('Fixed Bronze A notes');
    fixed = true;
  }
  
  if (bronzeB && !bronzeB.notes?.includes('Bronz B')) {
    bronzeB.notes = addNoteOnce(bronzeB.notes || '', 'Bronz B');
    fixes.push('Fixed Bronze B notes');
    fixed = true;
  }
  
  // Fix 3: Clean up invalid player references (null/undefined cleanup)
  for (const match of lb) {
    let matchFixed = false;
    
    if (match.player1 && (!match.player1.participantId || !match.player1.name)) {
      match.player1 = null;
      matchFixed = true;
    }
    
    if (match.player2 && (!match.player2.participantId || !match.player2.name)) {
      match.player2 = null;
      matchFixed = true;
    }
    
    if (matchFixed && match.status === 'completed') {
      match.status = 'scheduled';
      match.winner = null;
      match.completedAt = null;
      fixed = true;
    }
  }
  
  if (fixed && !fixes.includes('Cleaned invalid player references')) {
    fixes.push('Cleaned invalid player references');
  }
  
  return { fixed, fixes };
}

// ======== REMOVED: makeBronzeAfterLane ========
// This function is no longer needed as bronze matches are handled by attachBronzesSameSide

// ======== ENHANCED: GET Request State Finalization with Emergency Fix ========
// Ensures loser bracket is reconciled on every read, can fix broken structures
async function ensureStateOnRead(tournamentMatch, { forceRebuild = true } = {}) {
  try {
    let changed = false;
    
    // *** IJF REPECHAGE PIPELINE: GET reconciliation starts ***
    if (tournamentMatch.tournamentType === 'double_elimination') {
      console.log('🔄 IJF Repechage: Reconciling loser bracket on read...');
      
      const wb = tournamentMatch.brackets || [];
      const savedLB = tournamentMatch.loserBrackets || [];
      
      // *** EMERGENCY FIX: Check if structure is broken ***
      const structureCheck = validateTournamentStructure(wb, savedLB);
      
      if (structureCheck.needsEmergencyFix) {
        console.log('🚨 EMERGENCY FIX: Tournament structure is broken, rebuilding...');
        console.log(`Issues found: ${structureCheck.issues.join(', ')}`);
        
        // Rebuild static topology from scratch
        const newStaticLB = buildStaticRepechageTopologyFromWB(wb);
        tournamentMatch.loserBrackets = newStaticLB;
      changed = true;
        
        console.log(`✅ Emergency fix applied: ${newStaticLB.length} LB matches recreated`);
      }
      
      // Normal reconciliation process
      const reconcileResult = maintainLBOnRead_SameSide(wb, tournamentMatch.loserBrackets || []);
      
      if (reconcileResult.changed) {
        console.log(`✅ LB reconciled: ${reconcileResult.reason}`);
        tournamentMatch.loserBrackets = reconcileResult.lb;
        changed = true;
      } else {
        console.log(`✅ LB up-to-date: ${reconcileResult.reason}`);
        tournamentMatch.loserBrackets = reconcileResult.lb;
      }
      
      // *** ADDITIONAL FIXES: Clean up common issues ***
      const cleanupResult = cleanupCommonIssues(tournamentMatch);
      if (cleanupResult.fixed) {
        console.log(`🔧 Cleanup applied: ${cleanupResult.fixes.join(', ')}`);
        changed = true;
      }
      
      // Generate simple IJF list for display (optional)
      const ijfList = getSimpleIJFRepechage(wb);
      tournamentMatch.ijfRepechageList = ijfList;
    }
    // *** IJF REPECHAGE PIPELINE: Reconciliation completed ***
    
    // Winner bracket advancement (WB only)
    tournamentMatch = await processAdvancement(tournamentMatch);
    
    if (changed) {
      console.log('💾 Tournament updated with fixes/reconciliation, saving...');
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

// ======== REFACTORED: Double Elimination Bracket Creation ========
// Creates winner bracket + static loser bracket topology from the start
function createDoubleEliminationBrackets(participants) {
  const winnerBrackets = [];
  const n = participants.length;
  
  if (n < 2) {
    return { winnerBrackets, loserBrackets: [] };
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
  
  // *** IJF REPECHAGE PIPELINE START ***
  // Create static loser bracket topology immediately (slots empty)
  const staticLoserBrackets = buildStaticRepechageTopologyFromWB(winnerBrackets);
  
  return { 
    winnerBrackets, 
    loserBrackets: staticLoserBrackets 
  };
  // *** IJF REPECHAGE PIPELINE: Static topology created ***
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

        // *** IJF REPECHAGE PIPELINE: Create static topology on tournament creation ***
        const staticLB = buildStaticRepechageTopologyFromWB(tournamentBrackets);
        tournamentLoserBrackets = staticLB;
        console.log(`✅ Static LB topology created: ${staticLB.length} matches`);
        // *** IJF REPECHAGE PIPELINE: Static topology ready ***
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
          
          // *** IJF REPECHAGE PIPELINE: Manual WB also needs static LB topology ***
          const staticLB = buildStaticRepechageTopologyFromWB(tournamentBrackets);
          tournamentLoserBrackets = staticLB;
          console.log(`✅ Static LB topology created for manual WB: ${staticLB.length} matches`);
          // *** IJF REPECHAGE PIPELINE: Manual topology ready ***
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

// ======== REFACTORED: Winner Bracket Only Advancement ========
// Processes advancement only in winner bracket - LB is handled by maintainLBOnRead_SameSide
async function processAdvancement(tournamentMatch) {
  if (tournamentMatch.tournamentType !== 'single_elimination' && tournamentMatch.tournamentType !== 'double_elimination') {
    return tournamentMatch;
  }
  
  let hasChanges = false;
  
  // *** WINNER BRACKET ADVANCEMENT ONLY ***
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
  
  // Her round için BYE auto-advancement kontrol et
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
  
  // Normal kazanan ilerletme işlemleri (WINNER BRACKET ONLY)
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
  
  // *** LOSER BRACKET LOGIC REMOVED ***
  // LB is now handled by maintainLBOnRead_SameSide on GET requests
  
  // Değişiklikler varsa kaydet
  if (hasChanges) {
    tournamentMatch.brackets = sortedBrackets;
    await tournamentMatch.save();
  }
  
  return tournamentMatch;
}

// ======== REMOVED: Legacy repechage functions ========
// These functions were part of the old complex system and are no longer needed:
// - buildRepechageLane (replaced by buildStaticLaneTopology)
// - processDoubleEliminationLoserBrackets (replaced by maintainLBOnRead_SameSide)
// - Complex dynamic loser bracket creation

// ======== REMOVED: More legacy functions ========
// - createTwoLaneRepechage (functionality merged into buildStaticRepechageTopologyFromWB)
// - createRepechageBrackets (replaced by static topology approach)

// ======== REMOVED: Legacy LB management functions ========
// These functions are replaced by the maintainLBOnRead_SameSide system:
// - autoCompleteByeInLoserBrackets (now handled by autoAdvanceByesIn)
// - labelBronzeMatches (now handled by attachBronzesSameSide)  
// - processLoserBracketAdvancement (no longer needed with reconciliation approach)

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
      
      // *** IJF REPECHAGE PIPELINE: Final completion guard ***
      // Ensure bronze matches are completed before final can be completed
      const isWinnerFinal = !isLoserBracket && tournamentMatch.tournamentType === 'double_elimination' && (() => {
        const fm = findWinnerFinal(tournamentMatch.brackets || []);
        return fm && fm.matchNumber === parseInt(matchId, 10);
      })();
      
      if (isWinnerFinal && (status === 'completed' || winner)) {
        // First, ensure loser bracket is up-to-date before checking bronzes
        const wb = tournamentMatch.brackets || [];
        const savedLB = tournamentMatch.loserBrackets || [];
        const reconcileResult = maintainLBOnRead_SameSide(wb, savedLB);
        
        if (reconcileResult.changed) {
          tournamentMatch.loserBrackets = reconcileResult.lb;
          await tournamentMatch.save();
          console.log('🔄 LB reconciled before final completion check');
        }
        
        // Check if both bronze matches are completed
        const bronzesDone = areBronzesCompleted(tournamentMatch.loserBrackets || []);
        if (!bronzesDone) {
          return res.status(400).json({ 
            message: "IJF Repechage kuralları: Bronz A ve Bronz B maçları tamamlanmadan final tamamlanamaz.",
            details: "Lütfen önce 1099 ve 1199 numaralı bronze maçlarını tamamlayın."
          });
        }
        
        console.log('✅ Bronze matches completed, final can proceed');
      }
      // *** IJF REPECHAGE PIPELINE: Final guard completed ***

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

    // *** IJF REPECHAGE PIPELINE: Post-match LB reconciliation ***
    if (updatedMatch.tournamentType === 'double_elimination') {
      console.log('🔄 Post-match: Reconciling LB after WB advancement...');
      const wb = updatedMatch.brackets || [];
      const savedLB = updatedMatch.loserBrackets || [];
      const reconcileResult = maintainLBOnRead_SameSide(wb, savedLB);
      
      if (reconcileResult.changed) {
        console.log(`✅ LB updated after match: ${reconcileResult.reason}`);
        updatedMatch.loserBrackets = reconcileResult.lb;
        await updatedMatch.save();
      } else {
        console.log(`✅ LB already current: ${reconcileResult.reason}`);
        updatedMatch.loserBrackets = reconcileResult.lb;
      }
    }
    // *** IJF REPECHAGE PIPELINE: Post-match reconciliation completed ***

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
// ======== REMOVED: Duplicate function - using the enhanced version above ========

// ======== REMOVED: Duplicate function - using the enhanced version above ========

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

// ======== REMOVED: Emergency fix and cleanup functions ========
// These functions were part of the old problematic system and are no longer needed:
// - cleanupExistingBronzeMatches (handled by reconciliation)
// - emergencyFixRepechage (system is now reliable from the start)
// - fixIncorrectFinals (WB structure is now correct by design)
// - fixTournamentFinals (no longer needed with proper structure)

// ======== REMOVED: Old debug and test endpoints ========
// These endpoints were for debugging the old problematic system and are no longer needed:
// - Multiple conflicting test-ijf endpoints
// - Debug endpoints with hardcoded player names
// - Legacy repechage testing code

// ======== UPDATED: IJF Repechage System ========
// Lists players who lost to SEMI-FINALISTS (not finalists) according to IJF rules
function getSimpleIJFRepechage(wb) {
  if (!wb?.length) return { poolA: [], poolB: [] };
  
  const maxRound = Math.max(...wb.map(m => m.roundNumber || 0));
  console.log(`\n=== IJF REPECHAGE SYSTEM ===`);
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
  console.log(`Yarı A: Maç ${semiA.matchNumber} - ${semiA.player1?.name} vs ${semiA.player2?.name}`);
  console.log(`Yarı B: Maç ${semiB.matchNumber} - ${semiB.player1?.name} vs ${semiB.player2?.name}`);
  
  // IJF Logic: All players who lost to semi-finalists enter repechage
  const semiAFinalists = [semiA.player1, semiA.player2].filter(Boolean);
  const semiBFinalists = [semiB.player1, semiB.player2].filter(Boolean);
  
  console.log(`\nSemi A Finalists: ${semiAFinalists.map(p => p.name).join(', ')}`);
  console.log(`Semi B Finalists: ${semiBFinalists.map(p => p.name).join(', ')}`);
  
  // ======== FIXED: Only look at Round 1 matches ========
  const getLosersToSemiFinalists = (semiFinalists, poolName) => {
    const losers = [];
    
    for (const finalist of semiFinalists) {
      if (!finalist?.participantId) continue;
      
      console.log(`\n${poolName}: ${finalist.name}'e kaybedenleri arıyorum...`);
      
      // SADECE Round 1'deki maçları kontrol et
      const round1Matches = wb.filter(m => m.roundNumber === 1);
      
      let foundInRound1 = false;
      
      for (const match of round1Matches) {
        console.log(`    Maç ${match.matchNumber}: status=${match.status}, winner=${match.winner}, isCompleted=${isCompleted(match)}`);
        if (!isCompleted(match)) {
          console.log(`    ❌ Maç ${match.matchNumber} tamamlanmamış, atlanıyor`);
          continue;
        }
        
        const winner = getWinner(match);
        console.log(`    Maç ${match.matchNumber} kazananı: ${winner?.name} (${winner?.participantId})`);
        console.log(`    Aranan finalist: ${finalist.name} (${finalist.participantId})`);
        
        // String karşılaştırması yap
        const winnerId = String(winner?.participantId);
        const finalistId = String(finalist.participantId);
        
        if (winnerId !== finalistId) {
          console.log(`    ❌ Bu maçı ${finalist.name} kazanmamış, atlanıyor`);
          console.log(`    DEBUG: winnerId="${winnerId}", finalistId="${finalistId}"`);
          continue;
        }
        
        foundInRound1 = true;
        
        // Normal maç: kaybedeni ekle
        if (match.player1 && match.player2) {
          const loser = getLoser(match);
          if (loser?.participantId) {
            console.log(`  ✓ Round 1 Maç ${match.matchNumber}: ${loser.name}`);
            losers.push({
              player: loser,
              fromMatch: match.matchNumber,
              roundNumber: match.roundNumber,
              lostToFinalist: finalist
            });
          }
        }
        // BYE maçı: BYE'ı not et
        else if ((match.player1 && !match.player2) || (!match.player1 && match.player2)) {
          console.log(`  ⚠ Round 1 Maç ${match.matchNumber}: BYE maçı - kaybeden yok ama BYE ekleniyor`);
          losers.push({
            player: { name: 'BYE', participantId: 'bye' },
            fromMatch: match.matchNumber,
            roundNumber: match.roundNumber,
            lostToFinalist: finalist,
            isBye: true
          });
        }
      }
      
      if (!foundInRound1) {
        console.log(`  ⚠ ${finalist.name} Round 1'de maç bulunamadı - muhtemelen BYE aldı`);
      }
    }
    
    // Tekrar eden oyuncuları temizle ve seviyeye göre sırala (erken tur önce)
    const unique = [];
    const seen = new Set();
    
    for (const item of losers.sort((a, b) => {
      if (a.roundNumber !== b.roundNumber) {
        return a.roundNumber - b.roundNumber;
      }
      return a.fromMatch - b.fromMatch;
    })) {
      if (!seen.has(item.player.participantId)) {
        seen.add(item.player.participantId);
        unique.push(item);
      }
    }
    
    console.log(`\n${poolName} final liste (${unique.length} oyuncu):`);
    unique.forEach((item, index) => {
      const byeNote = item.isBye ? ' (BYE)' : '';
      console.log(`  ${index + 1}. ${item.player.name} (Round ${item.roundNumber}, Maç ${item.fromMatch})${byeNote}`);
    });
    
    return unique;
  };
  
  // Her yarı için kaybedenleri topla
  const poolA = getLosersToSemiFinalists(semiAFinalists, 'Pool A (Semi A tarafına kaybeden oyuncular)');
  const poolB = getLosersToSemiFinalists(semiBFinalists, 'Pool B (Semi B tarafına kaybeden oyuncular)');
  
  // Semi final kaybedenlerini bul
  const semiALoser = (semiA.status === 'completed' && semiA.winner) ? 
    semiA[semiA.winner === 'player1' ? 'player2' : 'player1'] : null;
  const semiBLoser = (semiB.status === 'completed' && semiB.winner) ? 
    semiB[semiB.winner === 'player1' ? 'player2' : 'player1'] : null;
  
  console.log(`\n=== IJF BRONZE MATCH ASSIGNMENTS ===`);
  console.log(`Bronze A (1099): Pool A winner vs Semi B loser (${semiBLoser?.name || 'TBD'})`);
  console.log(`Bronze B (1199): Pool B winner vs Semi A loser (${semiALoser?.name || 'TBD'})`);
  
  console.log(`\n--- TOPLAM REPECHAGE OYUNCULARI ---`);
  console.log(`Pool A: ${poolA.length} oyuncu`);
  console.log(`Pool B: ${poolB.length} oyuncu`);
  console.log(`Toplam: ${poolA.length + poolB.length} oyuncu`);
  
  return { 
    poolA, 
    poolB,
    bronzeMatches: {
      bronzeA: { poolWinner: 'A', semiLoser: semiBLoser },
      bronzeB: { poolWinner: 'B', semiLoser: semiALoser }
    }
  };
}

// ======== CLEAN: IJF Repechage Test Endpoint ========
// Simple endpoint to view current IJF repechage pools
router.get("/:id/test-ijf", auth, async (req, res) => {
  try {
    const tournamentMatch = await TournamentMatch.findById(req.params.id);
    if (!tournamentMatch) {
      return res.status(404).json({ error: "Turnuva maçı bulunamadı" });
    }
    
    if (tournamentMatch.tournamentType !== 'double_elimination') {
      return res.status(400).json({ error: "Bu işlem sadece double elimination turnuvalar için geçerlidir" });
    }
    
    // Use the same logic as GET request to ensure consistency
    const wb = tournamentMatch.brackets || [];
    const savedLB = tournamentMatch.loserBrackets || [];
    
    // Check structure health
    const structureCheck = validateTournamentStructure(wb, savedLB);
    const reconcileResult = maintainLBOnRead_SameSide(wb, savedLB);
    const ijfList = getSimpleIJFRepechage(wb);
    
    res.json({
      success: true,
      message: 'IJF Repechage System Status',
      data: {
        structureHealth: {
          isHealthy: !structureCheck.needsEmergencyFix,
          issues: structureCheck.issues
        },
        repechagePools: ijfList,
        loserBracketStatus: {
          totalMatches: reconcileResult.lb.length,
          lastReconciled: reconcileResult.reason,
          changed: reconcileResult.changed
        }
      }
    });
    
  } catch (error) {
    console.error('IJF test hatası:', error);
    res.status(500).json({ error: "Sunucu hatası", details: error.message });
  }
});

// ======== EMERGENCY FIX ENDPOINT ========
// Manual endpoint to force fix broken tournament structures
router.post("/:id/emergency-fix", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("role");
    
    // Sadece Admin emergency fix yapabilir
    if (user.role.name !== "Admin") {
      return res.status(403).json({ message: "Sadece Admin emergency fix yapabilir" });
    }

    const tournamentMatch = await TournamentMatch.findById(req.params.id);
    if (!tournamentMatch) {
      return res.status(404).json({ error: "Turnuva maçı bulunamadı" });
    }
    
    if (tournamentMatch.tournamentType !== 'double_elimination') {
      return res.status(400).json({ error: "Bu işlem sadece double elimination turnuvalar için geçerlidir" });
    }

    const wb = tournamentMatch.brackets || [];
    const savedLB = tournamentMatch.loserBrackets || [];
    
    // Check what needs fixing
    const structureCheck = validateTournamentStructure(wb, savedLB);
    const fixes = [];
    
    console.log('🚨 MANUAL EMERGENCY FIX REQUESTED');
    console.log(`Issues found: ${structureCheck.issues.join(', ')}`);
    
    // Force rebuild static topology
    const newStaticLB = buildStaticRepechageTopologyFromWB(wb);
    tournamentMatch.loserBrackets = newStaticLB;
    fixes.push(`Rebuilt LB topology: ${newStaticLB.length} matches`);
    
    // Apply reconciliation
    const reconcileResult = maintainLBOnRead_SameSide(wb, newStaticLB);
    tournamentMatch.loserBrackets = reconcileResult.lb;
    fixes.push(`Reconciliation: ${reconcileResult.reason}`);
    
    // Apply cleanup
    const cleanupResult = cleanupCommonIssues(tournamentMatch);
    if (cleanupResult.fixed) {
      fixes.push(...cleanupResult.fixes);
    }
    
    // Save changes
    await tournamentMatch.save();
    
    console.log(`✅ Emergency fix completed: ${fixes.join(', ')}`);
    
    // Return status
    const finalStructureCheck = validateTournamentStructure(wb, tournamentMatch.loserBrackets);
    
    res.json({
      success: true,
      message: 'Emergency fix tamamlandı',
      data: {
        appliedFixes: fixes,
        beforeIssues: structureCheck.issues,
        afterHealth: {
          isHealthy: !finalStructureCheck.needsEmergencyFix,
          remainingIssues: finalStructureCheck.issues
        },
        loserBracketMatches: tournamentMatch.loserBrackets.length
      }
    });
    
  } catch (error) {
    console.error('Emergency fix hatası:', error);
    res.status(500).json({ error: "Sunucu hatası", details: error.message });
  }
});

module.exports = router; 