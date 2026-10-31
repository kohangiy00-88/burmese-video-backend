const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const AdmZip = require("adm-zip");
const { v4: uuidv4 } = require("uuid");

const app = express();
const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const TTS_URL = (process.env.TTS_URL || "").replace(/\/+$/, "");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const MAX_SIZE = 1024 * 1024 * 1024;
const MAX_DURATION = 350 * 60;

const uploadDir = path.join(DATA_DIR, "uploads");
const outputDir = path.join(DATA_DIR, "outputs");
const jobsDir = path.join(DATA_DIR, "jobs");

for (const dir of [uploadDir, outputDir, jobsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const jobs = new Map();
const uploads = new Map();

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname || ".mp4")}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_SIZE
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowed = [
      ".mp4", ".mov", ".mkv", ".webm",
      ".avi", ".m4v", ".mpeg", ".mpg"
    ];

    if (allowed.includes(ext) || file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Video ဖိုင်အမျိုးအစားကိုသာ Upload လုပ်နိုင်ပါတယ်။"));
    }
  }
});

function getJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error("Job ကို ရှာမတွေ့ပါ။");
  return job;
}

function updateJob(id, values) {
  const old = getJob(id);
  jobs.set(id, { ...old, ...values, updatedAt: Date.now() });
}

async function probe(file) {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    file
  ]);

  const data = JSON.parse(stdout);
  const video = (data.streams || []).find(s => s.codec_type === "video");
  const audio = (data.streams || []).some(s => s.codec_type === "audio");

  if (!video) throw new Error("Video Stream မတွေ့ပါ။");

  return {
    duration: Number(data.format?.duration || 0),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    hasAudio: audio
  };
}

function runProcess(command, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let errorText = "";

    child.stderr.on("data", chunk => {
      const text = chunk.toString();
      errorText += text;

      const match = text.match(
        /time=(\d+):(\d+):(\d+(?:\.\d+)?)/ 
      );

      if (match && onProgress) {
        const seconds =
          Number(match[1]) * 3600 +
          Number(match[2]) * 60 +
          Number(match[3]);

        onProgress(seconds);
      }
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(errorText.slice(-2500) || `Process error ${code}`));
    });
  });
}

function toSrtTime(ms) {
  ms = Math.max(0, Math.floor(ms));

  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;

  return (
    String(hours).padStart(2, "0") + ":" +
    String(minutes).padStart(2, "0") + ":" +
    String(seconds).padStart(2, "0") + "," +
    String(millis).padStart(3, "0")
  );
}

function makeSrt(text, duration) {
  const lines = String(text)
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[။.!?])\s*/u))
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new Error("စာသား မထည့်ထားပါ။");
  }

  const total = Math.max(1, lines.length);
  const interval = Math.max(1500, (duration * 1000) / total);

  return lines.map((line, i) => {
    const start = Math.floor(i * interval);
    const end = Math.min(
      Math.floor((i + 1) * interval),
      Math.floor(duration * 1000)
    );

    return `${i + 1}\n${toSrtTime(start)} --> ${toSrtTime(Math.max(start + 800, end))}\n${line}\n`;
  }).join("\n");
}

function assColor(hex, alpha = "00") {
  let value = String(hex || "#FFFFFF").replace("#", "");

  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    value = "FFFFFF";
  }

  const r = value.substring(0, 2);
  const g = value.substring(2, 4);
  const b = value.substring(4, 6);

  return `&H${alpha}${b}${g}${r}`;
}

function getOutputSize(quality, ratio, source) {
  const height = Math.max(
    480,
    Math.min(2160, Number(quality) || 720)
  );

  let width;

  switch (ratio) {
    case "16:9":
      width = height * 16 / 9;
      break;
    case "9:16":
      width = height * 9 / 16;
      break;
    case "1:1":
      width = height;
      break;
    case "4:5":
      width = height * 4 / 5;
      break;
    default:
      width = height * (source.width / Math.max(1, source.height));
  }

  return {
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2)
  };
}

function safeSubtitleFilter(srtPath, options) {
  const positionMap = {
    bottom: 2,
    middle: 5,
    top: 8
  };

  const fontSize = Math.max(
    18,
    Math.min(90, Number(options.subtitleSize) || 36)
  );

  const outlineWidth = Math.max(
    0,
    Math.min(8, Number(options.outlineWidth) || 2)
  );

  const primary = assColor(options.subtitleColor || "#FFFFFF");
  const outline = assColor(options.outlineColor || "#000000");

  const background = options.subtitleBackground === "black";
  const borderStyle = background ? 3 : 1;
  const backColour = background ? "&H80000000" : "&H00000000";
  const alignment = positionMap[options.subtitlePosition] || 2;

  const cleanPath = srtPath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:");

  const style = [
    "FontName=Noto Sans Myanmar",
    `FontSize=${fontSize}`,
    `PrimaryColour=${primary}`,
    `OutlineColour=${outline}`,
    `BorderStyle=${borderStyle}`,
    `BackColour=${backColour}`,
    `Outline=${outlineWidth}`,
    "Shadow=0",
    `Alignment=${alignment}`,
    "MarginV=35",
    "Bold=0"
  ].join(",");

  return `subtitles='${cleanPath}':force_style='${style}'`;
}

