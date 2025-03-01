const mongoose = require("mongoose");

const OrganisationSchema = new mongoose.Schema({
  // Turnuva Bilgileri
  tournamentName: { type: String, required: true }, // Turnuva Adı (Opsiyonel ama önerilir)
  tournamentPlace: { type: String, required: true }, // Turnuva Yeri
  tournamentDate: { 
    startDate: { type: Date, required: true }, // Başlangıç Tarihi
    endDate: { type: Date } // Bitiş Tarihi (Opsiyonel)
  },
  
  // Katılım Şartları
  birthDateRequirements: {
    minDate: { type: Date }, // Minimum Doğum Tarihi
    maxDate: { type: Date }  // Maksimum Doğum Tarihi
  },
  beltRequirement: [{ type: String }], // İzin Verilen Kuşaklar (Örnek: ["Mavi", "Siyah"])
  participationType: { 
    type: String, 
    enum: ['Sporcu Erkek', 'Sporcu Kadın', 'Antrenör', 'Hakem'], 
    required: true 
  }, // Katılım Tipi
  
  // Katılımcılar (Sadece Sporcu Rolündeki Kullanıcılar)
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    validate: {
      validator: async function(userId) {
        const user = await mongoose.model('User').findById(userId).populate('role');
        return user.role.name === "Athlete"; // 'Sporcu' rolünün adını kontrol et
      },
      message: "Sadece sporcu rolündeki kullanıcılar eklenebilir!"
    }
  }],

  // Ek Bilgiler
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Organisation", OrganisationSchema);