import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase env vars");
  process.exit(1);
}

let RUNNING = false;

app.post("/render", async (req, res) => {
  if (RUNNING) {
    return res.status(429).json({ error: "busy" });
  }

  RUNNING = true;

  try {
    const { videoId, images, audioUrl, format } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      RUNNING = false;
      return res.status(400).json({ error: "missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* -----------------------------
       1️⃣ Download images
    ------------------------------ */
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) throw new Error("image download failed");
      fs.writeFileSync(
        `${dir}/img${i}.jpg`,
        Buffer.from(await r.arrayBuffer())
      );
    }

    /* -----------------------------
       2️⃣ Concat list (6s per image)
    ------------------------------ */
    let list = "";
    images.forEach((_, i) => {
      list += `file '${dir}/img${i}.jpg'\n`;
      list += `duration 6\n`;
    });
    list += `file '${dir}/img${images.length - 1}.jpg'\n`;
    fs.writeFileSync(`${dir}/list.txt`, list);

    /* -----------------------------
       3️⃣ Download narration
    ------------------------------ */
    const ar = await fetch(audioUrl);
    if (!ar.ok) throw new Error("audio download failed");
    fs.writeFileSync(
      `${dir}/voice.wav`,
      Buffer.from(await ar.arrayBuffer())
    );

    /* -----------------------------
       4️⃣ Geometry
    ------------------------------ */
    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;
    const out = `${dir}/out.mp4`;

    /* -----------------------------
       5️⃣ FFmpeg render (BACKGROUND)
    ------------------------------ */
    const cmd = `
ffmpeg -y
-f concat -safe 0 -i ${dir}/list.txt
-i ${dir}/voice.wav
-vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}"
-r 30 -shortest -pix_fmt yuv420p
${out}
`.replace(/\s+/g, " ");

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, async (err, _stdout, stderr) => {
      if (err) {
        RUNNING = false;
        console.error("❌ FFmpeg failed:", stderr || err.message);
        return;
      }

      try {
        /* -----------------------------
           6️⃣ Upload MP4 to Storage
        ------------------------------ */
        const videoBuffer = fs.readFileSync(out);

        const uploadRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/videos/final/${videoId}.mp4`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              "Content-Type": "video/mp4"
            },
            body: videoBuffer
          }
        );

        if (!uploadRes.ok) {
          const t = await uploadRes.text();
          throw new Error("storage upload failed: " + t);
        }

        const publicUrl =
          `${SUPABASE_URL}/storage/v1/object/public/videos/final/${videoId}.mp4`;

        /* -----------------------------
           7️⃣ UPDATE DB (THIS WAS BUGGY BEFORE)
        ------------------------------ */
        const dbRes = await fetch(
          `${SUPABASE_URL}/rest/v1/videos?id=eq.${videoId}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              apikey: SUPABASE_SERVICE_ROLE_KEY, // 🔥 REQUIRED
              "Content-Type": "application/json",
              Prefer: "return=minimal"
            },
            body: JSON.stringify({
              video_url: publicUrl,
              status: "done",
              final: true
            })
          }
        );

        if (!dbRes.ok) {
          const t = await dbRes.text();
          throw new Error("DB update failed: " + t);
        }

        console.log("✅ Video ready:", publicUrl);
      } catch (e) {
        console.error("🔥 Post-render error:", e.message);
      } finally {
        RUNNING = false;
      }
    });

    /* -----------------------------
       🚀 RESPOND IMMEDIATELY
    ------------------------------ */
    res.json({ ok: true });

  } catch (e) {
    RUNNING = false;
    console.error("🔥 server crash:", e.message);
    res.status(500).json({ error: "server crash" });
  }
});

app.listen(8080, "0.0.0.0", () => {
  console.log("🎬 FFmpeg worker running");
});
