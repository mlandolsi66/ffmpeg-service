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
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    console.log("🎬 Rendering video:", videoId);

    /* ----------------------------
       1️⃣ Download images
    ---------------------------- */
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    /* ----------------------------
       2️⃣ Download WAV narration
    ---------------------------- */
    const ar = await fetch(audioUrl);
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    /* ----------------------------
       3️⃣ FFmpeg settings
    ---------------------------- */
    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const out = `${dir}/out.mp4`;

    const inputs = images
      .map((_, i) => `-loop 1 -t 6 -i ${dir}/img${i}.jpg`)
      .join(" ");

    const filters = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${size}:force_original_aspect_ratio=increase,` +
          `crop=${size},` +
          `zoompan=z='min(zoom+0.0006,1.06)':d=180:s=${size}[v${i}]`
      )
      .join(";");

    const concat = images.map((_, i) => `[v${i}]`).join("");

    const cmd = `
ffmpeg -y -r 30 ${inputs} -i ${dir}/audio.wav \
-filter_complex "${filters};${concat}concat=n=${images.length}:v=1:a=0[v]" \
-map "[v]" -map ${images.length}:a \
-shortest -pix_fmt yuv420p ${out}
`;

    /* ----------------------------
       4️⃣ Run FFmpeg
    ---------------------------- */
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg failed:", stderr);
        return res.status(500).json({
          error: "FFmpeg failed",
          details: stderr
        });
      }

      console.log("✅ FFmpeg done:", out);

      return res.json({
        status: "done",
        videoPath: `/tmp/${videoId}/out.mp4`
      });
    });

  } catch (err) {
    console.error("🔥 Server crash:", err);
    return res.status(500).json({ error: "Server crash" });
  }
});

/* ----------------------------
   Railway-compatible listen
---------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 FFmpeg service running on 0.0.0.0:${PORT}`);
});
