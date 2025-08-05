const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  participantId: {
    type: mongoose.Schema.Types.ObjectId,
    required: function() {
      return !this.isBye && this.name !== "BYE"; // BYE değilse required
    },
    validate: {
      validator: function(v) {
        // Eğer BYE ise veya null ise geçerli
        if (this.isBye || this.name === "BYE" || v === null || v === undefined) {
          return true;
        }
        // Değilse ObjectId olmalı
        return mongoose.Types.ObjectId.isValid(v);
      },
      message: 'Geçerli bir ObjectId olmalı'
    }
  },
  athleteId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function() {
      return !this.isBye && this.name !== "BYE"; // BYE değilse required
    },
    validate: {
      validator: function(v) {
        // Eğer BYE ise veya null ise geçerli
        if (this.isBye || this.name === "BYE" || v === null || v === undefined) {
          return true;
        }
        // Değilse ObjectId olmalı
        return mongoose.Types.ObjectId.isValid(v);
      },
      message: 'Geçerli bir ObjectId olmalı'
    }
  },
  name: {
    type: String,
    required: function() {
      return !this.isBye && this.name !== "BYE"; // BYE değilse required
    }
  },
  city: {
    type: String,
    required: function() {
      return !this.isBye && this.name !== "BYE"; // BYE değilse required
    }
  },
  club: {
    type: String,
    required: function() {
      return !this.isBye && this.name !== "BYE"; // BYE değilse required
    }
  },
  coach: {
    type: String,
    default: ''
  },
  isBye: {
    type: Boolean,
    default: false
  }
});

const scoreSchema = new mongoose.Schema({
  player1Score: {
    type: Number,
    default: 0
  },
  player2Score: {
    type: Number,
    default: 0
  }
});

const matchSchema = new mongoose.Schema({
  matchId: {
    type: String,
    required: true
  },
  player1: {
    type: playerSchema,
    required: false
  },
  player2: {
    type: playerSchema,
    required: false
  },
  status: {
    type: String,
    enum: ['scheduled', 'in_progress', 'completed'],
    default: 'scheduled'
  },
  winner: {
    type: String,
    enum: ['player1', 'player2', null],
    default: null
  },
  score: {
    type: scoreSchema,
    default: () => ({})
  },
  scheduledTime: {
    type: Date
  },
  completedAt: {
    type: Date
  },
  notes: {
    type: String,
    default: ''
  }
});

const roundSchema = new mongoose.Schema({
  roundNumber: {
    type: Number,
    required: true
  },
  matches: [matchSchema]
});

const bracketSchema = new mongoose.Schema({
  roundNumber: {
    type: Number,
    required: true
  },
  matchNumber: {
    type: Number,
    required: true
  },
  player1: {
    type: playerSchema,
    required: false
  },
  player2: {
    type: playerSchema,
    required: false
  },
  status: {
    type: String,
    enum: ['scheduled', 'in_progress', 'completed'],
    default: 'scheduled'
  },
  winner: {
    type: String,
    enum: ['player1', 'player2', null],
    default: null
  },
  score: {
    type: scoreSchema,
    default: () => ({})
  },
  scheduledTime: {
    type: Date
  },
  completedAt: {
    type: Date
  },
  nextMatchNumber: {
    type: Number
  },
  nextMatchSlot: {
    type: String,
    enum: ['player1', 'player2']
  },
  notes: {
    type: String,
    default: ''
  }
});

const tournamentMatchSchema = new mongoose.Schema({
  organisationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organisation',
    required: true
  },
  weightCategory: {
    type: String,
    required: true
  },
  gender: {
    type: String,
    enum: ['Erkek', 'Kadın'],
    required: true
  },
  tournamentType: {
    type: String,
    enum: ['round_robin', 'single_elimination'],
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'cancelled'],
    default: 'active'
  },
  rounds: [roundSchema],
  brackets: [bracketSchema],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Güncelleme zamanını otomatik olarak ayarla
tournamentMatchSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Turnuva istatistiklerini hesaplayan metod
tournamentMatchSchema.methods.getStats = function() {
  const stats = {
    totalMatches: 0,
    completedMatches: 0,
    pendingMatches: 0,
    winners: []
  };
  
  if (this.tournamentType === 'round_robin') {
    this.rounds.forEach(round => {
      round.matches.forEach(match => {
        stats.totalMatches++;
        if (match.status === 'completed') {
          stats.completedMatches++;
          if (match.winner) {
            stats.winners.push(match[match.winner]);
          }
        } else {
          stats.pendingMatches++;
        }
      });
    });
  } else {
    this.brackets.forEach(match => {
      stats.totalMatches++;
      if (match.status === 'completed') {
        stats.completedMatches++;
        if (match.winner) {
          stats.winners.push(match[match.winner]);
        }
      } else {
        stats.pendingMatches++;
      }
    });
  }
  
  return stats;
};

// Kazananı bir sonraki maça yerleştiren metod
tournamentMatchSchema.methods.advanceWinner = function(matchId) {
  if (this.tournamentType === 'single_elimination') {
    const match = this.brackets.find(m => m.matchNumber === parseInt(matchId));
    
    if (match && match.winner && match.nextMatchNumber) {
      const nextMatch = this.brackets.find(m => m.matchNumber === match.nextMatchNumber);
      if (nextMatch) {
        nextMatch[match.nextMatchSlot] = match[match.winner];
      }
    }
  }
};

module.exports = mongoose.model('TournamentMatch', tournamentMatchSchema); 