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

    // images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // audio
    const ar = await fetch(audioUrl);
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    // get audio duration
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
