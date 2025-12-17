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
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) throw new Error("Image download failed");
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // download audio
    const ar = await fetch(audioUrl);
    if (!ar.ok) throw new Error("Audio download failed");
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    // concat list
    const perImageSeconds = 6;
    const list = images
      .map((_, i) => `file '${dir}/img${i}.jpg'\nduration ${perImageSeconds}`)
      .join("\n");

    fs.writeFileSync(`${dir}/list.txt`, list);

    const size =
      format === "9:16" ? "1080x1920" : "1920x1080";

    const out = `${dir}/out.mp4`;

    const cmd = `
ffmpeg -y \
-f concat -safe 0 -i ${dir}/list.txt \
-i ${dir}/audio.wav \
-vf "scale=${size}:force_original_aspect_ratio=increase,crop=${size}" \
-r 30 \
-shortest \
-pix_fmt yuv420p \
${out}
`.trim();

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
