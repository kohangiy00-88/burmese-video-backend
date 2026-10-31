'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const app = express();
const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 10000;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_DURATION_SECONDS = 350 * 60;

const TTS_BASE = 'https://api.tts.ai/v1';
const TTS_API_KEY = process.env.TTS_API_KEY || '';

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1
  }
});

function publicBase(req) {
  return process.env.PUBLIC_BASE_URL ||
    `${req.protocol}://${req.get('host')}`;
}

function safeId(id) {
  return typeof id === 'string' &&
    /^[a-f0-9-]{20,50}$/i.test(id);
}

function idFromFilename(filename) {
  return path.basename(filename, path.extname(filename));
}

async function findUploadedFile(id) {
  if (!safeId(id)) return null;

  const names = await fs.promises.readdir(UPLOAD_DIR);
  const match = names.find(name => idFromFilename(name) === id);

  return match ? path.join(UPLOAD_DIR, match) : null;
}

async function runFfmpeg(args, timeout = 6 * 60 * 60 * 1000) {
  return execFileAsync(ffmpegPath, args, {
    timeout,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function getVideoDuration(filePath) {
  try {
    const result = await execFileAsync(ffmpegPath, [
      '-i', filePath,
      '-f', 'null',
      '-'
    ], {
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024
    });

    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    const match = text.match(
      /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/
    );

    if (!match) return null;

    return Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]);
  } catch (error) {
    const text = `${error.stdout || ''}\n${error.stderr || ''}`;
    const match = text.match(
      /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/
    );

    if (!match) return null;

    return Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]);
  }
}

function downloadFile(req, res, filePath, filename) {
  return res.download(filePath, filename, error => {
    if (error && !res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'ဖိုင်ဒေါင်းလုဒ် မအောင်မြင်ပါ။'
      });
    }
  });
}

app.get('/', (_req, res) => {
  res.json({
    success: true,
    name: 'Burmese Video Backend',
    endpoints: [
      '/health',
      '/api/upload',
      '/api/extract-audio',
      '/api/audio/:id',
      '/api/tts/voices',
      '/api/tts'
    ]
  });
});

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    status: 'OK'
  });
});

// VIDEO UPLOAD
app.post('/api/upload', upload.any(), (req, res) => {
  const file = req.files && req.files[0];

  if (!file) {
    return res.status(400).json({
      success: false,
      message: 'Video ဖိုင်ကို ရွေးပြီး Upload လုပ်ပါ။'
    });
  }

  const id = idFromFilename(file.filename);

  res.json({
    success: true,
    message: 'Upload အောင်မြင်ပါပြီ။',
    file: {
      id,
      name: file.originalname,
      filename: file.filename,
      size: file.size,
      mimetype: file.mimetype,
      downloadUrl: `${publicBase(req)}/api/video/${id}`
    }
  });
});

// EXTRACT AUDIO FROM VIDEO
app.post('/api/extract-audio', upload.any(), async (req, res) => {
  let sourcePath = null;
  let sourceName = 'video';

  try {
    const uploaded = req.files && req.files[0];

    if (uploaded) {
      sourcePath = uploaded.path;
      sourceName = uploaded.originalname || sourceName;
    } else {
      const fileId =
        req.body.fileId ||
        req.body.id ||
        req.body.videoId;

      sourcePath = await findUploadedFile(fileId);

      if (!sourcePath) {
        return res.status(400).json({
          success: false,
          message: 'Video ဖိုင်ကို မတွေ့ပါ။ Video ကို Upload ပြန်လုပ်ပါ။'
        });
      }

      sourceName = path.basename(sourcePath);
    }

    const duration = await getVideoDuration(sourcePath);

    if (
      duration !== null &&
      duration > MAX_DURATION_SECONDS
    ) {
      return res.status(413).json({
        success: false,
        message: 'Video ကြာချိန်သည် 350 မိနစ်ထက် မကျော်ရပါ။',
        durationSeconds: duration
      });
    }

    const audioId = crypto.randomUUID();
    const outputPath = path.join(
      OUTPUT_DIR,
      `${audioId}.mp3`
    );

    await runFfmpeg([
      '-y',
      '-i', sourcePath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '64k',
      '-codec:a', 'libmp3lame',
      outputPath
    ]);

    const stat = await fs.promises.stat(outputPath);
    const audioUrl = `${publicBase(req)}/api/audio/${audioId}`;

    res.json({
      success: true,
      message: 'အသံဖိုင် Extract အောင်မြင်ပါပြီ။',
      file: {
        name: sourceName
      },
      audio: {
        id: audioId,
        filename: `${audioId}.mp3`,
        size: stat.size,
        url: audioUrl,
        downloadUrl: audioUrl
      }
    });
  } catch (error) {
    console.error('Extract audio error:', error);

    res.status(500).json({
      success: false,
      message: 'အသံထုတ်ယူရာတွင် အမှားဖြစ်နေပါတယ်။',
      detail: error.message
    });
  }
});

