import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ------------------ ESM PATH FIX ------------------ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------ APP ------------------ */
const app = express();
app.use(express.json({ limit: "50mb" }));

console.log("🚀 Server starting");
console.log("📂 process.cwd() =", process.cwd());
console.log("📂 __dirname =", __dirname);

/* ------------------ SUPABASE CONFIG ------------------ */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ Supabase credentials missing - uploads will fail");
}

/* ------------------ AMBIENCE (ALWAYS) ------------------ */
function pickAmbience(theme = "") {
  const t = String(theme).toLowerCase();
  if (t.includes("ocean")) return "waves.wav";
  if (t.includes("space")) return "whitenoise-space.wav";
  if (t.includes("forest")) return "forest.wav";
  return "lullaby.wav";
}

/* ------------------ END CARD ------------------ */
function getEndCard(format) {
  const endCardPath = path.join(
    __dirname,
    "endcards",
    format === "9:16" ? "endcard_9x16.jpg" : "endcard_16x9.jpg"
  );

  if (fs.existsSync(endCardPath)) {
    console.log("🎬 Using end card:", endCardPath);
    return endCardPath;
  }

  console.log("⚠️ End card not found, skipping");
  return null;
}

/* ------------------ OVERLAY (THEME-BASED) ------------------ */
function pickOverlay(format, theme = "") {
  const base = path.join(__dirname, "overlays");
  const dir = format === "9:16" ? path.join(base, "9x16") : path.join(base, "16x9");

  if (!fs.existsSync(dir)) {
    console.log("⚠️ Overlay dir missing:", dir);
    return null;
  }

  // Theme-based overlay mapping
  const t = String(theme).toLowerCase();
  let overlayName;

  if (format === "9:16") {
    // Portrait overlays
    if (t.includes("ocean") || t.includes("water") || t.includes("beach") || t.includes("sea")) {
      overlayName = "blue-pink-powder_ready.mp4";
    } else if (t.includes("space") || t.includes("stars") || t.includes("galaxy") || t.includes("cosmic")) {
      overlayName = "lights_ready.mp4";
    } else if (t.includes("magic") || t.includes("fairy") || t.includes("fantasy") || t.includes("wizard")) {
      overlayName = "dust.mp4";
    } else {
      overlayName = "bokeh_ready.mp4"; // Default for 9:16
    }
  } else {
    // Landscape overlays (16:9)
    if (t.includes("ocean") || t.includes("water") || t.includes("beach") || t.includes("sea")) {
      overlayName = "sparkles.mp4";
    } else if (t.includes("space") || t.includes("stars") || t.includes("galaxy") || t.includes("cosmic")) {
      overlayName = "light.mp4";
    } else if (t.includes("magic") || t.includes("fairy") || t.includes("fantasy") || t.includes("wizard")) {
      overlayName = "magic.mp4";
    } else {
      overlayName = "dust_bokeh.mp4"; // Default for 16:9
    }
  }

  const overlayPath = path.join(dir, overlayName);

  // Verify file exists, fallback to any available overlay if not
  if (fs.existsSync(overlayPath)) {
    console.log(`🎞 Using ${format} overlay:`, overlayName, "for theme:", theme || "default");
    return overlayPath;
  }

  // Fallback: grab first available overlay
  console.log("⚠️ Requested overlay not found, using fallback");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mp4"));
  return files.length ? path.join(dir, files[0]) : null;
}

/* ------------------ HELPERS ------------------ */
function ffprobeDuration(file) {
  const d = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
    )
      .toString()
      .trim()
  );
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(`Invalid duration: ${file}`);
  }
  return d;
}

