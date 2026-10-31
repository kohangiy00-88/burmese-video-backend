const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;
const TTS_URL =
  process.env.TTS_URL || "https://burmese-tts-service.onrender.com";

ffmpeg.setFfmpegPath(ffmpegPath);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const UPLOAD_DIR = path.join(os.tmpdir(), "burmese-video-uploads");
const OUTPUT_DIR = path.join(os.tmpdir(), "burmese-video-outputs");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname) || ".mp4";
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024,
  },
});

const videoFiles = new Map();
const audioFiles = new Map();
const outputFiles = new Map();

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Burmese Video Backend is running",
    tts: TTS_URL,
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
  });
});

/*
  VIDEO UPLOAD
  POST /api/upload
*/

app.post("/api/upload", upload.single("video"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Video ဖိုင် မတွေ့ပါ။",
      });
    }

    const id = path.parse(req.file.filename).name;

    videoFiles.set(id, req.file.path);

    res.json({
      success: true,
      file: {
        id,
        name: req.file.originalname,
        size: req.file.size,
        path: req.file.path,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/*
  AUDIO EXTRACTION
  POST /api/extract-audio
  Body: { "videoId": "uploaded-video-id" }
*/

app.post("/api/extract-audio", async (req, res) => {
  try {
    const { videoId } = req.body;

    const videoPath = videoFiles.get(videoId);

    if (!videoPath || !fs.existsSync(videoPath)) {
      return res.status(404).json({
        success: false,
        message: "Video ဖိုင် မတွေ့ပါ။",
      });
    }

    const audioId = crypto.randomUUID();
    const audioPath = path.join(OUTPUT_DIR, `${audioId}.mp3`);

    ffmpeg(videoPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .save(audioPath)
      .on("end", () => {
        audioFiles.set(audioId, audioPath);

        res.json({
          success: true,
          audio: {
            id: audioId,
            name: `${audioId}.mp3`,
            url: `/api/audio/${audioId}`,
          },
        });
      })
      .on("error", (error) => {
        res.status(500).json({
          success: false,
          message: error.message,
        });
      });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/*
  DOWNLOAD EXTRACTED AUDIO
  GET /api/audio/:id
*/

app.get("/api/audio/:id", (req, res) => {
  const audioPath = audioFiles.get(req.params.id);

  if (!audioPath || !fs.existsSync(audioPath)) {
    return res.status(404).json({
      success: false,
      message: "Audio ဖိုင် မတွေ့ပါ။",
    });
  }

  res.download(audioPath);
});

/*
  BURMESE TEXT TO SPEECH
  POST /api/tts
  Body: { "text": "မြန်မာစာသား", "voice": "male" }
*/

app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice = "male" } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: "မြန်မာစာသား ထည့်ပေးပါ။",
      });
    }

    const response = await fetch(`${TTS_URL}/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();

      return res.status(response.status).json({
        success: false,
        message: errorText || "မြန်မာအသံ ထုတ်မရပါ။",
      });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="burmese-voice.mp3"'
    );

    res.send(audioBuffer);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/*
  RENDER VIDEO WITH BURMESE VOICE
  POST /api/render
  Body:
  {
    "videoId": "uploaded-video-id",
    "audioId": "generated-audio-id"
  }

  Note:
  Audio/video length mismatch မှာ အသံကို မူရင်းဗီဒီယိုအရှည်နဲ့ညှိပေးတယ်။
*/

app.post("/api/render", async (req, res) => {
  try {
    const { videoId, audioId } = req.body;

    const videoPath = videoFiles.get(videoId);
    const audioPath = audioFiles.get(audioId);

    if (!videoPath || !fs.existsSync(videoPath)) {
      return res.status(404).json({
        success: false,
        message: "Video ဖိုင် မတွေ့ပါ။",
      });
    }

    if (!audioPath || !fs.existsSync(audioPath)) {
      return res.status(404).json({
        success: false,
        message: "မြန်မာအသံ MP3 ဖိုင် မတွေ့ပါ။",
      });
    }

    const outputId = crypto.randomUUID();
    const outputPath = path.join(OUTPUT_DIR, `${outputId}.mp4`);

    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map 0:v:0",
        "-map 1:a:0",
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-c:a aac",
        "-b:a 192k",
        "-shortest",
        "-movflags +faststart",
      ])
      .format("mp4")
      .save(outputPath)
      .on("end", () => {
        outputFiles.set(outputId, outputPath);

        res.json({
          success: true,
          output: {
            id: outputId,
            name: "burmese-video.mp4",
            url: `/api/download/${outputId}`,
          },
        });
      })
      .on("error", (error) => {
        res.status(500).json({
          success: false,
          message: error.message,
        });
      });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/*
  MP4 DOWNLOAD
  GET /api/download/:id
*/

app.get("/api/download/:id", (req, res) => {
  const outputPath = outputFiles.get(req.params.id);

  if (!outputPath || !fs.existsSync(outputPath)) {
    return res.status(404).json({
      success: false,
      message: "MP4 ဖိုင် မတွေ့ပါ။",
    });
  }

  res.download(outputPath, "burmese-video.mp4");
});

/*
  ERROR HANDLER
*/

app.use((error, req, res, next) => {
  console.error(error);

  if (error instanceof multer.MulterError) {
    return res.status(413).json({
      success: false,
      message: "Upload ဖိုင်အရွယ်အစား 1 GB ထက် ကျော်နေပါတယ်။",
    });
  }

  res.status(500).json({
    success: false,
    message: error.message || "Server error",
  });
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
