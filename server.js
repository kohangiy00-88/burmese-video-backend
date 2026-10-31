const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const PORT = process.env.PORT || 10000;
const TTS_URL = (
  process.env.TTS_URL ||
  "https://burmese-tts-service.onrender.com"
).replace(/\/$/, "");

const ROOT = path.join(__dirname, "storage");
const UPLOADS = path.join(ROOT, "uploads");
const OUTPUTS = path.join(ROOT, "outputs");

[UPLOADS, OUTPUTS].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename: (_req, file, cb) => {
    cb(
      null,
      crypto.randomUUID() + path.extname(file.originalname || ".mp4")
    );
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) {
      return cb(new Error("Video ဖိုင်သာ Upload လုပ်ပါ။"));
    }
    cb(null, true);
  }
});

function fileId(filename) {
  return path.basename(filename, path.extname(filename));
}

function getVideoPath(id) {
  const filename = fs.readdirSync(UPLOADS).find(
    file => fileId(file) === id
  );

  return filename ? path.join(UPLOADS, filename) : null;
}

function getOutputPath(id) {
  return path.join(OUTPUTS, `${id}.mp4`);
}

app.get("/", (_req, res) => {
  res.json({
    success: true,
    status: "OK"
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    status: "OK"
  });
});

// VIDEO UPLOAD
app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "Video မရရှိပါ။"
    });
  }

  res.json({
    success: true,
    file: {
      id: fileId(req.file.filename),
      name: req.file.originalname,
      size: req.file.size
    }
  });
});

// BURMESE TTS
app.post("/api/tts", async (req, res) => {
  try {
    const {
      text,
      voice = "my-MM-NilarNeural"
    } = req.body || {};

    if (!text || !String(text).trim()) {
      return res.status(400).json({
        success: false,
        error: "မြန်မာစာသား ထည့်ပါ။"
      });
    }

    const response = await fetch(`${TTS_URL}/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: String(text),
        voice
      })
    });

    if (!response.ok) {
      throw new Error(`TTS Service Error: ${response.status}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="burmese-voice.mp3"'
    );

    res.send(audio);

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// VIDEO RENDER
app.post("/api/render", async (req, res) => {
  const {
    videoId,
    audioBase64 = null,
    text = "",
    voice = "my-MM-NilarNeural",
    quality = "720p",
    ratio = "original",
    zoom = 1,
    pan = "alternate"
  } = req.body || {};

  const source = getVideoPath(videoId);

  if (!source) {
    return res.status(404).json({
      success: false,
      error: "Video မတွေ့ပါ။ Upload ပြန်လုပ်ပါ။"
    });
  }

  const jobId = crypto.randomUUID();
  const output = getOutputPath(jobId);
  const audioFile = path.join(OUTPUTS, `${jobId}-voice.mp3`);

  try {
    let audioBuffer = null;

    if (audioBase64) {
      audioBuffer = Buffer.from(audioBase64, "base64");

    } else if (text && text.trim()) {
      const ttsResponse = await fetch(`${TTS_URL}/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          voice
        })
      });

      if (!ttsResponse.ok) {
        throw new Error(`TTS Service Error: ${ttsResponse.status}`);
      }

      audioBuffer = Buffer.from(
        await ttsResponse.arrayBuffer()
      );
    }

    if (audioBuffer) {
      fs.writeFileSync(audioFile, audioBuffer);
    }

    const resolutions = {
      "480p": 480,
      "720p": 720,
      "1080p": 1080,
      "1440p": 1440,
      "4K": 2160
    };

    const height = resolutions[quality] || 720;
    const width = Math.round(height * 16 / 9);

    let scaleFilter;

    if (ratio === "9:16") {
      scaleFilter =
        `scale=${height}:${width}:force_original_aspect_ratio=decrease,` +
        `pad=${height}:${width}:(ow-iw)/2:(oh-ih)/2`;

    } else if (ratio === "1:1") {
      scaleFilter =
        `scale=${height}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${height}:${height}:(ow-iw)/2:(oh-ih)/2`;

    } else if (ratio === "4:5") {
      const w = Math.round(height * 4 / 5);

      scaleFilter =
        `scale=${w}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${height}:(ow-iw)/2:(oh-ih)/2`;

    } else if (ratio === "16:9") {
      scaleFilter =
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;

    } else {
      scaleFilter = `scale=-2:${height}`;
    }

    const zoomValue = Math.max(
      1,
      Math.min(1.35, Number(zoom) || 1)
    );

    /*
      Automatic alternating pan:
      Motion shifts left/right on a 5-second cycle.
      Zoom is limited to prevent excessive cropping.
    */

    if (pan === "alternate" && zoomValue > 1) {
      scaleFilter +=
        `,zoompan=` +
        `z='${zoomValue}':` +
        `x='(iw-iw/zoom)*(0.5+0.22*sin(PI*t/5))':` +
        `y='(ih-ih/zoom)/2':` +
        `d=1:` +
        `s=${width}x${height}:` +
        `fps=30`;
    }

    scaleFilter += ",setsar=1";

    await new Promise((resolve, reject) => {
      let command = ffmpeg(source)
        .videoFilters(scaleFilter)
        .videoCodec("libx264")
        .outputOptions([
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart"
        ]);

      if (fs.existsSync(audioFile)) {
        command
          .input(audioFile)
          .outputOptions([
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-shortest",
            "-c:a",
            "aac",
            "-b:a",
            "192k"
          ]);

      } else {
        command.outputOptions([
          "-map",
          "0:v:0",
          "-map",
          "0:a?",
          "-c:a",
          "aac"
        ]);
      }

      command
        .on("end", resolve)
        .on("error", reject)
        .save(output);
    });

    res.json({
      success: true,
      outputId: jobId,
      downloadUrl: `/api/download/${jobId}`
    });

  } catch (error) {
    if (fs.existsSync(output)) {
      fs.unlinkSync(output);
    }

    res.status(500).json({
      success: false,
      error: error.message
    });

  } finally {
    if (fs.existsSync(audioFile)) {
      fs.unlinkSync(audioFile);
    }
  }
});

// MP4 DOWNLOAD
app.get("/api/download/:id", (req, res) => {
  const output = getOutputPath(
    path.basename(req.params.id)
  );

  if (!fs.existsSync(output)) {
    return res.status(404).json({
      success: false,
      error: "Output Video မတွေ့ပါ။"
    });
  }

  res.download(output, "burmese-edited-video.mp4");
});

// ERROR HANDLER
app.use((error, _req, res, _next) => {
  res.status(400).json({
    success: false,
    error: error.message || "Request Error"
  });
});

app.listen(PORT, () => {
  console.log(`Video Backend running on port ${PORT}`);
});
