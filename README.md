# 🥋 Kuras — Judo Tournament Management System (Backend)

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)

**Kuras turnuva yönetim sisteminin REST API backend servisi.**

</div>

---

## ✨ Özellikler

- 🔐 **JWT Authentication** — Güvenli kullanıcı kimlik doğrulama
- 👥 **Kullanıcı & Rol Yönetimi** — Admin, hakem, organizatör rolleri
- 🏆 **Turnuva Maç Yönetimi** — CRUD işlemleri ve bracket mantığı
- 🥋 **Sporcu & Kulüp Yönetimi** — Kayıt, güncelleme, filtreleme
- 🏟 **Mat Atama Sistemi** — Çoklu alan yönetimi
- 📄 **PDF Oluşturma** — PDFKit ile turnuva raporları

## 🛠 Teknolojiler

| Teknoloji | Versiyon |
|-----------|----------|
| Node.js | 14.x - 20.x |
| Express | 4.21.2 |
| MongoDB + Mongoose | 8.9.5 |
| JWT | 9.0.2 |
| Bcrypt | 5.1.1 |
| PDFKit | 0.16.0 |
| CORS | 2.8.5 |

## 📡 API Endpoints

```
POST   /api/users              # Kullanıcı kayıt
POST   /api/users/login        # Giriş
GET    /api/roles              # Roller
CRUD   /api/clubs              # Kulüp yönetimi
CRUD   /api/organisations      # Organizasyon yönetimi
CRUD   /api/tournament-matches # Turnuva maçları
CRUD   /api/mats               # Mat yönetimi
CRUD   /api/mat-assignments    # Mat atamaları
GET    /api/cities             # Şehir listesi
GET    /api/belts              # Kuşak sistemi
```

## 🚀 Kurulum

```bash
git clone https://github.com/mvtandas/kuras-backend.git
cd kuras-backend
npm install
cp .env.example .env  # MongoDB URI ve JWT secret ayarla
npm run dev
```

> 🖥 Frontend için: [kuras-frontend](https://github.com/mvtandas/kuras-frontend)

## 📝 Lisans

MIT
