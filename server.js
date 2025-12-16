import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

app.post("/render", async (req, res) => {
  const { videoId, images, audioUrl, format } = req.body;

  if (!videoId || !images?.length || !audioUrl) {
    return res.status(400).json({ error: "Missing input" });
  }

  // 🔹 RESPOND IMMEDIATELY (THIS FIXES 502)
  res.json({
    status: "render-started",
    videoId
  });

  // 🔹 BACKGROUND PROCESS (DO NOT AWAIT)
  setImmediate(async () => {
    try {
      const dir = `/tmp/${videoId}`;
      fs.mkdirSync(dir, { recursive: true });

      // Download images
      for (let i = 0; i < images.length; i++) {
        const r = await fetch(images[i]);
        fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
      }

      // Download WAV audio
      const ar = await fetch(audioUrl);
      fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(await ar.arrayBuffer()));

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

let filterComplex = "";
let videoMap = "";

if (images.length === 1) {
  // SINGLE IMAGE — NO CONCAT
  filterComplex = `
[0:v]scale=${size}:force_original_aspect_ratio=increase,
crop=${size},
zoompan=z='min(zoom+0.0005,1.06)':d=180:s=${size}[v]
`;
  videoMap = "[v]";
} else {
  // MULTIPLE IMAGES — CONCAT
  const filters = images
    .map(
      (_, i) =>
        `[${i}:v]scale=${size}:force_original_aspect_ratio=increase,
crop=${size},
zoompan=z='min(zoom+0.0005,1.06)':d=180:s=${size}[v${i}]`
    )
    .join(";");

  const concatInputs = images.map((_, i) => `[v${i}]`).join("");

  filterComplex = `${filters};${concatInputs}concat=n=${images.length}:v=1:a=0[v]`;
  videoMap = "[v]";
}

      const cmd = `
ffmpeg -y -r 30 ${inputs} -i ${dir}/audio.wav \
-filter_complex "${filterComplex.replace(/\n/g, "")}" \
-map "${videoMap}" -map ${images.length}:a \
-shortest -pix_fmt yuv420p ${out}
`;


      exec(cmd, async (err) => {
        if (err) {
          console.error("❌ FFmpeg failed", err);
          return;
        }

        console.log("✅ FFmpeg finished:", out);

        // OPTIONAL: upload to Supabase here later
      });
    } catch (e) {
      console.error("🔥 Background render failed", e);
    }
  });
});

// 🚨 MUST USE process.env.PORT
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🎬 FFmpeg service running on 0.0.0.0:${PORT}`)
);
