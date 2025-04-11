const jwt = require("jsonwebtoken");
const BlacklistedToken = require("../models/blacklistedToken");
const User = require("../models/user");

const auth = async (req, res, next) => {
  // CORS için OPTIONS isteğini kontrol et
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ message: "Yetkilendirme token'ı bulunamadı" });
    }

    // Token blacklist'te mi kontrol et
    const isBlacklisted = await BlacklistedToken.findOne({ token });
    if (isBlacklisted) {
      return res.status(401).json({ message: "Geçersiz token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("Token'dan çözülen bilgiler:", decoded);
    
    // Kullanıcı bilgilerini populate et
    const user = await User.findById(decoded.id)
      .populate({
        path: 'role',
        select: 'name'
      })
      .populate({
        path: 'city',
        select: 'name _id'
      })
      .populate({
        path: 'club',
        select: 'name _id'
      })
      .populate({
        path: 'belt',
        select: 'name value _id'
      });

    if (!user) {
      return res.status(401).json({ message: "Kullanıcı bulunamadı" });
    }

    console.log("Populate edilmiş kullanıcı bilgileri:", {
      id: user._id,
      name: user.name,
      role: user.role,
      city: user.city,
      club: user.club,
      belt: user.belt
    });

    req.user = user;
    
    // CORS headers ekle
    // res.header('Access-Control-Allow-Origin', 'http://localhost:3000');
    // res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    next();
  } catch (err) {
    console.error("Auth middleware hatası:", err);
    res.status(401).json({ message: "Geçersiz token" });
  }
};

module.exports = auth; 