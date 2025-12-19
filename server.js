import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "50mb" }));

const OUTPUT_MODE = (process.env.OUTPUT_MODE || "upload").toLowerCase(); // upload | stream

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

/* ------------------ THEME → AMBIENCE ------------------ */

function pickAmbienceFilename(themeRaw) {
  const theme = String(themeRaw || "").trim().toLowerCase();
  const map = {
    "fairy garden adventure": "fairy-garden-adventure.wav",
    "princess star dreams": "fairy.wav",
    "magic forest friends": "magic-forest-friends.wav",
    "dino explorer": "music-box-34179.wav",
    "ocean wonders": "waves.wav",
    "space bedtime journey": "whitenoise-space.wav",
  };
  return map[theme] || null;
}

/* ------------------ OVERLAY POOL ------------------ */

const OVERLAY_FILES = ["sparkles.mp4", "magic.mp4", "dust_bokeh.mp4", "light.mp4"];
function pickRandomOverlay() {
  return OVERLAY_FILES[Math.floor(Math.random() * OVERLAY_FILES.length)];
}

/* ------------------ HELPERS ------------------ */

async function downloadToFile(url, filepath) {
  const r = await fetch(url);
  if (!r.ok) {
    return { ok: false, status: r.status, contentType: r.headers.get("content-type") };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(filepath, buf);
  return { ok: true };
}

function looksLikeWav(filepath) {
  try {
    const fd = fs.openSync(filepath, "r");
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);
    return header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE";
  } catch {
    return false;
  }
}

