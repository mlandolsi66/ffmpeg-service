import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASSET_BASE_URL = process.env.ASSET_BASE_URL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ASSET_BASE_URL) {
  console.error("❌ Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ASSET_BASE_URL");
  process.exit(1);
}

let RUNNING = false;

function ambienceForTheme(theme = "") {
  const t = theme.toLowerCase();
  // keep it simple + deterministic
  if (t.includes("ocean") || t.includes("sea")) return "underwater.wav";
  if (t.includes("space")) return "whitenoise-space.wav";
  if (t.includes("forest")) return "forest.wav";
  if (t.includes("magic") || t.includes("fairy")) return "fairy.wav";
  return "lullaby.wav";
}

async function downloadTo(url, destPath) {
  const r = await fetch(url);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Download failed ${r.status}: ${url} :: ${txt.slice(0, 120)}`);
  }
  fs.writeFileSync(destPath, Buffer.from(await r.arrayBuffer()));
}

function run(cmd, maxBuffer = 1024 * 1024 * 50) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || "").slice(-8000)));
      resolve({ stdout, stderr });
    });
  });
}

app.post("/render", async (req, res) => {
  if (RUNNING) return res.status(429).json({ error: "busy" });
  RUNNING = true;

  try {
    const { videoId, images, audioUrl, format, theme = "" } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      RUNNING = false;
      return res.status(400).json({ error: "missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // 1) download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) throw new Error(`image download failed ${i}`);
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
    }

    // 2) concat list (6s per image) — KEEP MORNING BEHAVIOR
    let list = "";
    images.forEach((_, i) => {
      list += `file '${dir}/img${i}.jpg'\n`;
      list += `duration 6\n`;
    });
    list += `file '${dir}/img${images.length - 1}.jpg'\n`;
    fs.writeFileSync(`${dir}/list.txt`, list);

    // 3) narration
    await downloadTo(audioUrl, `${dir}/voice.wav`);

    // 4) overlay + ambience assets from Supabase Storage
    const ambFile = ambienceForTheme(theme);
    await downloadTo(`${ASSET_BASE_URL}/ambience/${ambFile}`, `${dir}/ambience_raw.wav`);

    // IMPORTANT: your overlay file must be a NORMAL MP4 (H264/yuv420p/faststart)
    await downloadTo(`${ASSET_BASE_URL}/overlays/sparkles_fixed.mp4`, `${dir}/sparkles.mp4`);

    // 5) normalize ambience -> known-good wav (prevents “Invalid data found”)
    const ambFixed = `${dir}/ambience_fixed.wav`;
    await run(
      `ffmpeg -y -hide_banner -loglevel error -i ${dir}/ambience_raw.wav -ac 2 -ar 44100 -c:a pcm_s16le ${ambFixed}`
    );

    // 6) geometry
    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;
    const out = `${dir}/out.mp4`;

    // 7) ffmpeg render (FAST + SAFE)
    // -shortest keeps visuals short (morning behavior)
    // overlay loops, ambience loops, voice is mapped
    const cmd =
      `ffmpeg -y -hide_banner -loglevel error ` +
      `-f concat -safe 0 -i ${dir}/list.txt ` +
      `-stream_loop -1 -i ${dir}/sparkles.mp4 ` +
      `-i ${dir}/voice.wav ` +
      `-stream_loop -1 -i ${ambFixed} ` +
      `-filter_complex "` +
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=yuv420p[base];` +
      `[1:v]scale=${W}:${H},format=rgba,colorchannelmixer=aa=0.10[fx];` +
      `[base][fx]overlay=0:0[v];` +
      `[2:a]volume=1.0[voice];` +
      `[3:a]volume=0.18[amb];` +
      `[voice][amb]amix=inputs=2:duration=shortest[a]` +
      `" -map "[v]" -map "[a]" -r 30 -shortest -pix_fmt yuv420p ${out}`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, async (err, _stdout, stderr) => {
      if (err) {
        RUNNING = false;
        console.error("❌ FFmpeg failed:", (stderr || err.message || "").slice(-2000));
        return;
      }

      try {
        // 8) upload MP4 to Storage
        const videoBuffer = fs.readFileSync(out);

        const uploadRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/videos/final/${videoId}.mp4`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              "Content-Type": "video/mp4",
            },
            body: videoBuffer,
          }
        );

        if (!uploadRes.ok) {
          const t = await uploadRes.text();
          throw new Error("storage upload failed: " + t.slice(0, 300));
        }

        const publicUrl =
          `${SUPABASE_URL}/storage/v1/object/public/videos/final/${videoId}.mp4`;

        // 9) update DB
        const dbRes = await fetch(
          `${SUPABASE_URL}/rest/v1/videos?id=eq.${videoId}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({
              video_url: publicUrl,
              status: "done",
              final: true,
            }),
          }
        );

        if (!dbRes.ok) {
          const t = await dbRes.text();
          throw new Error("DB update failed: " + t.slice(0, 300));
        }

        console.log("✅ Video ready:", publicUrl);
      } catch (e) {
        console.error("🔥 Post-render error:", e.message);
      } finally {
        RUNNING = false;
      }
    });

    // respond immediately
    res.json({ ok: true });
  } catch (e) {
    RUNNING = false;
    console.error("🔥 server crash:", e.message);
    res.status(500).json({ error: "server crash" });
  }
});

app.listen(process.env.PORT || 8080, "0.0.0.0", () => {
  console.log("🎬 FFmpeg worker running");
});
