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
      required: true,
      validate: {
        validator: async function(userId) {
          const user = await mongoose.model('User').findById(userId).populate('role');
          return user.role.name === "Athlete"; // 'Sporcu' rolünün adını kontrol et
        },
        message: "Sadece sporcu rolündeki kullanıcılar eklenebilir!"
      }
    },
    weight: { type: Number, required: true }, // Katılımcının kilosu
    coach: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Sorumlu antrenör
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // Ekleyen kullanıcı
    addedAt: { type: Date, default: Date.now } // Eklenme tarihi
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

module.exports = mongoose.model("Organisation", OrganisationSchema);