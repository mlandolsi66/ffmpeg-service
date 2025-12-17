import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

// REQUIRED ENV VAR (Railway)
const ASSET_BASE_URL = process.env.ASSET_BASE_URL;

// ambience + overlays (must exist in Supabase Storage)
const AMBIENCE = {
  forest: "forest.wav",
  ocean: "underwater.wav",
  waves: "waves.wav",
  space: "whitenoise-space.wav",
  magic: "fairy.wav",
  lullaby: "lullaby.wav",
  default: "lullaby.wav"
};

const OVERLAY = "sparkles.mp4";

// prevent double execution
let RUNNING = false;

app.post("/render", async (req, res) => {
  if (RUNNING) {
    return res.status(429).json({ error: "Already rendering" });
  }
  RUNNING = true;

  try {
    const { videoId, images, audioUrl, format, theme = "" } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      RUNNING = false;
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // -----------------------------
    // Download images
    // -----------------------------
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
    }

    // narration
    const ar = await fetch(audioUrl);
    fs.writeFileSync(`${dir}/voice.wav`, Buffer.from(await ar.arrayBuffer()));

    // ambience selection
    const t = theme.toLowerCase();
    let ambienceFile = AMBIENCE.default;
    if (t.includes("forest")) ambienceFile = AMBIENCE.forest;
    else if (t.includes("ocean") || t.includes("sea")) ambienceFile = AMBIENCE.ocean;
    else if (t.includes("space")) ambienceFile = AMBIENCE.space;
    else if (t.includes("magic") || t.includes("fairy")) ambienceFile = AMBIENCE.magic;

    // download ambience + overlay
    await fetch(`${ASSET_BASE_URL}/ambience/${ambienceFile}`)
      .then(r => r.arrayBuffer())
      .then(b => fs.writeFileSync(`${dir}/ambience.wav`, Buffer.from(b)));

    await fetch(`${ASSET_BASE_URL}/overlays/${OVERLAY}`)
      .then(r => r.arrayBuffer())
      .then(b => fs.writeFileSync(`${dir}/overlay.mp4`, Buffer.from(b)));

    // -----------------------------
    // Video settings
    // -----------------------------
    const target = format === "9:16" ? "1080:1920" : "1920:1080";
    const out = `${dir}/out.mp4`;
    const fps = 30;
    const sceneSeconds = 6;

    // inputs
    const inputs =
      images.map((_, i) => `-loop 1 -t ${sceneSeconds} -i ${dir}/img${i}.jpg`).join(" ") +
      ` -stream_loop -1 -i ${dir}/overlay.mp4` +
      ` -stream_loop -1 -i ${dir}/ambience.wav` +
      ` -i ${dir}/voice.wav`;

    const overlayIndex = images.length;
    const ambienceIndex = images.length + 1;
    const voiceIndex = images.length + 2;

    // -----------------------------
    // Filters
    // -----------------------------
    const filters = images.map((_, i) => `
      [${i}:v]
      scale=${target}:force_original_aspect_ratio=increase,
      crop=${target},
      zoompan=z='1.03+0.0008*t':d=${sceneSeconds * fps}:s=${target}:fps=${fps},
      setpts=PTS-STARTPTS
      [base${i}];

      [${overlayIndex}:v]
      scale=${target},
      format=rgba,
      colorchannelmixer=aa=0.12,
      setpts=PTS-STARTPTS
      [ov${i}];

      [base${i}][ov${i}]
      overlay=0:0
      [v${i}]
    `).join(";");

    const concat = images.map((_, i) => `[v${i}]`).join("");

    const filterComplex = `
      ${filters};
      ${concat}concat=n=${images.length}:v=1:a=0[v];
      [${ambienceIndex}:a]volume=0.18[amb];
      [${voiceIndex}:a]volume=1.0[voice];
      [voice][amb]amix=inputs=2:duration=shortest[a]
    `;

    // -----------------------------
    // FFmpeg
    // -----------------------------
    const cmd =
      `ffmpeg -y -r ${fps} ${inputs} ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map "[a]" ` +
      `-shortest -pix_fmt yuv420p "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 30 }, (err) => {
      RUNNING = false;

      if (err) {
        return res.status(500).json({ error: "FFmpeg failed" });
      }

      const videoBuffer = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(videoBuffer);
    });

  } catch (e) {
    RUNNING = false;
    res.status(500).json({ error: "Server crash" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 FFmpeg service running on ${PORT}`);
});
