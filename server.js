import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BASE = `${SUPABASE_URL}/storage/v1/object/public/videos`;

let RUNNING = false;

app.post("/render", async (req, res) => {
  if (RUNNING) return res.status(429).json({ error: "busy" });
  RUNNING = true;

  try {
    const { videoId, images, audioUrl, format } = req.body;
    if (!videoId || !images?.length || !audioUrl) {
      RUNNING = false;
      return res.status(400).json({ error: "missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // 1️⃣ Images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
    }

    // 2️⃣ Concat list
    let list = "";
    images.forEach((_, i) => {
      list += `file '${dir}/img${i}.jpg'\n`;
      list += `duration 6\n`;
    });
    list += `file '${dir}/img${images.length - 1}.jpg'\n`;
    fs.writeFileSync(`${dir}/list.txt`, list);

    // 3️⃣ Audio
    const ar = await fetch(audioUrl);
    fs.writeFileSync(`${dir}/voice.wav`, Buffer.from(await ar.arrayBuffer()));

    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;
    const out = `${dir}/out.mp4`;

    const cmd = `
ffmpeg -y
-f concat -safe 0 -i ${dir}/list.txt
-i ${dir}/voice.wav
-vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}"
-r 30 -shortest -pix_fmt yuv420p
${out}
`.replace(/\s+/g, " ");

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, async (err) => {
      if (err) {
        RUNNING = false;
        console.error("❌ FFmpeg failed");
        return;
      }

      // 4️⃣ Upload MP4
      const videoBuffer = fs.readFileSync(out);
      const uploadRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/videos/final/${videoId}.mp4`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "video/mp4"
          },
          body: videoBuffer
        }
      );

      const publicUrl = `${STORAGE_BASE}/final/${videoId}.mp4`;

      // 5️⃣ Update DB
      await fetch(`${SUPABASE_URL}/rest/v1/videos?id=eq.${videoId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          video_url: publicUrl,
          status: "done",
          final: true
        })
      });

      RUNNING = false;
    });

    // IMPORTANT: respond immediately
    res.json({ ok: true });

  } catch (e) {
    RUNNING = false;
    console.error("🔥 server crash:", e);
    res.status(500).json({ error: "crash" });
  }
});

app.listen(8080, "0.0.0.0", () => {
  console.log("🎬 FFmpeg worker running");
});