// VIDEO PREVIEW
app.get('/api/video/:id', async (req, res) => {
  try {
    const filePath = await findUploadedFile(req.params.id);

    if (!filePath) {
      return res.status(404).json({
        success: false,
        message: 'Video ဖိုင် မတွေ့ပါ။'
      });
    }

    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// DOWNLOAD MP3
app.get('/api/audio/:id', (req, res) => {
  const id = req.params.id;

  if (!safeId(id)) {
    return res.status(400).json({
      success: false,
      message: 'Audio ID မမှန်ပါ။'
    });
  }

  const filePath = path.join(
    OUTPUT_DIR,
    `${id}.mp3`
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: 'Audio ဖိုင် မတွေ့ပါ။'
    });
  }

  downloadFile(req, res, filePath, `${id}.mp3`);
});

// TTS API REQUEST
async function ttsFetch(url, options = {}) {
  const headers = {
    ...(options.headers || {})
  };

  if (TTS_API_KEY) {
    headers.Authorization = `Bearer ${TTS_API_KEY}`;
  }

  return fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(120000)
  });
}

// CHECK AVAILABLE VOICES
app.get('/api/tts/voices', async (_req, res) => {
  try {
    const response = await ttsFetch(
      `${TTS_BASE}/voices/?language=my`
    );

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        message: 'TTS Voice စာရင်းရယူမရပါ။',
        detail: text.slice(0, 500)
      });
    }

    let data = {};

    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }

    const allVoices = Array.isArray(data.voices)
      ? data.voices
      : Array.isArray(data)
        ? data
        : [];

    const voices = allVoices.filter(voice => {
      const language = String(
        voice.language || ''
      ).toLowerCase();

      const name = `${voice.name || ''} ${voice.id || ''}`;

      return [
        'my',
        'my-mm',
        'myanmar',
        'burmese'
      ].includes(language) ||
        /burmese|myanmar|မြန်မာ/i.test(name);
    });

    res.json({
      success: true,
      supported: voices.length > 0,
      language: 'my',
      voices,
      total: voices.length,
      message: voices.length
        ? 'မြန်မာအသံ ရရှိပါတယ်။'
        : 'မြန်မာဘာသာ Voice ကို မတွေ့သေးပါ။'
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      message: 'TTS Voice စာရင်းရယူရာတွင် ချိတ်ဆက်မှု အမှားဖြစ်နေပါတယ်။',
      detail: error.message
    });
  }
});

