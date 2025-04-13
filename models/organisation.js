const mongoose = require("mongoose");

const OrganisationSchema = new mongoose.Schema({
  // Turnuva Bilgileri
  tournamentName: { type: String, required: true }, // Turnuva Adı (Opsiyonel ama önerilir)
  tournamentPlace: { 
    city: { type: mongoose.Schema.Types.ObjectId, ref: "City", required: true }, // Şehir referansı
    venue: { type: String, required: true } // Spesifik mekan (salon, stadyum vb.)
  },
  tournamentDate: { 
    startDate: { type: Date, required: true }, // Başlangıç Tarihi
    endDate: { type: Date } // Bitiş Tarihi (Opsiyonel)
  },
  
  // Katılım Şartları
  birthDateRequirements: {
    minDate: { type: Date }, // Minimum Doğum Tarihi
    maxDate: { type: Date }  // Maksimum Doğum Tarihi
  },
  beltRequirement: { type: mongoose.Schema.Types.ObjectId, ref: "Belt" }, // İzin Verilen Kemer
  
  // Ağırlık Gereksinimleri
  weightsRequirementsMens: [{ type: String }], // Erkekler için ağırlık kategorileri (string olarak değiştirildi)
  weightsRequirementsWomens: [{ type: String }], // Kadınlar için ağırlık kategorileri (string olarak değiştirildi)
  
  // Katılımcılar (Detaylı Bilgilerle)
  participants: [{
    athlete: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    weight: { type: Number, required: true },
    coach: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    addedAt: { type: Date, default: Date.now }
  }],

  // Durum Bilgisi
  status: { 
    type: String, 
    enum: ['Aktif', 'Pasif'], 
    default: 'Aktif' 
  },

  // Ek Bilgiler
  createdAt: { type: Date, default: Date.now }
});

// Pre-save middleware ile katılımcıları kontrol et ve temizle
OrganisationSchema.pre('save', async function(next) {
  if (this.isModified('participants')) {
    try {
      // Tüm katılımcıların athlete ID'lerini al
      const athleteIds = this.participants.map(p => p.athlete);
      
      // Tüm sporcuları bir kerede getir
      const athletes = await mongoose.model('User')
        .find({ _id: { $in: athleteIds } })
        .populate('role');
      
      // Geçerli sporcuların ID'lerini oluştur
      const validAthleteIds = new Set(
        athletes
          .filter(athlete => athlete && athlete.role && athlete.role.name === "Athlete")
          .map(athlete => athlete._id.toString())
      );
      
      // Geçerli katılımcıları filtrele
      this.participants = this.participants.filter(p => 
        p.athlete && validAthleteIds.has(p.athlete.toString())
      );
    } catch (error) {
      console.error('Katılımcı temizleme hatası:', error);
      // Hata durumunda tüm katılımcıları temizle
      this.participants = [];
    }
  }
  next();
});

module.exports = mongoose.model("Organisation", OrganisationSchema);