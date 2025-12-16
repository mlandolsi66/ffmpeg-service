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

    // Create working directory
    const id = Date.now().toString();
    const dir = `/tmp/${id}`;
    fs.mkdirSync(dir, { recursive: true });

    // Download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) {
        throw new Error(`Failed to download image ${i}`);
      }
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // Download WAV audio (NO MP3 ANYWHERE)
    const ar = await fetch(audioUrl);
    if (!ar.ok) {
      throw new Error("Failed to download audio");
    }
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    const size = format === "9:16" ? "1080x1920" : "1920x1080";
    const out = `${dir}/out.mp4`;

    // Image inputs (5 seconds per image for now)
    const inputs = images
      .map((_, i) => `-loop 1 -t 5 -i ${dir}/img${i}.jpg`)
      .join(" ");

    // Simple, safe filters (NO motion yet)
    const filters = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size},setsar=1[v${i}]`
      )
      .join(";");

    const concat = images.map((_, i) => `[v${i}]`).join("");

    const cmd = `
ffmpeg -y -r 30 ${inputs} -i ${dir}/audio.wav \
-filter_complex "
${filters};
${concat}concat=n=${images.length}:v=1:a=0[v]
" \
-map "[v]" -map ${images.length}:a \
-shortest -pix_fmt yuv420p ${out}
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

      return res.json({ videoPath: out });
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server crash", details: e.message });
  }
});

app.listen(3000, () => {
  console.log("🎬 FFmpeg service running");
});
