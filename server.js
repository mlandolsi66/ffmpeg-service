import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

function normalizeTheme(t) {
  return String(t || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/**
 * Map your 6 frontend themes -> one ambience file.
 * Adjust keys to EXACT theme strings you use on Wix.
 *
 * If your Wix themes are already exactly "adventure", "fairy", etc. you’re done.
 */
function pickAmbienceFilename(themeRaw) {
  const theme = String(themeRaw || "").trim().toLowerCase();

  const map = {
    "fairy garden adventure": "fairy-garden-adventure.wav",
    "princess star dreams": "fairy.wav",

    "magic forest friends": "magic-forest-friends.wav",

    "dino explorer": "music-box-34179.wav",

    "ocean wonders": "waves.wav", // or "underwater.wav" if you prefer

    "space bedtime journey": "whitenoise-space.wav",
  };

  return map[theme] || null;
}

async function downloadToFile(url, filepath) {
  const r = await fetch(url);
  if (!r.ok) return { ok: false, status: r.status, contentType: r.headers.get("content-type") || "" };

  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(filepath, buf);

  return { ok: true, status: r.status, contentType: r.headers.get("content-type") || "" };
}

function looksLikeWav(filepath) {
  try {
    const fd = fs.openSync(filepath, "r");
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);

    // WAV usually starts with "RIFF" and contains "WAVE"
    const riff = header.toString("ascii", 0, 4) === "RIFF";
    const wave = header.toString("ascii", 8, 12) === "WAVE";
    return riff && wave;
  } catch {
    return false;
  }
}

function ffprobeDurationSeconds(filepath) {
  return parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filepath}"`
    ).toString().trim()
  );
}

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // 1) Download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) return res.status(400).json({ error: "Image download failed" });
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // 2) Download narration audio
    const ar = await fetch(audioUrl);
    if (!ar.ok) return res.status(400).json({ error: "Audio download failed" });

    const audioBuf = Buffer.from(await ar.arrayBuffer());
    fs.writeFileSync(`${dir}/audio.wav`, audioBuf);

    // 3) Determine narration duration (truth source)
    let audioDuration;
    try {
      audioDuration = ffprobeDurationSeconds(`${dir}/audio.wav`);
      if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
        return res.status(400).json({ error: "Invalid WAV audio duration" });
      }
    } catch {
      return res.status(400).json({ error: "Invalid WAV audio" });
    }

    // 4) Per-image duration matches narration length
    const perImageDuration = audioDuration / images.length;

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const out = `${dir}/out.mp4`;

    const inputs = images
      .map((_, i) => `-loop 1 -t ${perImageDuration} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    // 5) OPTIONAL: Theme-based ambience (safe + fallback)
    const ASSET_BASE_URL = process.env.ASSET_BASE_URL; // e.g. https://.../storage/v1/object/public/videos
    let useAmbience = false;
    let ambiencePath = `${dir}/ambience.wav`;

    if (ASSET_BASE_URL) {
      const ambienceFile = pickAmbienceFilename(theme);
      if (ambienceFile) {
        const ambienceUrl = `${ASSET_BASE_URL}/ambience/${ambienceFile}`;

        try {
          const dl = await downloadToFile(ambienceUrl, ambiencePath);

          // Guardrail: avoid “downloaded HTML”
          const okMagic = looksLikeWav(ambiencePath);

          if (!dl.ok || !okMagic) {
            console.warn("⚠️ Ambience download invalid, skipping.", {
              theme,
              ambienceUrl,
              status: dl.status,
              contentType: dl.contentType,
              okMagic
            });
            useAmbience = false;
          } else {
            // Ensure ffmpeg can read it (ffprobe quick check)
            try {
              ffprobeDurationSeconds(ambiencePath);
              useAmbience = true;
              console.log("🎧 Ambience enabled:", { theme, ambienceFile });
            } catch {
              console.warn("⚠️ Ambience ffprobe failed, skipping.", { theme, ambienceFile });
              useAmbience = false;
            }
          }
        } catch (e) {
          console.warn("⚠️ Ambience exception, skipping.", e);
          useAmbience = false;
        }
      }
    } else {
      console.warn("⚠️ ASSET_BASE_URL not set; ambience disabled.");
    }

    // fade timing
    const vFadeDur = 1.5;
    const aFadeDur = 2.0;
    const vFadeStart = Math.max(0, audioDuration - vFadeDur).toFixed(3);
    const aFadeStart = Math.max(0, audioDuration - aFadeDur).toFixed(3);

    // Build per-image scale/crop filters
    const vFilters = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size},setpts=PTS-STARTPTS[v${i}]`
      )
      .join(";");

    const concatInputs = images.map((_, i) => `[v${i}]`).join("");

    // Index of narration audio input in ffmpeg input list:
    // inputs are: [0..N-1] images, then narration is N
    const narrationIndex = images.length;

    // If ambience is used, it will be added as a new -i after narration
    // so ambience audio index becomes N+1.
    const ambienceIndex = images.length + 1;

    // --- FILTER COMPLEX ---
    // We keep your exact baseline slideshow structure and only swap audio handling:
    // - Without ambience: narration fade-out only
    // - With ambience: ambience is looped input, volume reduced, mixed under narration, then fade-out on the MIX.
    let filterComplex;

    if (!useAmbience) {
      filterComplex =
        `${vFilters};` +
        `${concatInputs}concat=n=${images.length}:v=1:a=0[vraw];` +
        `[vraw]fade=t=out:st=${vFadeStart}:d=${vFadeDur}[v];` +
        `[${narrationIndex}:a]afade=t=out:st=${aFadeStart}:d=${aFadeDur}[a]`;
    } else {
      // ambience volume: start conservative (0.14). You can tweak 0.12–0.20.
      const ambVol = 0.22;

      filterComplex =
        `${vFilters};` +
        `${concatInputs}concat=n=${images.length}:v=1:a=0[vraw];` +
        `[vraw]fade=t=out:st=${vFadeStart}:d=${vFadeDur}[v];` +
        // ambience chain
        `[${ambienceIndex}:a]volume=${ambVol},afade=t=in:d=1,afade=t=out:st=${aFadeStart}:d=${aFadeDur}[amb];` +
        // mix narration + ambience (narration is master duration)
        `[${narrationIndex}:a][amb]amix=inputs=2:duration=first:dropout_transition=2,afade=t=out:st=${aFadeStart}:d=${aFadeDur}[a]`;
    }

    // Encoding controls (helps with Supabase 413 + consistent output)
    const videoEncode =
      `-r 30 -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -movflags +faststart`;

    const audioEncode =
      `-c:a aac -b:a 128k`;

    const cmdBase =
      `ffmpeg -y ${inputs} ` +
      `-i "${dir}/audio.wav" `;

    const cmdAmb = useAmbience
      ? `-stream_loop -1 -i "${ambiencePath}" `
      : "";

    const cmd =
      cmdBase +
      cmdAmb +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map "[a]" ` +
      `-shortest ${videoEncode} ${audioEncode} "${out}"`;

    console.log("🎬 FFmpeg cmd:", cmd);

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, _stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg failed:", stderr);
        return res.status(500).json({ error: "FFmpeg failed" });
      }
      const buf = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(buf);
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0");
