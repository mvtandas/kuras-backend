const mongoose = require('mongoose');
const Organisation = require('../models/organisation');
require('dotenv').config();

// Veritabanına bağlan
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB bağlantısı başarılı'))
  .catch(err => console.error('MongoDB bağlantı hatası:', err));

async function migrateOrganisationBelts() {
  try {
    // Tüm organizasyonları getir
    const organisations = await Organisation.find();
    console.log(`${organisations.length} organizasyon için kemer güncellemesi yapılacak`);
    
    // Her organizasyon için
    for (const org of organisations) {
      // Eğer beltRequirement bir dizi ise ve en az bir eleman içeriyorsa
      if (Array.isArray(org.beltRequirement) && org.beltRequirement.length > 0) {
        // İlk elemanı al
        org.beltRequirement = org.beltRequirement[0];
        await org.save();
        console.log(`${org.tournamentName} organizasyonunun kemer gereksinimi güncellendi`);
      } else if (Array.isArray(org.beltRequirement) && org.beltRequirement.length === 0) {
        // Boş dizi ise null yap
        org.beltRequirement = null;
        await org.save();
        console.log(`${org.tournamentName} organizasyonunun kemer gereksinimi null olarak ayarlandı`);
      }
    }
    
    console.log('Organizasyon kemer geçişi tamamlandı');
    process.exit(0);
  } catch (error) {
    console.error('Hata:', error);
    process.exit(1);
  }
}

migrateOrganisationBelts(); 