const mongoose = require('mongoose');
const City = require('../models/city');
const Club = require('../models/club');
require('dotenv').config();

// Türkiye'nin 81 ili
const cities = [
  'Adana', 'Adıyaman', 'Afyon', 'Ağrı', 'Amasya', 'Ankara', 'Antalya', 'Ardahan',
  'Artvin', 'Aydın', 'Balıkesir', 'Bartın', 'Batman', 'Bayburt', 'Bedirhan', 'Bekçi',
  'Bingöl', 'Bitlis', 'Bolu', 'Bozüyük', 'Bursa', 'Çanakkale', 'Çankırı', 'Çarsamba',
  'Çaycuma', 'Çekmece', 'Çine', 'Çorum', 'Çubuk', 'Darende', 'Dargan', 'Davutpasa',
  'Demirel', 'Demirköy', 'Denizli', 'Derince', 'Deryaçık', 'Deva', 'Develi', 'Didim',
  'Diyarbakır', 'Doğubayazıt', 'Doğum', 'Dolmabahçe', 'Dörtyol', 'Döseme', 'Dumlupınar',
  'Dündar', 'Düzce', 'Edirne', 'Ege', 'Elazığ', 'Eldivan', 'Eleşkirt', 'Elmalı',
  'Elmadağ', 'Elvanlar', 'Emirdağ', 'Enez', 'Erbaa', 'Erciş', 'Erdek', 'Erdemli',
  'Eren', 'Ereğli', 'Erganı', 'Ermenek', 'Eros', 'Erzin', 'Erzincan', 'Erzurum',
  'Esenler', 'Esenyurt', 'Esentepe', 'Esme', 'Espiye', 'Estil'
];

// İlk 81 ili al
const turkeyCities = cities.slice(0, 81);

mongoose.connect(process.env.MONGO_URI).then(async () => {
  try {
    // Mevcut şehir ve kulüpleri sil
    await City.deleteMany({});
    await Club.deleteMany({});
    console.log('🗑️  Eski veriler temizlendi');

    // Şehirleri oluştur
    const createdCities = await City.insertMany(
      turkeyCities.map(name => ({ name }))
    );
    console.log(`✅ ${createdCities.length} şehir oluşturuldu`);

    // Her şehir için "Gençlik ve Spor Kulübü" oluştur
    const clubsToCreate = createdCities.map(city => ({
      name: `${city.name} Gençlik ve Spor Kulübü`,
      city: city._id,
      createdAt: new Date()
    }));

    await Club.insertMany(clubsToCreate);
    console.log(`✅ ${clubsToCreate.length} kulüp oluşturuldu`);

    console.log('\n🎉 Tüm şehirler ve kulüpler başarıyla oluşturuldu!');
    console.log('📊 Özet:');
    console.log(`  - Şehir sayısı: ${createdCities.length}`);
    console.log(`  - Kulüp sayısı: ${clubsToCreate.length}`);
    console.log(`  - Her şehire 1 tane "Gençlik ve Spor Kulübü" bağlandı`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Hata:', error.message);
    process.exit(1);
  }
});
