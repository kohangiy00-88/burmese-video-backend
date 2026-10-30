import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const uploadDir = path.join(os.tmpdir(), "video-uploads");

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, crypto.randomUUID() + "-" + safeName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Video ဖိုင်ကိုသာ တင်နိုင်ပါတယ်။"));
    }
  }
});

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Burmese Video Backend is running!"
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "OK"
  });
});

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Video ဖိုင် မရရှိပါ။"
    });
  }

  res.json({
    success: true,
    message: "Video upload အောင်မြင်ပါတယ်။",
    file: {
      name: req.file.originalname,
      size: req.file.size,
      path: req.file.path
    }
  });
});

app.use((error, req, res, next) => {
  console.error(error);

  res.status(400).json({
    success: false,
    message: error.message || "Upload မအောင်မြင်ပါ။"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
