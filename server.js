import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing videoId, images or audio" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // 1) Download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) {
        return res.status(400).json({ error: `Failed to download image ${i}` });
      }
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // 2) Download audio
    const ar = await fetch(audioUrl);
    if (!ar.ok) {
      return res.status(400).json({ error: "Failed to download audio" });
    }
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    // 3) Video settings
    const scaleSize = format === "9:16" ? "1080:1920" : "1920:1080";
    const zoomSize = format === "9:16" ? "1080x1920" : "1920x1080";
    const out = `${dir}/out.mp4`;

    // 4) Inputs (each image 6s)
    const inputs = images
      .map((_, i) => `-loop 1 -t 6 -i ${dir}/img${i}.jpg`)
      .join(" ");

    // 5) Filter graph — LAYERED PARALLAX
    const filters = images
      .map((_, i) => {
        return `
        [${i}:v]
        scale=${scaleSize}:force_original_aspect_ratio=increase,
        crop=${scaleSize},
        split=2
        [bg${i}][fg${i}];

        [bg${i}]
        scale=1.15*iw:1.15*ih,
        gblur=sigma=12,
        zoompan=z='1.02+0.001*sin(on/120)':
        x='iw/2-(iw/zoom/2)+1*sin(on/160)':
        y='ih/2-(ih/zoom/2)+1*cos(on/160)':
        d=180:s=${zoomSize}
        [bgm${i}];

        [fg${i}]
        zoompan=z='1.01+0.001*sin(on/100)':
        x='iw/2-(iw/zoom/2)+2*sin(on/140)':
        y='ih/2-(ih/zoom/2)+2*cos(on/140)':
        d=180:s=${zoomSize}
        [fgm${i}];

        [bgm${i}][fgm${i}]
        overlay=(W-w)/2:(H-h)/2
        [v${i}]
        `;
      })
      .join(";");

    const concatInputs = images.map((_, i) => `[v${i}]`).join("");
    const filterComplex =
      `${filters};${concatInputs}concat=n=${images.length}:v=1:a=0[v]`;

    // 6) FFmpeg command
    const cmd =
      `ffmpeg -y -r 30 ${inputs} ` +
      `-i ${dir}/audio.wav ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map ${images.length}:a ` +
      `-shortest -pix_fmt yuv420p "${out}"`;

    console.log("🎬 Running FFmpeg:", cmd);

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (stdout) console.log("FFmpeg STDOUT:", stdout);
      if (stderr) console.log("FFmpeg STDERR:", stderr);

      if (err) {
        return res.status(500).json({
          error: "FFmpeg failed",
          details: stderr || err.message
        });
      }

      const videoBuffer = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(videoBuffer);
    });
  } catch (e) {
    console.error("🔥 Server crash:", e);
    res.status(500).json({ error: "Server crash" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 FFmpeg service running on 0.0.0.0:${PORT}`);
});
