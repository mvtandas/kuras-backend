const express = require("express");
const router = express.Router();
const Role = require("../models/role");
const auth = require("../middleware/auth");

// Create a role
router.post("/", async (req, res) => {
  const { name } = req.body;

  if (!name) return res.status(400).json({ message: "Name is required" });

  try {
    const role = new Role({ name });
    await role.save();
    res.status(201).json(role);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all roles
router.get("/", auth, async (req, res) => {
  try {
    // Admin kontrolü
    console.log(req.user.role);
    if (req.user.role.name !== "Admin") {
      return res.status(403).json({ message: "Bu işlem için yetkiniz bulunmamaktadır" });
    }

    const roles = await Role.find();
    res.status(200).json(roles);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete a role
router.delete("/:id", async (req, res) => {
  try {
    const role = await Role.findByIdAndDelete(req.params.id);
    if (!role) return res.status(404).json({ message: "Role not found" });
    res.status(200).json({ message: "Role deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
