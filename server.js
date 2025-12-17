import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

const ASSET_BASE_URL = process.env.ASSET_BASE_URL;

// Map themes -> file names you actually uploaded
function ambienceForTheme(theme = "") {
  const t = theme.toLowerCase();
  if (t.includes("ocean") || t.includes("sea") || t.includes("underwater")) return "underwater.wav";
  if (t.includes("space")) return "whitenoise-space.wav";
  if (t.includes("forest")) return "forest.wav";
  if (t.includes("magic") || t.includes("fairy")) return "fairy.wav";
  return "lullaby.wav";
}

async function downloadTo(url, destPath) {
  const r = await fetch(url);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Download failed ${r.status} ${url} :: ${txt.slice(0, 200)}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

// Promisified exec
function run(cmd, maxBuffer = 1024 * 1024 * 50) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || "").slice(-8000)));
      resolve({ stdout, stderr });
    });
  });
}

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme = "" } = req.body;

    if (!ASSET_BASE_URL) {
      return res.status(500).json({ error: "Missing ASSET_BASE_URL env var" });
    }
    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // 1) Download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) return res.status(400).json({ error: `image download failed ${i}` });
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
    }

    // 2) Concat list (6s per image)
    const sceneSeconds = 6;
    let concatTxt = "";
    for (let i = 0; i < images.length; i++) {
      concatTxt += `file '${dir}/img${i}.jpg'\n`;
      concatTxt += `duration ${sceneSeconds}\n`;
    }
    concatTxt += `file '${dir}/img${images.length - 1}.jpg'\n`;
    fs.writeFileSync(`${dir}/list.txt`, concatTxt);

    // 3) Download narration
    await downloadTo(audioUrl, `${dir}/voice.wav`);

    // 4) Download ambience + sparkles
    const ambFile = ambienceForTheme(theme);
    const ambienceUrl = `${ASSET_BASE_URL}/ambience/${ambFile}`;
    const sparklesUrl = `${ASSET_BASE_URL}/overlays/sparkles.mp4`;

    await downloadTo(ambienceUrl, `${dir}/ambience_raw.wav`);
    await downloadTo(sparklesUrl, `${dir}/sparkles.mp4`);

    // 5) Normalize ambience to a guaranteed-good WAV
    // This fixes “Invalid data found” even if your file is weird or mislabeled.
    const ambFixed = `${dir}/ambience_fixed.wav`;
    const ambFixCmd =
      `ffmpeg -y -hide_banner -loglevel error ` +
      `-i ${dir}/ambience_raw.wav ` +
      `-ac 2 -ar 44100 -c:a pcm_s16le "${ambFixed}"`;
    try {
      await run(ambFixCmd, 1024 * 1024 * 50);
    } catch (e) {
      return res.status(500).json({
        error: "Ambience invalid / cannot be converted",
        details: String(e.message || e).slice(-8000)
      });
    }

    // 6) Geometry
    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;
    const out = `${dir}/out.mp4`;

    // 7) FFmpeg render (fast + stable)
    // Inputs:
    // 0: concat images
    // 1: sparkles video (loop)
    // 2: voice wav
    // 3: ambience fixed wav (loop)
    const cmd =
      `ffmpeg -y -hide_banner -loglevel error ` +
      `-f concat -safe 0 -i ${dir}/list.txt ` +
      `-stream_loop -1 -i ${dir}/sparkles.mp4 ` +
      `-i ${dir}/voice.wav ` +
      `-stream_loop -1 -i ${ambFixed} ` +
      `-filter_complex "` +
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=yuv420p[base];` +
      `[1:v]scale=${W}:${H},format=rgba,colorchannelmixer=aa=0.10[fx];` +
      `[base][fx]overlay=0:0[v];` +
      `[2:a]volume=1.0[voice];` +
      `[3:a]volume=0.18[amb];` +
      `[voice][amb]amix=inputs=2:duration=shortest[a]` +
      `" -map "[v]" -map "[a]" -shortest -r 30 -pix_fmt yuv420p "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, _stdout, stderr) => {
      if (err) {
        return res.status(500).json({
          error: "FFmpeg failed",
          stderr: (stderr || err.message || "").slice(-8000)
        });
      }
      res.setHeader("Content-Type", "video/mp4");
      res.send(fs.readFileSync(out));
    });

  } catch (e) {
    res.status(500).json({ error: "Server crash", details: String(e.message || e) });
  }
});

app.listen(process.env.PORT || 8080, "0.0.0.0", () => {
  console.log("🎬 FFmpeg service running");
});
