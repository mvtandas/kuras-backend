const jwt = require("jsonwebtoken");
const BlacklistedToken = require("../models/blacklistedToken");

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
    req.user = decoded;
    
    // CORS headers ekle
    // res.header('Access-Control-Allow-Origin', 'http://localhost:3000');
    // res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    next();
  } catch (err) {
    res.status(401).json({ message: "Geçersiz token" });
  }
};

module.exports = auth; 