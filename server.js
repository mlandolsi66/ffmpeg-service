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
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // 2) Download audio
    const ar = await fetch(audioUrl);
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    // 3) Video settings
    const scaleSize = format === "9:16" ? "1080:1920" : "1920:1080";
    const zoomSize = format === "9:16" ? "1080x1920" : "1920x1080";
    const out = `${dir}/out.mp4`;

    // 4) Inputs (6s per image)
    const inputs = images
      .map((_, i) => `-loop 1 -t 6 -i ${dir}/img${i}.jpg`)
      .join(" ");

    // 5) FAST, CLEAR MOTION (NO SPLIT, NO OVERLAY)
    const motions = [
      // Zoom in + pan right
      `zoompan=z='1+0.0015*on':x='on*2':y='0'`,
      // Zoom in + pan left
      `zoompan=z='1+0.0015*on':x='-on*2':y='0'`,
      // Zoom in + pan down
      `zoompan=z='1+0.0015*on':x='0':y='on*2'`,
      // Zoom in + pan up
      `zoompan=z='1+0.0015*on':x='0':y='-on*2'`
    ];

    const filters = images
      .map((_, i) => {
        const motion = motions[i % motions.length];
        return (
          `[${i}:v]` +
          `scale=${scaleSize}:force_original_aspect_ratio=increase,` +
          `crop=${scaleSize},` +
          `${motion}:d=180:s=${zoomSize}[v${i}]`
        );
      })
      .join(";");

    const concatInputs = images.map((_, i) => `[v${i}]`).join("");
    const filterComplex =
      `${filters};${concatInputs}concat=n=${images.length}:v=1:a=0[v]`;

    const cmd =
      `ffmpeg -y -r 30 ${inputs} ` +
      `-i ${dir}/audio.wav ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map ${images.length}:a ` +
      `-shortest -pix_fmt yuv420p "${out}"`;

    console.log("🎬 FFmpeg:", cmd);

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr);
        return res.status(500).json({ error: "FFmpeg failed" });
      }
      const videoBuffer = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(videoBuffer);
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server crash" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 FFmpeg service running on ${PORT}`);
});
