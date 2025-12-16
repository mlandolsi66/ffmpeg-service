import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

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

    /* -------------------------
       DOWNLOAD IMAGES
    --------------------------*/
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    /* -------------------------
       DOWNLOAD AUDIO (WAV)
    --------------------------*/
    const ar = await fetch(audioUrl);
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    /* -------------------------
       VIDEO SETTINGS
    --------------------------*/
    const scaleSize = format === "9:16" ? "1080:1920" : "1920:1080";
    const zoomSize  = format === "9:16" ? "1080x1920" : "1920x1080";
    const out = `${dir}/out.mp4`;

    /* -------------------------
       INPUTS
    --------------------------*/
    const inputs = images
      .map((_, i) => `-loop 1 -t 6 -i ${dir}/img${i}.jpg`)
      .join(" ");

    /* -------------------------
       FILTER GRAPH
    --------------------------*/
    const filters = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${scaleSize}:force_original_aspect_ratio=increase,` +
          `crop=${scaleSize},` +
          `zoompan=z='min(zoom+0.0005,1.06)':d=180:s=${zoomSize}[v${i}]`
      )
      .join(";");

    const concatInputs = images.map((_, i) => `[v${i}]`).join("");

    const filterComplex = `
${filters};
${concatInputs}concat=n=${images.length}:v=1:a=0[v]
`.replace(/\n/g, "");

    /* -------------------------
       FFMPEG COMMAND
    --------------------------*/
    const cmd = `
ffmpeg -y -r 30
${inputs}
-i ${dir}/audio.wav
-filter_complex "${filterComplex}"
-map "[v]"
-map ${images.length}:a
-shortest
-pix_fmt yuv420p
${out}
`;

    console.log("🎬 Running FFmpeg:\n", cmd);

    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg STDERR:\n", stderr);
        return res.status(500).json({
          error: "FFmpeg failed",
          details: stderr
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

/* -------------------------
   START SERVER (RAILWAY)
--------------------------*/
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 FFmpeg service running on 0.0.0.0:${PORT}`);
});
