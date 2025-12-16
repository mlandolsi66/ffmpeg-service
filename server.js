import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format } = req.body;
    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // -------- IMAGES --------
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) {
        return res.status(400).json({ error: "Failed to download image" });
      }
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // -------- AUDIO (CRITICAL FIX) --------
    const ar = await fetch(audioUrl);
    if (!ar.ok) {
      return res.status(400).json({ error: "Failed to download audio" });
    }

    const audioBuf = Buffer.from(await ar.arrayBuffer());

    // sanity check (HTML error pages are small + start with "<")
    if (audioBuf.length < 1000 || audioBuf.toString("utf8", 0, 1) === "<") {
      return res.status(400).json({ error: "Invalid audio file" });
    }

    fs.writeFileSync(`${dir}/audio.wav`, audioBuf);

    // -------- AUDIO DURATION --------
    const audioDuration = parseFloat(
      execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 ${dir}/audio.wav`
      )
        .toString()
        .trim()
    );

    const perImageDuration = audioDuration / images.length;

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const out = `${dir}/out.mp4`;

    const inputs = images
      .map((_, i) => `-loop 1 -t ${perImageDuration} -i ${dir}/img${i}.jpg`)
      .join(" ");

    const filters = images
      .map(
        (_, i) => `
        [${i}:v]
        scale=${size}:force_original_aspect_ratio=increase,
        crop=${size},
        setpts=PTS-STARTPTS
        [v${i}]
      `
      )
      .join(";");

    const concat = images.map((_, i) => `[v${i}]`).join("");
    const filterComplex = `${filters};${concat}concat=n=${images.length}:v=1:a=0[v]`;

    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-i ${dir}/audio.wav ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map ${images.length}:a ` +
      `-shortest -pix_fmt yuv420p "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr);
        return res.status(500).json({ error: "FFmpeg failed" });
      }
      const buf = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(buf);
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0");
