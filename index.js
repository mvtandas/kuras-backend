require("dotenv").config();
const express = require("express");
const connectDB = require("./config/db");
const cors = require("cors");

const app = express();

// CORS middleware'i tüm route'lardan önce gelmeli
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', [
    'Content-Type',
    'Authorization',
    'referer',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'user-agent'
  ].join(', '));
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // OPTIONS istekleri için hızlı yanıt
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Diğer middleware'ler
app.use(express.json());

// Connect to DB
connectDB();

// Routes
app.use("/api/roles", require("./routes/roles"));
app.use("/api/users", require("./routes/users"));
app.use("/api/cities", require("./routes/cities"));
app.use("/api/clubs", require("./routes/clubs"));
app.use("/api/organisations", require("./routes/organisations"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
