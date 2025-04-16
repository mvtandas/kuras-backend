require("dotenv").config();
const express = require("express");
const connectDB = require("./config/db");
const cors = require("cors");

const app = express();

app.options("*", cors()); // Tüm preflight isteklerine cevap ver

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
app.use("/api/belts", require("./routes/belts"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
