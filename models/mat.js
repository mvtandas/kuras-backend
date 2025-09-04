const mongoose = require('mongoose');

const matSchema = new mongoose.Schema({
  organisationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organisation',
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0
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
matSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Aynı organizasyon içinde mat isimlerinin unique olması
matSchema.index({ organisationId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Mat', matSchema);
