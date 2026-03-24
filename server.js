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

/* ------------------ AMBIENCE (THEME-BASED WITH RANDOM SELECTION) ------------------ */
function pickAmbience(theme = "") {
  const ambienceDir = path.join(__dirname, "ambience");
  
  if (!fs.existsSync(ambienceDir)) {
    console.warn("⚠️ Ambience directory not found");
    return null;
  }

  const t = String(theme).toLowerCase();
  let ambiencePrefixes = [];

  // Map theme to ambience prefixes (with fallbacks)
  if (t.includes("ocean") || t.includes("water") || t.includes("sea")) {
    ambiencePrefixes = ["waves", "underwater", "ocean"];
  } else if (t.includes("space") || t.includes("bedtime journey")) {
    ambiencePrefixes = ["space-ambience", "whitenoise-space", "space"];
  } else if (t.includes("forest") || t.includes("magic forest")) {
    ambiencePrefixes = ["forest-ambience", "forest"];
  } else if (t.includes("dino") || t.includes("explorer")) {
    ambiencePrefixes = ["dino", "adventure"];
  } else if (t.includes("fairy") || t.includes("garden")) {
    ambiencePrefixes = ["fairy", "garden"];
  } else if (t.includes("princess") || t.includes("star dreams")) {
    ambiencePrefixes = ["princess-ambience", "music-box", "princess"];
  } else if (t.includes("birthday") || t.includes("celebration")) {
    ambiencePrefixes = ["birthday-ambience", "birthday", "celebration"];
  } else {
    ambiencePrefixes = ["lullaby"];
  }

  // Get all audio files matching ANY of the prefixes
  const matchingAudio = fs.readdirSync(ambienceDir)
    .filter(f => {
      if (!f.endsWith(".wav") && !f.endsWith(".mp3")) return false;
      const lowerName = f.toLowerCase();
      return ambiencePrefixes.some(prefix => lowerName.startsWith(prefix));
    });

  if (matchingAudio.length === 0) {
    console.log(`⚠️ No ambience found for "${ambiencePrefixes.join('/')}", using fallback`);
    
    if (fs.existsSync(path.join(ambienceDir, "lullaby.mp3"))) {
      console.log(`🎧 Using fallback: lullaby.mp3`);
      return path.join(ambienceDir, "lullaby.mp3");
    }
    
    const allAudio = fs.readdirSync(ambienceDir).filter(f => f.endsWith(".wav") || f.endsWith(".mp3"));
    if (allAudio.length === 0) return null;
    
    const fallback = allAudio[0];
    console.log(`🎧 Using fallback: ${fallback}`);
    return path.join(ambienceDir, fallback);
  }

  // RANDOM SELECTION
  const selectedAudio = matchingAudio[Math.floor(Math.random() * matchingAudio.length)];
  const audioPath = path.join(ambienceDir, selectedAudio);

  console.log(`🎧 Using ambience: ${selectedAudio} for theme: "${theme}" (${matchingAudio.length} variant${matchingAudio.length > 1 ? 's' : ''} available)`);
  
  return audioPath;
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

/* ------------------ OVERLAY (THEME-BASED WITH RANDOM SELECTION) ------------------ */
function pickOverlay(format, theme = "") {
  const base = path.join(__dirname, "overlays");
  const dir = format === "9:16" ? path.join(base, "9x16") : path.join(base, "16x9");

  if (!fs.existsSync(dir)) {
    console.log("⚠️ Overlay dir missing:", dir);
    return null;
  }

  const t = String(theme).toLowerCase();
  let overlayPrefixes = [];

  // Map theme to overlay prefixes (with fallbacks)
  if (t.includes("ocean") || t.includes("water") || t.includes("sea")) {
    overlayPrefixes = ["ocean", "blue-pink", "sparkles"];
  } else if (t.includes("space") || t.includes("bedtime journey")) {
    overlayPrefixes = ["space_stars", "space", "lights"];
  } else if (t.includes("forest") || t.includes("magic forest")) {
    overlayPrefixes = ["forest"];
  } else if (t.includes("dino") || t.includes("explorer")) {
    overlayPrefixes = ["dino_leaves", "dino"];
  } else if (t.includes("fairy") || t.includes("garden")) {
    overlayPrefixes = ["fairy"];
  } else if (t.includes("princess") || t.includes("star dreams")) {
    overlayPrefixes = ["princess"];
  } else if (t.includes("birthday") || t.includes("celebration")) {
    overlayPrefixes = ["birthday"];
  } else {
    overlayPrefixes = ["bokeh", "dust"];
  }

  // Get all overlays matching ANY of the prefixes
  const matchingOverlays = fs.readdirSync(dir)
    .filter(f => {
      if (!f.endsWith(".mp4")) return false;
      const lowerName = f.toLowerCase();
      return overlayPrefixes.some(prefix => lowerName.startsWith(prefix));
    });

  if (matchingOverlays.length === 0) {
    console.log(`⚠️ No overlays found for "${overlayPrefixes.join('/')}", using fallback`);
    
    const allOverlays = fs.readdirSync(dir).filter(f => f.endsWith(".mp4"));
    if (allOverlays.length === 0) return null;
    
    const fallback = allOverlays[Math.floor(Math.random() * allOverlays.length)];
    console.log(`🎞 Using fallback overlay: ${fallback}`);
    return path.join(dir, fallback);
  }

  // RANDOM SELECTION
  const selectedOverlay = matchingOverlays[Math.floor(Math.random() * matchingOverlays.length)];
  const overlayPath = path.join(dir, selectedOverlay);

  console.log(`🎞 Using ${format} overlay: ${selectedOverlay} for theme: "${theme}" (${matchingOverlays.length} variant${matchingOverlays.length > 1 ? 's' : ''} available)`);
  
  return overlayPath;
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

/* ------------------ RUN COMMAND (IMPROVED ERROR HANDLING) ------------------ */
function run(cmd) {
  return new Promise((resolve, reject) => {
    console.log("🔧 Executing FFmpeg...");
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 500 }, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg failed!");
        console.error("❌ Exit code:", error.code);
        console.error("❌ stderr (last 2000 chars):", stderr.slice(-2000));
        console.error("❌ stdout (last 500 chars):", stdout.slice(-500));
        reject(new Error(`FFmpeg failed: ${stderr.slice(-500) || error.message}`));
        return;
      }
      
      // Log warnings but don't fail
      if (stderr && stderr.includes("Error") && !stderr.includes("deprecated")) {
        console.warn("⚠️ FFmpeg warnings:", stderr.slice(-1000));
      }
      
      console.log("✅ FFmpeg completed successfully");
      resolve(stdout);
    });
  });
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
async function renderVideo(videoId, images, audioUrl, format, theme, sceneTimings = null) {
  const dir = `/tmp/${videoId}`;

  try {
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- DOWNLOAD ---------- */
    for (let i = 0; i < images.length; i++) {
      await download(images[i], `${dir}/img${i}.jpg`);
    }
    
    // Download audio as MP3 (ElevenLabs returns MP3)
    await download(audioUrl, `${dir}/voice.mp3`);
    console.log("✅ Downloaded audio as voice.mp3");

    /* ---------- AMBIENCE ---------- */
    const ambPath = pickAmbience(theme);

    console.log("🎧 Ambience file:", ambPath);

    if (!ambPath || !fs.existsSync(ambPath)) {
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
    const endCardDuration = 2.5;

   
    /* ---------- DURATIONS ---------- */
    const audioDur = ffprobeDuration(`${dir}/voice.mp3`);
    console.log("⏱ Narration duration:", audioDur);

    const storyDuration = endCardPath ? audioDur - endCardDuration : audioDur;
    const numStoryImages = images.length;
    
    const fps = 25;
    const [W, H] = format === "9:16" ? [1080, 1920] : [1920, 1080];

    // Calculate per-image durations
    let imageDurations = [];
    
    if (sceneTimings && sceneTimings.length === numStoryImages) {
      // Use provided timings (word count based)
      const totalWords = sceneTimings.reduce((sum, s) => sum + s.wordCount, 0);
      
      imageDurations = sceneTimings.map(scene => {
        const proportion = scene.wordCount / totalWords;
        const duration = Math.max(storyDuration * proportion, 3); // minimum 3 seconds
        return duration;
      });
      
      // Adjust to match exact audio duration
      const totalCalculated = imageDurations.reduce((sum, d) => sum + d, 0);
      const adjustmentFactor = storyDuration / totalCalculated;
      imageDurations = imageDurations.map(d => d * adjustmentFactor);
      
      console.log("⏱ Using word-count based timings:");
      imageDurations.forEach((d, i) => {
        console.log(`   Scene ${i + 1}: ${d.toFixed(2)}s (${sceneTimings[i].wordCount} words)`);
      });
    } else {
      // Fallback: equal duration for all images
      const perImage = Math.max(storyDuration / numStoryImages, 3);
      imageDurations = images.map(() => perImage);
      console.log(`🖼️ Using equal split: ${perImage.toFixed(2)}s per image`);
    }

    console.log(`📐 Output resolution: ${W}x${H}`);
    console.log(`🖼️ Images: ${numStoryImages}, total story duration: ${storyDuration.toFixed(2)}s`);

    /* ========== TWO-PASS RENDER (avoids resource exhaustion with many inputs) ========== */
    const fadeDuration = 0.5;
    const scaleW = Math.round(W * 1.1);
    const scaleH = Math.round(H * 1.1);
    const out = `${dir}/out.mp4`;
    const tempConcat = `${dir}/concat.mp4`;

    /* ---------- PASS 1: CONCAT IMAGES → intermediate video ---------- */
    let pass1Inputs = images
      .map(
        (_, i) =>
          `-loop 1 -framerate ${fps} -t ${imageDurations[i]} -i "${dir}/img${i}.jpg"`
      )
      .join(" ");

    if (endCardPath) {
      pass1Inputs += ` -loop 1 -framerate ${fps} -t ${endCardDuration} -i "${endCardPath}"`;
    }

    const endCardIdx = images.length;

    let pass1Filter = images
      .map((_, i) => {
        const duration = imageDurations[i];
        const totalFrames = Math.floor(duration * fps);
        const denom = Math.max(totalFrames - 1, 1);
        const effect = i % 4;

        let panFilter;
        switch (effect) {
          case 0:
            panFilter =
              `crop=${W}:${H}:` +
              `x='max(0,min(${scaleW - W},(${scaleW}-${W})*n/${denom}))':` +
              `y='(${scaleH}-${H})/2'`;
            break;
          case 1:
            panFilter =
              `crop=${W}:${H}:` +
              `x='max(0,min(${scaleW - W},(${scaleW}-${W})*(1-n/${denom})))':` +
              `y='(${scaleH}-${H})/2'`;
            break;
          case 2:
            panFilter =
              `crop=${W}:${H}:` +
              `x='(${scaleW}-${W})/2':` +
              `y='max(0,min(${scaleH - H},(${scaleH}-${H})*n/${denom}))'`;
            break;
          case 3:
            panFilter =
              `crop=${W}:${H}:` +
              `x='(${scaleW}-${W})/2':` +
              `y='max(0,min(${scaleH - H},(${scaleH}-${H})*(1-n/${denom})))'`;
            break;
        }

        const baseFilter = `[${i}:v]scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,crop=${scaleW}:${scaleH},${panFilter},fps=${fps},format=yuv420p,setsar=1,setpts=PTS-STARTPTS`;

        if (i === 0) {
          return baseFilter + `,fade=t=in:st=0:d=${fadeDuration}[v${i}]`;
        } else if (i === images.length - 1) {
          return baseFilter + `,fade=t=out:st=${duration - fadeDuration}:d=${fadeDuration}[v${i}]`;
        } else {
          return baseFilter + `,fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${duration - fadeDuration}:d=${fadeDuration}[v${i}]`;
        }
      })
      .join(";");

    if (endCardPath) {
      pass1Filter += `;[${endCardIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p,setsar=1,setpts=PTS-STARTPTS,fade=t=in:st=0:d=${fadeDuration}[vendcard]`;
      pass1Filter +=
        ";" +
        images.map((_, i) => `[v${i}]`).join("") +
        `[vendcard]concat=n=${images.length + 1}:v=1:a=0[vconcat];` +
        `[vconcat]trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;
    } else {
      pass1Filter +=
        ";" +
        images.map((_, i) => `[v${i}]`).join("") +
        `concat=n=${images.length}:v=1:a=0[vconcat];` +
        `[vconcat]trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;
    }

    pass1Filter += `;[base]format=yuv420p[v]`;

    const ffmpegPass1 =
      `ffmpeg -y ${pass1Inputs} ` +
      `-filter_complex "${pass1Filter}" ` +
      `-map "[v]" ` +
      `-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p "${tempConcat}"`;

    console.log("🎬 Pass 1: Concatenating", images.length, "images" + (endCardPath ? " + end card" : "") + "...");
    console.log("🧠 Pass 1 command length:", ffmpegPass1.length, "chars");
    await run(ffmpegPass1);

    /* ---------- PASS 2: OVERLAY + AUDIO MIX ---------- */
    let pass2Inputs = `-i "${tempConcat}" -i "${dir}/voice.mp3" -i "${ambPath}"`;
    if (overlayPath) pass2Inputs += ` -stream_loop -1 -i "${overlayPath}"`;

    // In pass 2: 0=concat video, 1=voice, 2=ambience, 3=overlay (if present)
    let pass2Filter = "";

    if (overlayPath) {
      pass2Filter =
        `[3:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,` +
        `fps=${fps},format=yuva420p,setsar=1,` +
        `colorchannelmixer=aa=0.25,setpts=PTS-STARTPTS[ov]` +
        `;[0:v][ov]overlay=shortest=1:format=yuv420[v_pre]` +
        `;[v_pre]format=yuv420p[v]`;
    } else {
      pass2Filter = `[0:v]format=yuv420p[v]`;
    }

    pass2Filter +=
      `;[1:a]aformat=fltp:48000:stereo,asetpts=PTS-STARTPTS[vox]` +
      `;[2:a]aformat=fltp:48000:stereo,` +
      `aloop=loop=-1:size=2e+09,volume=0.12,apad,` +
      `atrim=0:${audioDur},asetpts=PTS-STARTPTS[amb]` +
      `;[vox][amb]amix=inputs=2:duration=first:dropout_transition=0[a]`;

    const ffmpegPass2 =
      `ffmpeg -y ${pass2Inputs} ` +
      `-filter_complex "${pass2Filter}" ` +
      `-map "[v]" -map "[a]" ` +
      `-t ${audioDur} ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 160k "${out}"`;

    console.log("🎬 Pass 2: Adding overlay + audio...");
    console.log("🧠 Pass 2 command length:", ffmpegPass2.length, "chars");
    await run(ffmpegPass2);

    // Clean up intermediate file
    if (fs.existsSync(tempConcat)) fs.unlinkSync(tempConcat);

    // Verify output exists
    if (!fs.existsSync(out)) {
      console.error("❌ FFmpeg completed but output file missing!");
      console.error("❌ Directory contents:", fs.readdirSync(dir));
      throw new Error("FFmpeg did not produce output file");
    }

    /* ---------- UPLOAD TO SUPABASE ---------- */
    const buffer = fs.readFileSync(out);
    console.log("📦 Output video size:", (buffer.length / 1024 / 1024).toFixed(2), "MB");
    
    const publicUrl = await uploadToSupabase(videoId, buffer);

    /* ---------- UPDATE DB ---------- */
    await updateVideoStatus(videoId, "done", publicUrl);

    console.log("✅ Render complete:", publicUrl);

    /* ---------- CLEANUP ---------- */
    fs.rmSync(dir, { recursive: true, force: true });

    return publicUrl;
  } catch (e) {
    console.error("🔥 Render failed:", e);

    try {
      await updateVideoStatus(videoId, "failed");
    } catch (dbErr) {
      console.error("❌ Could not update DB to failed:", dbErr);
    }

    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    throw e;
  }
}

/* ------------------ ENDPOINT ------------------ */
app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format = "9:16", theme = "", sceneTimings = null } = req.body;

    console.log("🎬 Render request:", { videoId, format, theme });
    console.log("🖼 Images:", images?.length);
    console.log("⏱ Scene timings:", sceneTimings ? "provided" : "not provided (will use equal split)");


    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    await updateVideoStatus(videoId, "rendering");

    res.status(202).json({
      success: true,
      message: "Rendering started",
      videoId,
    });

    renderVideo(videoId, images, audioUrl, format, theme, sceneTimings).catch((e) => {
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
