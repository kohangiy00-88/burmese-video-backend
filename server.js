import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// Basic setup
// --------------------

app.use(cors());
app.use(express.json());

const uploadDir = path.join(os.tmpdir(), "burmese-video-uploads");
const audioDir = path.join(os.tmpdir(), "burmese-video-audio");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

// --------------------
// Multer upload setup
// --------------------

const storage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, uploadDir);
  },

  filename: (req, file, callback) => {
    const safeName = file.originalname.replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );

    callback(
      null,
      `${crypto.randomUUID()}-${safeName}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 1024 * 1024 * 1024
  },

  fileFilter: (req, file, callback) => {
    if (file.mimetype.startsWith("video/")) {
      callback(null, true);
    } else {
      callback(
        new Error("Video ဖိုင်ကိုသာ Upload လုပ်နိုင်ပါတယ်။")
      );
    }
  }
});

// --------------------
// Health check
// --------------------

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

// --------------------
// Upload video
// --------------------

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Video ဖိုင် မရရှိပါ။"
    });
  }

  res.json({
    success: true,
    message: "Video Upload အောင်မြင်ပါပြီ။",
    file: {
      name: req.file.originalname,
      size: req.file.size,
      path: req.file.path
    }
  });
});

// --------------------
// Extract audio from video
// --------------------

app.post(
  "/api/extract-audio",
  upload.single("video"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Video ဖိုင် မရရှိပါ။"
      });
    }

    if (!ffmpegPath) {
      fs.unlink(req.file.path, () => {});

      return res.status(500).json({
        success: false,
        message: "FFmpeg ကို ရှာမတွေ့ပါ။"
      });
    }

    const audioId = crypto.randomUUID();
    const audioPath = path.join(
      audioDir,
      `${audioId}.mp3`
    );

    const ffmpeg = spawn(ffmpegPath, [
      "-y",
      "-i", req.file.path,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "64k",
      audioPath
    ]);

    let errorText = "";
    let responded = false;

    ffmpeg.stderr.on("data", (data) => {
      errorText += data.toString();
    });

    ffmpeg.on("error", (error) => {
      console.error("FFmpeg start error:", error);

      fs.unlink(req.file.path, () => {});

      if (!responded) {
        responded = true;

        res.status(500).json({
          success: false,
          message: "FFmpeg ကို စတင်မရပါ။"
        });
      }
    });

    ffmpeg.on("close", (code) => {
      fs.unlink(req.file.path, () => {});

      if (responded) {
        return;
      }

      if (code !== 0 || !fs.existsSync(audioPath)) {
        console.error("FFmpeg failed:", errorText);

        responded = true;

        return res.status(500).json({
          success: false,
          message:
            "အသံခွဲထုတ်ခြင်း မအောင်မြင်ပါ။ Video ဖိုင်ကို စစ်ဆေးပါ။"
        });
      }

      responded = true;

      res.json({
        success: true,
        message: "အသံခွဲထုတ်ခြင်း အောင်မြင်ပါပြီ။",
        audio: {
          id: audioId,
          downloadUrl: `/api/audio/${audioId}`
        }
      });
    });
  }
);

// --------------------
// Download extracted audio
// --------------------

app.get("/api/audio/:id", (req, res) => {
  const audioId = req.params.id;

  if (!/^[a-f0-9-]+$/i.test(audioId)) {
    return res.status(400).json({
      success: false,
      message: "Audio ID မမှန်ပါ။"
    });
  }

  const audioPath = path.join(
    audioDir,
    `${audioId}.mp3`
  );

  if (!fs.existsSync(audioPath)) {
    return res.status(404).json({
      success: false,
      message: "Audio ဖိုင် မတွေ့ပါ။"
    });
  }

  res.download(audioPath, "video-audio.mp3");
});

// --------------------
// Error handler
// --------------------

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(400).json({
    success: false,
    message:
      error.message || "တစ်ခုခု မှားယွင်းနေပါတယ်။"
  });
});

// --------------------
// Start server
// --------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
