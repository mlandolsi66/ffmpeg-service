import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

app.post("/render", async (req, res) => {
  try {
    const { images, audioUrl, format } = req.body;

    if (!images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing images or audio" });
    }

    const id = Date.now().toString();
    const dir = `/tmp/${id}`;
    fs.mkdirSync(dir);

    // Download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // Download audio
    const ar = await fetch(audioUrl);
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.mp3`, Buffer.from(ab));

    const size = format === "9:16" ? "1080x1920" : "1920x1080";
    const out = `${dir}/out.mp4`;

    const inputs = images
      .map((_, i) => `-loop 1 -t 5 -i ${dir}/img${i}.jpg`)
      .join(" ");

    const filters = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size},zoompan=z='min(zoom+0.0005,1.06)':d=150:s=${size}[v${i}]`
      )
      .join(";");

    const concat = images.map((_, i) => `[v${i}]`).join("");

    const cmd = `
ffmpeg -y -r 30 ${inputs} -i ${dir}/audio.mp3 \
-filter_complex "${filters};${concat}concat=n=${images.length}:v=1:a=0[v]" \
-map "[v]" -map ${images.length}:a -shortest -pix_fmt yuv420p ${out}
`;

    exec(cmd, (err, stdout, stderr) => {
  console.log("FFmpeg STDOUT:", stdout);
  console.error("FFmpeg STDERR:", stderr);

  if (err) {
    return res.status(500).json({
      error: "FFmpeg failed",
      details: stderr || err.message
    });
  }

  res.json({ videoPath: out });
});


  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(3000, () => console.log("🎬 FFmpeg service running"));
