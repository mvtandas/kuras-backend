const mongoose = require('mongoose');
const User = require('../models/user');
const Belt = require('../models/belt');
require('dotenv').config();

// Veritabanına bağlan
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB bağlantısı başarılı'))
  .catch(err => console.error('MongoDB bağlantı hatası:', err));

async function migrateBelts() {
  try {
    // Tüm kemerleri getir
    const belts = await Belt.find();
    const beltMap = {};
    
    // Kemer adı -> kemer ID eşleştirmesi oluştur
    belts.forEach(belt => {
      beltMap[belt.name] = belt._id;
    });
    
    // Tüm kullanıcıları getir
    const users = await User.find({ belt: { $exists: true, $ne: null } });
    console.log(`${users.length} kullanıcı için kemer güncellemesi yapılacak`);
    
    // Her kullanıcı için
    for (const user of users) {
      const beltName = user.belt;
      
      // Eğer kullanıcının kemeri varsa ve bu kemer veritabanında mevcutsa
      if (beltName && beltMap[beltName]) {
        // Kullanıcının kemer alanını güncelle
        user.belt = beltMap[beltName];
        await user.save();
        console.log(`${user.name} ${user.surname} kullanıcısının kemeri güncellendi: ${beltName}`);
      } else if (beltName) {
        console.log(`Uyarı: "${beltName}" kemeri veritabanında bulunamadı - ${user.name} ${user.surname}`);
      }
    }
    
    console.log('Kemer geçişi tamamlandı');
    process.exit(0);
  } catch (error) {
    console.error('Hata:', error);
    process.exit(1);
  }
}

migrateBelts(); 