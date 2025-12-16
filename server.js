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
      return res.status(400).json({ error: "Missing videoId, images or audio" });
    }

    // -----------------------------
    // Setup job directory
    // -----------------------------
    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // -----------------------------
    // Download images
    // -----------------------------
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) throw new Error(`Failed to download image ${i}`);
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // -----------------------------
    // Download WAV audio
    // -----------------------------
    const ar = await fetch(audioUrl);
    if (!ar.ok) throw new Error("Failed to download audio");
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    // -----------------------------
    // Video geometry
    // -----------------------------
    const width = format === "9:16" ? 1080 : 1920;
    const height = format === "9:16" ? 1920 : 1080;
    const out = `${dir}/out.mp4`;

    // -----------------------------
    // FFmpeg inputs
    // -----------------------------
    const inputs = images
      .map((_, i) => `-loop 1 -t 5 -i ${dir}/img${i}.jpg`)
      .join(" ");

    const filters = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=w=${width}:h=${height},setsar=1[v${i}]`
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

    // -----------------------------
    // Start FFmpeg ASYNC
    // -----------------------------
    exec(cmd, async (err, stdout, stderr) => {
      console.log("FFmpeg STDOUT:", stdout);
      console.error("FFmpeg STDERR:", stderr);

      if (err) {
        console.error("❌ FFmpeg failed:", stderr);
        return;
      }

      try {
        // -----------------------------
        // Upload MP4 to Supabase
        // -----------------------------
        const videoBuffer = fs.readFileSync(out);

        const supabaseUrl = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        const uploadUrl = `${supabaseUrl}/storage/v1/object/videos/final/${videoId}.mp4`;

        await fetch(uploadUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "video/mp4",
            "x-upsert": "true"
          },
          body: videoBuffer
        });

        // -----------------------------
        // Notify Supabase
        // -----------------------------
        await fetch(`${supabaseUrl}/functions/v1/video-complete`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            videoId,
            path: `final/${videoId}.mp4`
          })
        });

        console.log("✅ Video uploaded & Supabase notified:", videoId);

      } catch (uploadErr) {
        console.error("❌ Upload or callback failed:", uploadErr);
      }
    });

    // -----------------------------
    // Respond immediately (NO TIMEOUT)
    // -----------------------------
    return res.json({
      status: "render-started",
      videoId
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Server crash",
      details: e.message
    });
  }
});

app.listen(3000, () => {
  console.log("🎬 FFmpeg service running on port 3000");
});