async function download(url, dest) {
  console.log("⬇️ Downloading:", url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed: ${url}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function run(cmd) {
  return new Promise((res, rej) =>
    exec(cmd, { maxBuffer: 1024 * 1024 * 200 }, (e, o, err) =>
      e ? rej(new Error(err || o)) : res()
    )
  );
}

/* ------------------ SUPABASE UPLOAD ------------------ */
async function uploadToSupabase(videoId, buffer) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase credentials not configured");
  }

  const path = `final/${videoId}.mp4`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/videos/${path}`;

  console.log("📤 Uploading to Supabase:", path);

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "video/mp4",
      "x-upsert": "true",
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Supabase upload failed: ${err}`);
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/videos/${path}`;
  console.log("✅ Uploaded:", publicUrl);

  return publicUrl;
}

/* ------------------ UPDATE DB ------------------ */
async function updateVideoStatus(videoId, status, videoUrl = null) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn("⚠️ Cannot update DB - no Supabase credentials");
    return;
  }

  const updateUrl = `${SUPABASE_URL}/rest/v1/videos?id=eq.${videoId}`;

  const payload = { status };
  if (videoUrl) {
    payload.video_url = videoUrl;
    payload.final = true;
  }

  console.log("📝 Updating DB:", payload);

  const res = await fetch(updateUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("❌ DB update failed:", err);
    throw new Error(`DB update failed: ${err}`);
  }

  console.log("✅ DB updated");
}

/* ------------------ RENDER (ASYNC) ------------------ */
async function renderVideo(videoId, images, audioUrl, format, theme) {
  const dir = `/tmp/${videoId}`;

  try {
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- DOWNLOAD ---------- */
    for (let i = 0; i < images.length; i++) {
      await download(images[i], `${dir}/img${i}.jpg`);
    }
    await download(audioUrl, `${dir}/voice.wav`);

    /* ---------- AMBIENCE ---------- */
    const ambFile = pickAmbience(theme);
    const ambPath = path.join(__dirname, "ambience", ambFile);

    console.log("🎧 Ambience file:", ambPath);

    if (!fs.existsSync(ambPath)) {
      console.error(
        "❌ Ambience dir contents:",
        fs.existsSync(path.join(__dirname, "ambience"))
          ? fs.readdirSync(path.join(__dirname, "ambience"))
          : "MISSING DIR"
      );
      throw new Error(`Ambience missing: ${ambPath}`);
    }

    /* ---------- OVERLAY ---------- */
    const overlayPath = pickOverlay(format, theme);

    /* ---------- END CARD ---------- */
    const endCardPath = getEndCard(format);
    const endCardDuration = 2.5; // 2.5 seconds end card

    /* ---------- DURATIONS ---------- */
    const audioDur = ffprobeDuration(`${dir}/voice.wav`);
    console.log("⏱ Narration duration:", audioDur);

    const storyDuration = endCardPath ? audioDur - endCardDuration : audioDur;
    const numStoryImages = images.length;
    const perImage = Math.max(storyDuration / numStoryImages, 3);
    
    const fps = 25;
    const [W, H] = format === "9:16" ? [1080, 1920] : [1920, 1080];

    /* ---------- INPUTS (LOCKED ORDER) ---------- */
    let cmdInputs = images
      .map(
        (_, i) =>
          `-loop 1 -framerate ${fps} -t ${perImage} -i "${dir}/img${i}.jpg"`
      )
      .join(" ");

    // Add end card if available
    if (endCardPath) {
      cmdInputs += ` -loop 1 -framerate ${fps} -t ${endCardDuration} -i "${endCardPath}"`;
    }

    cmdInputs += ` -i "${dir}/voice.wav"`;
    cmdInputs += ` -i "${ambPath}"`;

    if (overlayPath) cmdInputs += ` -stream_loop -1 -i "${overlayPath}"`;

    const voiceIdx = images.length + (endCardPath ? 1 : 0);
    const ambIdx = voiceIdx + 1;
    const overlayIdx = ambIdx + 1;

    /* ---------- FILTER GRAPH (WITH KEN BURNS + CROSSFADE) ---------- */
    const zoomFactor = 1.15; // 15% zoom (1.15), or 1.2 for more dramatic
    const totalFrames = Math.floor(perImage * fps); // Convert seconds to frames
    const fadeDuration = 0.5; // 0.5 second crossfade between scenes

    // Process each image with Ken Burns zoom
    let filter = images
      .map((_, i) => {
        // Alternate zoom direction for variety
        const zoomIn = i % 2 === 0;
        
        if (zoomIn) {
          // ZOOM IN: Start at 1.0, end at zoomFactor
          const zoomIncrement = (zoomFactor - 1.0) / totalFrames;
          return (
            `[${i}:v]scale=${W * 1.3}:${H * 1.3}:force_original_aspect_ratio=increase,` +
            `crop=${W * 1.3}:${H * 1.3},` +
            `zoompan=z='min(1.0+on*${zoomIncrement},${zoomFactor})':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},` +
            `trim=duration=${perImage},` +
            `format=yuv420p,setpts=PTS-STARTPTS[v${i}]`
          );
        } else {
          // ZOOM OUT: Start at zoomFactor, end at 1.0
          const zoomDecrement = (zoomFactor - 1.0) / totalFrames;
          return (
            `[${i}:v]scale=${W * 1.3}:${H * 1.3}:force_original_aspect_ratio=increase,` +
            `crop=${W * 1.3}:${H * 1.3},` +
            `zoompan=z='max(${zoomFactor}-on*${zoomDecrement},1.0)':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},` +
            `trim=duration=${perImage},` +
            `format=yuv420p,setpts=PTS-STARTPTS[v${i}]`
          );
        }
      })
      .join(";");

    // Apply crossfade between scenes
    const endCardIdx = images.length;
    
    // Build crossfade chain
    if (images.length > 1) {
      // Start with first video
      filter += `;[v0]`;
      
      // Chain crossfades for story scenes
      for (let i = 1; i < images.length; i++) {
        if (i === 1) {
          // First crossfade: [v0] + [v1]
          filter += `[v${i}]xfade=transition=fade:duration=${fadeDuration}:offset=${perImage - fadeDuration}[vf${i}]`;
        } else {
          // Subsequent crossfades: [vfN-1] + [vN]
          filter += `;[vf${i-1}][v${i}]xfade=transition=fade:duration=${fadeDuration}:offset=${(perImage * i) - (fadeDuration * i)}[vf${i}]`;
        }
      }
      
      const lastFadeIdx = images.length - 1;
      
      if (endCardPath) {
        // Process end card (no zoom, just scale)
        filter += `;[${endCardIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[vendcard]`;
        
        // Crossfade into end card
        const endCardOffset = (perImage * images.length) - (fadeDuration * images.length);
        filter += `;[vf${lastFadeIdx}][vendcard]xfade=transition=fade:duration=${fadeDuration}:offset=${endCardOffset}[vfinal]`;
        filter += `;[vfinal]trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;
      } else {
        // No end card, just trim final crossfade
        filter += `;[vf${lastFadeIdx}]trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;
      }
    } else {
      // Single scene - no crossfade needed
      if (endCardPath) {
        filter += `;[${endCardIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[vendcard]`;
        const endCardOffset = perImage - fadeDuration;
        filter += `;[v0][vendcard]xfade=transition=fade:duration=${fadeDuration}:offset=${endCardOffset}[vfinal]`;
        filter += `;[vfinal]trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;
      } else {
        filter += `;[v0]trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;
      }
    }

    if (overlayPath) {
      filter +=
        `;[${overlayIdx}:v]scale=${W}:${H},fps=${fps},format=rgba,` +
        `colorchannelmixer=aa=0.25,setpts=PTS-STARTPTS[ov]` +
        `;[base][ov]overlay=shortest=1:format=auto[v]`;
    } else {
      filter += `;[base]copy[v]`;
    }

    filter +=
      `;[${voiceIdx}:a]aformat=fltp:48000:stereo,asetpts=PTS-STARTPTS[vox]` +
      `;[${ambIdx}:a]aformat=fltp:48000:stereo,` +
      `aloop=loop=-1:size=2e+09,volume=0.18,apad,` +
      `atrim=0:${audioDur},asetpts=PTS-STARTPTS[amb]` +
      `;[vox][amb]amix=inputs=2:duration=first:dropout_transition=0[a]`;

    /* ---------- EXEC ---------- */
    const out = `${dir}/out.mp4`;

    const ffmpeg =
      `ffmpeg -y ${cmdInputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" ` +
      `-t ${audioDur} ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 160k "${out}"`;

    console.log("🧠 FFmpeg command:\n", ffmpeg);

    await run(ffmpeg);

    /* ---------- UPLOAD TO SUPABASE ---------- */
    const buffer = fs.readFileSync(out);
    const publicUrl = await uploadToSupabase(videoId, buffer);

    /* ---------- UPDATE DB ---------- */
    await updateVideoStatus(videoId, "done", publicUrl);

    console.log("✅ Render complete:", publicUrl);

    /* ---------- CLEANUP ---------- */
    fs.rmSync(dir, { recursive: true, force: true });

    return publicUrl;
  } catch (e) {
    console.error("🔥 Render failed:", e);

    // Update DB to failed status
    try {
      await updateVideoStatus(videoId, "failed");
    } catch (dbErr) {
      console.error("❌ Could not update DB to failed:", dbErr);
    }

    // Cleanup on failure
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    throw e;
  }
}

/* ------------------ ENDPOINT ------------------ */
app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format = "9:16", theme = "" } = req.body;

    console.log("🎬 Render request:", { videoId, format, theme });
    console.log("🖼 Images:", images?.length);

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    // Update status to rendering
    await updateVideoStatus(videoId, "rendering");

    // Return immediately - render happens async
    res.status(202).json({
      success: true,
      message: "Rendering started",
      videoId,
    });

    // Start render in background
    renderVideo(videoId, images, audioUrl, format, theme).catch((e) => {
      console.error("🔥 Background render failed:", e);
    });
  } catch (e) {
    console.error("🔥 /render endpoint failed:", e);
    res.status(500).json({
      error: "render failed",
      details: String(e.message || e),
    });
  }
});

/* ------------------ HEALTH CHECK ------------------ */
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(8080, "0.0.0.0", () =>
  console.log("✅ Listening on 0.0.0.0:8080")
);
