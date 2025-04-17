require("dotenv").config();
const express = require("express");
const connectDB = require("./config/db");
const cors = require("cors");

const app = express();

// ✅ CORS middleware (en başta ve doğru şekilde)
const allowedOrigins = ['https://www.turkiyekuras.com','http://localhost:5173','https://turkiyekuras.com'];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.options("*", cors()); // preflight requests

// 🔧 Diğer middleware'ler
app.use(express.json());

// 🔌 Veritabanı bağlantısı
connectDB();

// 🛣️ Rotalar
app.use("/api/roles", require("./routes/roles"));
app.use("/api/users", require("./routes/users"));
app.use("/api/cities", require("./routes/cities"));
app.use("/api/clubs", require("./routes/clubs"));
app.use("/api/organisations", require("./routes/organisations"));
app.use("/api/belts", require("./routes/belts"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
