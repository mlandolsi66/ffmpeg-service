import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

const STAR_OVERLAY_PATH = "stars.mp4"; // <-- must exist

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // Download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // Download audio
    const ar = await fetch(audioUrl);
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    const target = format === "9:16" ? "1080:1920" : "1920:1080";
    const big = format === "9:16" ? "1400:2500" : "2500:1400";
    const out = `${dir}/out.mp4`;

    // Inputs
    const inputs =
      images.map((_, i) => `-loop 1 -t 6 -i ${dir}/img${i}.jpg`).join(" ") +
      ` -stream_loop -1 -i ${STAR_OVERLAY_PATH}`;

    // Per-scene motion
    const motions = [
      `x='(iw-ow)*(t/6)':y='(ih-oh)/2'`,
      `x='(iw-ow)*(1-t/6)':y='(ih-oh)/2'`,
      `x='(iw-ow)/2':y='(ih-oh)*(t/6)'`,
      `x='(iw-ow)/2':y='(ih-oh)*(1-t/6)'`
    ];

    // Per-scene overlay opacity
    const opacities = [0.20, 0.30, 0.25, 0.35];

    const filters = images.map((_, i) => `
      [${i}:v]
      scale=${big}:force_original_aspect_ratio=increase,
      crop=${target}:${motions[i % motions.length]},
      setpts=PTS-STARTPTS
      [base${i}];

      [${images.length}:v]
      scale=${target},
      format=rgba,
      colorchannelmixer=aa=${opacities[i % opacities.length]},
      setpts=PTS-STARTPTS
      [stars${i}];

      [base${i}][stars${i}]
      overlay=0:0
      [v${i}]
    `).join(";");

    const concat = images.map((_, i) => `[v${i}]`).join("");
    const filterComplex = `${filters};${concat}concat=n=${images.length}:v=1:a=0[v]`;

    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-i ${dir}/audio.wav ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map ${images.length + 1}:a ` +
      `-shortest -pix_fmt yuv420p "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err) => {
      if (err) return res.status(500).json({ error: "FFmpeg failed" });
      const buf = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(buf);
    });

  } catch {
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0");
