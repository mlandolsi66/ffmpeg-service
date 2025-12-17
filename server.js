import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "50mb" }));

// 🔒 simple in-memory lock (one render at a time)
let RUNNING = false;

// 🌍 Supabase public base (NO secrets here)
const ASSET_BASE =
  "https://mbjhocmwfhmurkuqyxfd.supabase.co/storage/v1/object/public/videos";

// 🎵 ambience per theme
function ambienceForTheme(theme = "") {
  const t = theme.toLowerCase();
  if (t.includes("ocean")) return "ambience/ocean.wav";
  if (t.includes("space")) return "ambience/space.wav";
  if (t.includes("forest")) return "ambience/forest.wav";
  return "ambience/bedtime.wav";
}

app.post("/render", async (req, res) => {
  if (RUNNING) {
    return res.status(429).json({ error: "busy" });
  }

  RUNNING = true;

  try {
    const { videoId, images, audioUrl, format, theme } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      RUNNING = false;
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // --------------------------------------------------
    // 1️⃣ Download images
    // --------------------------------------------------
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) throw new Error("image download failed");
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // --------------------------------------------------
    // 2️⃣ Create concat list
    // --------------------------------------------------
    const listTxt = images
      .map((_, i) => `file '${dir}/img${i}.jpg'\nduration 6`)
      .join("\n");

    fs.writeFileSync(`${dir}/list.txt`, listTxt + "\n");

    // --------------------------------------------------
    // 3️⃣ Download narration
    // --------------------------------------------------
    const ar = await fetch(audioUrl);
    if (!ar.ok) throw new Error("audio download failed");
    fs.writeFileSync(`${dir}/voice.wav`, Buffer.from(await ar.arrayBuffer()));

    // --------------------------------------------------
    // 4️⃣ Download ambience + sparkles
    // --------------------------------------------------
    const ambiencePath = ambienceForTheme(theme);
    const ambienceUrl = `${ASSET_BASE}/${ambiencePath}`;
    const sparklesUrl = `${ASSET_BASE}/overlays/sparkles_fixed.mp4`;

    fs.writeFileSync(
      `${dir}/ambience.wav`,
      Buffer.from(await (await fetch(ambienceUrl)).arrayBuffer())
    );

    fs.writeFileSync(
      `${dir}/sparkles.mp4`,
      Buffer.from(await (await fetch(sparklesUrl)).arrayBuffer())
    );

    // --------------------------------------------------
    // 5️⃣ Video geometry
    // --------------------------------------------------
    const size = format === "9:16" ? "1080x1920" : "1920x1080";
    const out = `${dir}/out.mp4`;

    // --------------------------------------------------
    // 6️⃣ FFmpeg (STABLE + FAST)
    // --------------------------------------------------
    const cmd = `
ffmpeg -y \
-f concat -safe 0 -i ${dir}/list.txt \
-i ${dir}/voice.wav \
-stream_loop -1 -i ${dir}/ambience.wav \
-stream_loop -1 -i ${dir}/sparkles.mp4 \
-filter_complex "
[0:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size},format=yuv420p[base];
[3:v]scale=${size},format=rgba,colorchannelmixer=aa=0.10[fx];
[base][fx]overlay=0:0[v];
[1:a][2:a]amix=inputs=2:weights=1 0.15[a]
" \
-map "[v]" -map "[a]" \
-shortest -r 30 -pix_fmt yuv420p \
${out}
`.replace(/\s+/g, " ").trim();

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, _out, errOut) => {
      RUNNING = false;

      if (err) {
        console.error("❌ FFmpeg failed:", errOut);
        return res.status(500).json({ error: "FFmpeg failed" });
      }

      const buf = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(buf);
    });
  } catch (e) {
    RUNNING = false;
    console.error("🔥 render crash:", e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0", () => {
  console.log("🎬 FFmpeg service running");
});