async function getVoiceFromTTS(audioPath, voice, workDir) {
  if (!TTS_URL) {
    throw new Error("TTS_URL ကို Main Backend Environment ထဲ ထည့်ပါ။");
  }

  const buffer = await fs.promises.readFile(audioPath);

  const form = new FormData();
  form.append(
    "file",
    new Blob([buffer], { type: "audio/wav" }),
    "source.wav"
  );
  form.append("voice", voice);

  const response = await fetch(`${TTS_URL}/api/auto-dub`, {
    method: "POST",
    body: form
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`TTS Auto-Dub Error: ${message.slice(0, 500)}`);
  }

  const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));

  const voiceEntry = zip.getEntry("voice.mp3");
  const srtEntry = zip.getEntry("captions.srt");

  if (!voiceEntry || !srtEntry) {
    throw new Error("TTS Server က voice.mp3 / captions.srt မပေးနိုင်ပါ။");
  }

  const voicePath = path.join(workDir, "voice.mp3");
  const srtPath = path.join(workDir, "captions.srt");

  await fs.promises.writeFile(voicePath, voiceEntry.getData());
  await fs.promises.writeFile(srtPath, srtEntry.getData());

  return { voicePath, srtPath };
}

async function getManualVoice(script, voice, workDir, duration) {
  if (!TTS_URL) {
    throw new Error("TTS_URL ကို Main Backend Environment ထဲ ထည့်ပါ။");
  }

  const response = await fetch(`${TTS_URL}/api/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text: script, voice })
  });

  if (!response.ok) {
    throw new Error(`TTS Error: ${(await response.text()).slice(0, 500)}`);
  }

  const voicePath = path.join(workDir, "voice.mp3");
  const srtPath = path.join(workDir, "captions.srt");

  await fs.promises.writeFile(
    voicePath,
    Buffer.from(await response.arrayBuffer())
  );

  await fs.promises.writeFile(srtPath, makeSrt(script, duration));

  return { voicePath, srtPath };
}

async function renderJob(jobId, settings) {
  const job = getJob(jobId);
  const input = job.input;
  const workDir = path.join(jobsDir, jobId);

  fs.mkdirSync(workDir, { recursive: true });

  try {
    updateJob(jobId, {
      status: "processing",
      phase: "Video အချက်အလက် စစ်ဆေးနေပါတယ်",
      percent: 3
    });

    const meta = await probe(input);

    if (!meta.duration || meta.duration > MAX_DURATION) {
      throw new Error("Video ကြာချိန်သည် 350 မိနစ်ထက် မကျော်ရပါ။");
    }

    const voice = settings.voice === "my-MM-NilarNeural"
      ? "my-MM-NilarNeural"
      : "my-MM-ThihaNeural";

    const script = String(settings.script || "").trim();

    let audioResult;

    if (script) {
      updateJob(jobId, {
        phase: "မြန်မာ AI အသံ ဖန်တီးနေပါတယ်",
        percent: 10
      });

      audioResult = await getManualVoice(
        script,
        voice,
        workDir,
        meta.duration
      );
    } else {
      if (!meta.hasAudio) {
        throw new Error(
          "မူရင်း Video မှာ အသံမရှိပါ။ မြန်မာစာသားကို Transcript နေရာမှာ ထည့်ပေးပါ။"
        );
      }

      updateJob(jobId, {
        phase: "မူရင်းအသံကို ခွဲထုတ်နေပါတယ်",
        percent: 7
      });

      const sourceAudio = path.join(workDir, "source.wav");

      await runProcess(FFMPEG, [
        "-y",
        "-i", input,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        sourceAudio
      ]);

      updateJob(jobId, {
        phase: "အသံစာသားဖော်ထုတ်၊ မြန်မာဘာသာပြန်၊ အသံဖန်တီးနေပါတယ်",
        percent: 10
      });

      audioResult = await getVoiceFromTTS(
        sourceAudio,
        voice,
        workDir
      );
    }

    const subtitleEnabled = settings.subtitles !== false;
    const output = path.join(outputDir, `${jobId}.mp4`);

    const size = getOutputSize(
      settings.quality,
      settings.ratio,
      meta
    );

    let filters = [
      `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease`,
      `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2`
    ];

    if (settings.panEffect !== false) {
      filters.push(
        `zoompan=z='1.06':x='if(eq(mod(floor(on/125),2),0),(iw-iw/zoom)*mod(on,125)/125,(iw-iw/zoom)*(1-mod(on,125)/125))':y='ih/2-(ih/zoom/2)':d=1:s=${size.width}x${size.height}:fps=25`
      );
    }

    if (subtitleEnabled) {
      filters.push(safeSubtitleFilter(audioResult.srtPath, settings));
    }

    filters.push("fps=25", "format=yuv420p");

    const videoFilter = filters.join(",");

    const args = [
      "-y",
      "-i", input,
      "-i", audioResult.voicePath,
      "-vf", videoFilter,
      "-map", "0:v:0"
    ];

    const keepOriginal = settings.keepOriginalAudio === true &&
      meta.hasAudio;

    if (keepOriginal) {
      const originalVolume = Math.max(
        0,
        Math.min(100, Number(settings.originalVolume) || 15)
      ) / 100;

      args.push(
        "-filter_complex",
        `[0:a]volume=${originalVolume}[orig];[1:a]volume=1.0[dub];[orig][dub]amix=inputs=2:duration=longest:dropout_transition=2[aout]`,
        "-map", "[aout]"
      );
    } else {
      args.push("-map", "1:a:0");
    }

    const crf = size.height >= 2160 ? "19" :
      size.height >= 1440 ? "20" :
      size.height >= 1080 ? "21" : "23";

    args.push(
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", crf,
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-shortest",
      output
    );

    updateJob(jobId, {
      phase: "Video Render လုပ်နေပါတယ်",
      percent: 18
    });

    await runProcess(FFMPEG, args, seconds => {
      const percent = Math.min(
        98,
        Math.max(18, 18 + Math.floor((seconds / meta.duration) * 80))
      );

      updateJob(jobId, {
        percent,
        phase: "Video Render လုပ်နေပါတယ်"
      });
    });

    if (!fs.existsSync(output)) {
      throw new Error("MP4 ဖိုင် ထွက်မလာပါ။");
    }

    updateJob(jobId, {
      status: "done",
      phase: "ပြီးပါပြီ",
      percent: 100,
      output,
      duration: meta.duration,
      finishedAt: Date.now()
    });

  } catch (error) {
    console.error("RENDER ERROR:", error);

    updateJob(jobId, {
      status: "error",
      phase: "Render မအောင်မြင်ပါ",
      error: error.message || "Unknown render error"
    });

  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Burmese Video Backend",
    status: "OK"
  });
});

app.get("/api/health", (req, res) => {
  res.json({ success: true, status: "OK" });
});

app.post("/api/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Video ဖိုင် မတွေ့ပါ။"
      });
    }

    const meta = await probe(req.file.path);

    if (meta.duration > MAX_DURATION) {
      fs.unlinkSync(req.file.path);

      return res.status(400).json({
        success: false,
        error: "Video ကြာချိန်သည် 350 မိနစ်ထက် ကျော်နေပါတယ်။"
      });
    }

    const id = uuidv4();

    uploads.set(id, {
      path: req.file.path,
      originalName: req.file.originalname,
      meta
    });

    res.json({
      success: true,
      videoId: id,
      name: req.file.originalname,
      size: req.file.size,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio
    });

  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/render", async (req, res) => {
  try {
    const video = uploads.get(req.body.videoId);

    if (!video || !fs.existsSync(video.path)) {
      return res.status(404).json({
        success: false,
        error: "Upload လုပ်ထားတဲ့ Video ကို မတွေ့ပါ။"
      });
    }

    const id = uuidv4();

    jobs.set(id, {
      id,
      input: video.path,
      status: "queued",
      phase: "Render စတင်ရန် စောင့်နေပါတယ်",
      percent: 0,
      createdAt: Date.now()
    });

    renderJob(id, req.body).catch(console.error);

    res.status(202).json({
      success: true,
      jobId: id,
      message: "Render စတင်ပါပြီ။"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job မတွေ့ပါ။"
    });
  }

  res.json({
    success: true,
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    error: job.error || null,
    ready: job.status === "done"
  });
});

app.get("/api/stream/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || job.status !== "done" || !fs.existsSync(job.output)) {
    return res.status(404).send("Video မရသေးပါ။");
  }

  res.type("video/mp4");
  res.sendFile(path.resolve(job.output));
});

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || job.status !== "done" || !fs.existsSync(job.output)) {
    return res.status(404).send("Download လုပ်ရန် Video မရသေးပါ။");
  }

  res.download(job.output, "burmese-video.mp4");
});

app.use((error, req, res, next) => {
  console.error(error);

  res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 500).json({
    success: false,
    error: error.code === "LIMIT_FILE_SIZE"
      ? "ဖိုင်အရွယ်အစား 1GB ထက် ကျော်နေပါတယ်။"
      : error.message || "Server Error"
  });
});

app.listen(PORT, () => {
  console.log(`Burmese Video Backend listening on ${PORT}`);
});
