import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

const ASSET_BASE_URL = process.env.ASSET_BASE_URL;

const AMBIENCE = {
  forest: "forest.wav",
  ocean: "ocean.wav",
  waves: "waves.wav",
  space: "space.wav",
  magic: "fairy.wav",
  lullaby: "lullaby.wav",
  default: "lullaby.wav"
};

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme = "" } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "missing inputs" });
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

    // -----------------------------
    // Download narration
    // -----------------------------
    const ar = await fetch(audioUrl);
    fs.writeFileSync(`${dir}/voice.wav`, Buffer.from(await ar.arrayBuffer()));

    // -----------------------------
    // Select + download ambience
    // -----------------------------
    const t = theme.toLowerCase();
    let ambFile = AMBIENCE.default;
    if (t.includes("forest")) ambFile = AMBIENCE.forest;
    else if (t.includes("ocean") || t.includes("sea")) ambFile = AMBIENCE.ocean;
    else if (t.includes("space")) ambFile = AMBIENCE.space;
    else if (t.includes("magic") || t.includes("fairy")) ambFile = AMBIENCE.magic;

    await fetch(`${ASSET_BASE_URL}/ambience/${ambFile}`)
      .then(r => r.arrayBuffer())
      .then(b => fs.writeFileSync(`${dir}/ambience.wav`, Buffer.from(b)));

    // -----------------------------
    // Download sparkle overlay
    // -----------------------------
    await fetch(`${ASSET_BASE_URL}/overlays/sparkles.mp4`)
      .then(r => r.arrayBuffer())
      .then(b => fs.writeFileSync(`${dir}/sparkles.mp4`, Buffer.from(b)));

    // -----------------------------
    // Video settings
    // -----------------------------
    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;
    const sceneSeconds = 6;

    // -----------------------------
    // Concat list
    // -----------------------------
    let concatTxt = "";
    for (let i = 0; i < images.length; i++) {
      concatTxt += `file '${dir}/img${i}.jpg'\n`;
      concatTxt += `duration ${sceneSeconds}\n`;
    }
    concatTxt += `file '${dir}/img${images.length - 1}.jpg'\n`;
    fs.writeFileSync(`${dir}/list.txt`, concatTxt);

    const out = `${dir}/out.mp4`;

    // -----------------------------
    // FFmpeg (SAFE)
    // -----------------------------
    const cmd =
      `ffmpeg -y -hide_banner -loglevel error ` +
      `-f concat -safe 0 -i ${dir}/list.txt ` +
      `-stream_loop -1 -i ${dir}/sparkles.mp4 ` +
      `-i ${dir}/voice.wav ` +
      `-i ${dir}/ambience.wav ` +
      `-filter_complex "` +
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[base];` +
        `[1:v]scale=${W}:${H},format=rgba,colorchannelmixer=aa=0.10[fx];` +
        `[base][fx]overlay=0:0[v];` +
        `[2:a]volume=1.0[voice];` +
        `[3:a]volume=0.18[amb];` +
        `[voice][amb]amix=inputs=2:duration=shortest[a]` +
      `" ` +
      `-map "[v]" -map "[a]" -shortest -r 30 -pix_fmt yuv420p "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 30 }, (err, _, stderr) => {
      if (err) {
        return res.status(500).json({
          error: "FFmpeg failed",
          stderr: stderr?.slice(-4000)
        });
      }

      const buf = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(buf);
    });

  } catch (e) {
    res.status(500).json({ error: "server crash", details: String(e) });
  }
});

app.listen(8080, "0.0.0.0", () => {
  console.log("🎬 FFmpeg service running");
});
