import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ----------------------------
   Supabase client (SERVER SIDE)
---------------------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ----------------------------
   POST /render (FAST RESPONSE)
---------------------------- */
app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    console.log("🎬 Render requested:", videoId);

    // ✅ Respond immediately (NO TIMEOUT)
    res.json({
      status: "render-started",
      videoId
    });

    // 🔥 Run FFmpeg async (DO NOT AWAIT)
    renderVideo(videoId, images, audioUrl, format).catch((err) =>
      console.error("🔥 Background render failed:", err)
    );

  } catch (err) {
    console.error("🔥 /render crash:", err);
    res.status(500).json({ error: "Server crash" });
  }
});

/* ----------------------------
   BACKGROUND RENDER FUNCTION
---------------------------- */
async function renderVideo(videoId, images, audioUrl, format) {
  console.log("🚀 FFmpeg background start:", videoId);

  const dir = `/tmp/${videoId}`;
  fs.mkdirSync(dir, { recursive: true });

  /* ---------- Download images ---------- */
  for (let i = 0; i < images.length; i++) {
    const r = await fetch(images[i]);
    const b = await r.arrayBuffer();
    fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
  }

  /* ---------- Download WAV narration ---------- */
  const ar = await fetch(audioUrl);
  const ab = await ar.arrayBuffer();
  fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

  /* ---------- FFmpeg config ---------- */
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

  /* ---------- Run FFmpeg ---------- */
  await new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg error:", stderr);
        reject(err);
      } else {
        resolve();
      }
    });
  });

  console.log("✅ FFmpeg finished:", out);

  /* ---------- Upload MP4 ---------- */
  const buffer = fs.readFileSync(out);

  const storagePath = `final/${videoId}.mp4`;

  const { error: uploadErr } = await supabase.storage
    .from("videos")
    .upload(storagePath, buffer, {
      contentType: "video/mp4",
      upsert: true
    });

  if (uploadErr) throw uploadErr;

  const {
    data: { publicUrl }
  } = supabase.storage.from("videos").getPublicUrl(storagePath);

  /* ---------- Update DB ---------- */
  await supabase
    .from("videos")
    .update({
      video_url: publicUrl,
      status: "video-ready"
    })
    .eq("id", videoId);

  console.log("🎉 VIDEO READY:", publicUrl);
}

/* ----------------------------
   Railway-compatible listen
---------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 FFmpeg service running on 0.0.0.0:${PORT}`);
});