// BURMESE TEXT TO SPEECH
app.post('/api/tts', async (req, res) => {
  try {
    const text = String(
      req.body.text || ''
    ).trim();

    if (!text) {
      return res.status(400).json({
        success: false,
        message: 'အသံပြောင်းမယ့် မြန်မာစာသားကို ထည့်ပါ။'
      });
    }

    if (text.length > 500) {
      return res.status(413).json({
        success: false,
        message: 'စာလုံး 500 အထိသာ တစ်ကြိမ်ပို့နိုင်ပါတယ်။',
        maxCharacters: 500
      });
    }

    let voice = String(
      req.body.voice || ''
    ).trim();

    if (!voice) {
      const voiceResponse = await ttsFetch(
        `${TTS_BASE}/voices/?language=my`
      );

      if (!voiceResponse.ok) {
        return res.status(502).json({
          success: false,
          message: 'Voice စာရင်းရယူမရပါ။'
        });
      }

      const voiceData = await voiceResponse.json();

      const voices = Array.isArray(voiceData.voices)
        ? voiceData.voices
        : [];

      const myVoice = voices.find(v => {
        const language = String(
          v.language || ''
        ).toLowerCase();

        const name = `${v.name || ''} ${v.id || ''}`;

        return [
          'my',
          'my-mm',
          'myanmar',
          'burmese'
        ].includes(language) ||
          /burmese|myanmar|မြန်မာ/i.test(name);
      });

      if (!myVoice) {
        return res.status(422).json({
          success: false,
          code: 'BURMESE_VOICE_UNAVAILABLE',
          message: 'ဒီ Provider မှာ မြန်မာဘာသာ Voice မတွေ့ပါ။'
        });
      }

      voice = myVoice.id;
    }

    const payload = {
      text,
      voice,
      language: 'my',
      format: 'mp3',
      speed: Number(req.body.speed || 1)
    };

    if (req.body.model) {
      payload.model = String(req.body.model);
    }

    const response = await ttsFetch(
      `${TTS_BASE}/tts/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg, audio/*, application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const detail = await response.text();

      return res.status(response.status).json({
        success: false,
        message: 'Burmese TTS မအောင်မြင်ပါ။',
        detail: detail.slice(0, 700)
      });
    }

    const contentType =
      response.headers.get('content-type') || '';

    let audioBuffer;

    if (contentType.includes('application/json')) {
      const data = await response.json();

      const audioUrl =
        data.result_url ||
        data.audio_url ||
        data.url;

      if (!audioUrl) {
        throw new Error(
          'TTS Provider က Audio URL မပြန်ပေးပါ။'
        );
      }

      const audioResponse = await ttsFetch(audioUrl);

      if (!audioResponse.ok) {
        throw new Error(
          'Audio ဖိုင် Download မလုပ်နိုင်ပါ။'
        );
      }

      audioBuffer = Buffer.from(
        await audioResponse.arrayBuffer()
      );
    } else {
      audioBuffer = Buffer.from(
        await response.arrayBuffer()
      );
    }

    if (!audioBuffer || audioBuffer.length < 100) {
      throw new Error('အသံဒေတာ မရရှိပါ။');
    }

    const id = crypto.randomUUID();

    const outputPath = path.join(
      OUTPUT_DIR,
      `${id}.mp3`
    );

    await fs.promises.writeFile(
      outputPath,
      audioBuffer
    );

    const url = `${publicBase(req)}/api/audio/${id}`;

    res.json({
      success: true,
      message: 'AI Voice ဖန်တီးပြီးပါပြီ။',
      audio: {
        id,
        filename: `${id}.mp3`,
        url,
        downloadUrl: url,
        size: audioBuffer.length
      },
      voice
    });
  } catch (error) {
    console.error('TTS error:', error);

    res.status(502).json({
      success: false,
      message: 'AI Voice ဖန်တီးရာတွင် အမှားဖြစ်နေပါတယ်။',
      detail: error.message
    });
  }
});

// ERROR HANDLER
app.use((error, _req, res, _next) => {
  console.error('Request error:', error.message);

  if (
    error instanceof multer.MulterError &&
    error.code === 'LIMIT_FILE_SIZE'
  ) {
    return res.status(413).json({
      success: false,
      message: 'ဖိုင်အရွယ်အစား 1 GB ထက် မကျော်ရပါ။'
    });
  }

  res.status(400).json({
    success: false,
    message: error.message || 'Request မအောင်မြင်ပါ။'
  });
});

app.listen(PORT, () => {
  console.log(
    `Burmese Video Backend running on port ${PORT}`
  );

  console.log(
    `FFmpeg: ${ffmpegPath ? 'ready' : 'not found'}`
  );
});