function ffprobeOk(filepath) {
  try {
    execSync(`ffprobe -v error "${filepath}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ffprobeDuration(filepath) {
  const s = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filepath}"`
  )
    .toString()
    .trim();
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;
    if (!videoId || !Array.isArray(images) || images.length === 0 || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- IMAGES ---------- */
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) return res.status(400).json({ error: `Image download failed: ${i}` });
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
      if (!ffprobeOk(`${dir}/img${i}.jpg`)) {
        return res.status(400).json({ error: `Image not decodable by FFmpeg: ${i}` });
      }
    }

    /* ---------- NARRATION ---------- */
    const ar = await fetch(audioUrl);
    if (!ar.ok) return res.status(400).json({ error: "Audio download failed" });
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(await ar.arrayBuffer()));

    if (!looksLikeWav(`${dir}/audio.wav`) || !ffprobeOk(`${dir}/audio.wav`)) {
      return res.status(400).json({ error: "Narration WAV invalid / not decodable" });
    }

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    if (audioDuration < 1) {
      return res.status(400).json({ error: "Narration duration too short / probe failed" });
    }

    // per-image duration + frames for zoompan
    let perImageDuration = audioDuration / images.length;
    if (!Number.isFinite(perImageDuration) || perImageDuration < 0.8) perImageDuration = 0.8;

    const fps = 30;
    const framesPerImage = Math.max(24, Math.round(perImageDuration * fps)); // minimum ~0.8s

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":").map((n) => parseInt(n, 10));
    const out = `${dir}/out.mp4`;

    console.log("🎬 render", { videoId, images: images.length, audioDuration, perImageDuration, framesPerImage, size, theme, OUTPUT_MODE });

    /* ---------- AMBIENCE ---------- */
    const ASSET_BASE_URL = process.env.ASSET_BASE_URL;
    let useAmbience = false;
    const ambiencePath = `${dir}/ambience.wav`;

    if (ASSET_BASE_URL) {
      const ambFile = pickAmbienceFilename(theme);
      if (ambFile) {
        const ambUrl = `${ASSET_BASE_URL}/ambience/${ambFile}`;
        const dl = await downloadToFile(ambUrl, ambiencePath);
        if (dl.ok && looksLikeWav(ambiencePath) && ffprobeOk(ambiencePath)) {
          useAmbience = true;
        }
      }
    }

    /* ---------- RANDOM OVERLAY ---------- */
    let useOverlay = false;
    const overlayPath = `${dir}/overlay.mp4`;

    if (ASSET_BASE_URL) {
      const overlayFile = pickRandomOverlay();
      const overlayUrl = `${ASSET_BASE_URL}/overlays/${overlayFile}`;
      const dl = await downloadToFile(overlayUrl, overlayPath);

      if (dl.ok && ffprobeOk(overlayPath)) {
        useOverlay = true;
        console.log("✨ Overlay selected:", overlayFile);
      } else {
        console.warn("⚠️ Overlay failed, skipping:", overlayFile);
      }
    }

    /* ---------- INPUTS ---------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -i "${dir}/img${i}.jpg"`)
      .join(" ");

    const narrationIndex = images.length;
    const ambienceIndex = images.length + 1;
    const overlayIndex = images.length + (useAmbience ? 2 : 1);

    const inputs =
      imageInputs +
      ` -i "${dir}/audio.wav"` +
      (useAmbience ? ` -stream_loop -1 -i "${ambiencePath}"` : "") +
      (useOverlay ? ` -stream_loop -1 -i "${overlayPath}"` : "");

    /* ---------- FILTER GRAPH ---------- */
    // Soft zoom-in (Ken Burns): from 1.00 -> ~1.06 over framesPerImage
    // zoom increment tuned small to keep it gentle
    const zoomExpr = `min(zoom+0.0015,1.06)`;

    const vFilters = images
      .map((_, i) => {
        // start from scaled/cropped base, then zoompan to WxH at fps
        return (
          `[${i}:v]` +
          `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
          `crop=${W}:${H},` +
          `setsar=1,` +
          `zoompan=z='if(lte(on,1),1.0,${zoomExpr})':d=${framesPerImage}:s=${W}x${H}:fps=${fps},` +
          `format=rgba` +
          `[v${i}]`
        );
      })
      .join(";");

    const concatInputs = images.map((_, i) => `[v${i}]`).join("");
    let filter = `${vFilters};${concatInputs}concat=n=${images.length}:v=1:a=0[vbase];`;

    if (useOverlay) {
      filter +=
        `[vbase]format=rgba[base_rgba];` +
        `[${overlayIndex}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=rgba,colorchannelmixer=aa=0.18[fx];` +
        `[base_rgba][fx]overlay=shortest=1:format=auto,format=yuv420p[v];`;
    } else {
      filter += `[vbase]format=yuv420p[v];`;
    }

    if (useAmbience) {
      filter +=
        `[${ambienceIndex}:a]volume=0.20[amb];` +
        `[${narrationIndex}:a][amb]amix=inputs=2:duration=first:dropout_transition=2[a]`;
    } else {
      filter += `[${narrationIndex}:a]acopy[a]`;
    }

    /* ---------- EXEC ---------- */
    const cmd =
      `ffmpeg -y -hide_banner -loglevel error ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" ` +
      `-shortest -r ${fps} -threads 1 ` +
      `-c:v libx264 -crf 28 -preset veryfast -pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 128k "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, async (err, _stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg failed:", stderr);
        return res.status(500).json({ error: "FFmpeg failed", details: String(stderr || "").slice(0, 1500) });
      }

      if (!fs.existsSync(out) || fs.statSync(out).size < 1024) {
        return res.status(500).json({ error: "Output MP4 missing or empty" });
      }

      // === MODE A: UPLOAD (recommended, stable) ===
      if (OUTPUT_MODE === "upload") {
        if (!supabase) {
          return res.status(500).json({ error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in Railway" });
        }

        const videoBuffer = fs.readFileSync(out);
        const storagePath = `final/${videoId}.mp4`;

        const { error: uploadError } = await supabase.storage
          .from("videos")
          .upload(storagePath, videoBuffer, {
            contentType: "video/mp4",
            upsert: true
          });

        if (uploadError) {
          console.error("❌ upload failed", uploadError);
          return res.status(500).json({ error: "Upload failed" });
        }

        const { data: publicUrl } = supabase.storage.from("videos").getPublicUrl(storagePath);

        // Optional: update DB here (makes Edge simpler)
        await supabase
          .from("videos")
          .update({ video_url: publicUrl.publicUrl, status: "done", final: true })
          .eq("id", videoId);

        return res.json({ success: true, video_url: publicUrl.publicUrl });
      }

      // === MODE B: STREAM (legacy, may be unstable via Edge) ===
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", String(fs.statSync(out).size));
      fs.createReadStream(out).pipe(res);
    });
  } catch (e) {
    console.error("🔥 Server crash:", e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0");
