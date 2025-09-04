const mongoose = require('mongoose');

const matAssignmentSchema = new mongoose.Schema({
  matId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mat',
    required: true
  },
  organisationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organisation',
    required: true
  },
  tournamentMatchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TournamentMatch',
    required: true
  },
  // Round robin için matchId, elimination için matchNumber
  matchIdentifier: {
    roundRobinMatchId: {
      type: String, // round_1_match_1 gibi
      default: null
    },
    eliminationMatchNumber: {
      type: Number, // bracket matchNumber
      default: null
    },
    isLoserBracket: {
      type: Boolean,
      default: false
    }
  },
  // Maç detayları (hızlı erişim için)
  matchDetails: {
    weightCategory: String,
    gender: String,
    roundNumber: Number,
    tournamentType: String,
    player1Name: String,
    player2Name: String
  },
  status: {
    type: String,
    enum: ['assigned', 'in_progress', 'completed', 'cancelled'],
    default: 'assigned'
  },
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  assignmentType: {
    type: String,
    enum: ['manual', 'automatic'],
    default: 'manual'
  },
  scheduledTime: {
    type: Date
  },
  startedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  },
  notes: {
    type: String,
    default: ''
  },
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
matAssignmentSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Aynı maçın birden fazla mindere atanmaması için unique index
matAssignmentSchema.index({ 
  tournamentMatchId: 1, 
  'matchIdentifier.roundRobinMatchId': 1,
  'matchIdentifier.eliminationMatchNumber': 1,
  'matchIdentifier.isLoserBracket': 1
}, { 
  unique: true,
  partialFilterExpression: {
    $or: [
      { 'matchIdentifier.roundRobinMatchId': { $ne: null } },
      { 'matchIdentifier.eliminationMatchNumber': { $ne: null } }
    ]
  }
});

// Aynı zamanda aynı minderin birden fazla maça atanmaması
matAssignmentSchema.index({ 
  matId: 1, 
  scheduledTime: 1 
}, { 
  unique: true,
  partialFilterExpression: {
    scheduledTime: { $ne: null },
    status: { $in: ['assigned', 'in_progress'] }
  }
});

module.exports = mongoose.model('MatAssignment', matAssignmentSchema);
