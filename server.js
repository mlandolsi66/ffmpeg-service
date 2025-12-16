import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "50mb" }));

/**
 * POST /render
 * Fire-and-forget FFmpeg render
 */
app.post("/render", async (req, res) => {
  const { videoId, images, audioUrl, format } = req.body;

  if (!videoId || !images?.length || !audioUrl) {
    return res.status(400).json({ error: "Missing payload" });
  }

  // 🔥 respond immediately (IMPORTANT)
  res.json({ status: "render-started", videoId });

  // run in background
  try {
    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // 1️⃣ download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // 2️⃣ download WAV audio (must already be WAV)
    const ar = await fetch(audioUrl);
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    // 3️⃣ ffmpeg config
    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const out = `${dir}/out.mp4`;

    const inputs = images
      .map((_, i) => `-loop 1 -t 6 -i ${dir}/img${i}.jpg`)
      .join(" ");

    const filters = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size},zoompan=z='min(zoom+0.0005,1.06)':d=180:s=${size}[v${i}]`
      )
      .join(";");

    const concat = images.map((_, i) => `[v${i}]`).join("");

    const cmd = `
ffmpeg -y -r 30 ${inputs} -i ${dir}/audio.wav \
-filter_complex "${filters};${concat}concat=n=${images.length}:v=1:a=0[v]" \
-map "[v]" -map ${images.length}:a \
-shortest -pix_fmt yuv420p ${out}
`;

    exec(cmd, async (err, stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg failed:", stderr);
        return;
      }

      console.log("🎉 FFmpeg render complete:", videoId);
      console.log("📍 Output:", out);

      // ⚠️ NEXT STEP (later):
      // Upload to Supabase via signed URL OR webhook
    });

  } catch (err) {
    console.error("🔥 Render background crash:", err);
  }
});

// 🚨 MUST USE PORT PROVIDED BY RAILWAY
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🎬 FFmpeg service running on 0.0.0.0:${PORT}`)
);
