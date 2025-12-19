import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

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
  if (!r.ok) return { ok: false, status: r.status };
  fs.writeFileSync(filepath, Buffer.from(await r.arrayBuffer()));
  return { ok: true };
}

function looksLikeWav(filepath) {
  try {
    const fd = fs.openSync(filepath, "r");
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);
    return (
      header.toString("ascii", 0, 4) === "RIFF" &&
      header.toString("ascii", 8, 12) === "WAVE"
    );
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
  return parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filepath}"`
    )
      .toString()
      .trim()
  );
}

/**
 * Normalize overlay into a clean, decodable H.264 stream:
 * - strip audio (-an)
 * - force size + yuv420p
 * - re-encode to baseline H.264 for max compatibility
 */
function normalizeOverlay(rawPath, cleanPath, W, H) {
  execSync(
    `ffmpeg -y -v error -i "${rawPath}" -an ` +
      `-vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=yuv420p" ` +
      `-c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p ` +
      `"${cleanPath}"`
  );
}

/* ------------------ DEBUG ENDPOINT ------------------ */

app.get("/debug-overlay", async (_req, res) => {
  try {
    const ASSET_BASE_URL = process.env.ASSET_BASE_URL;
    if (!ASSET_BASE_URL) return res.status(400).send("ASSET_BASE_URL missing");

    const file = "/tmp/test-overlay.mp4";
    await fetch(`${ASSET_BASE_URL}/overlays/sparkles.mp4`)
      .then((r) => r.arrayBuffer())
      .then((b) => fs.writeFileSync(file, Buffer.from(b)));

    const info = execSync(`ffprobe "${file}"`).toString();
    res.type("text").send(info);
  } catch {
    res.status(500).send("ffprobe failed");
  }
});

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;
    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- IMAGES ---------- */
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) return res.status(400).json({ error: "Image download failed" });
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
    }

    /* ---------- AUDIO ---------- */
    const ar = await fetch(audioUrl);
    if (!ar.ok) return res.status(400).json({ error: "Audio download failed" });
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(await ar.arrayBuffer()));

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    if (!audioDuration || audioDuration < 1) {
      return res.status(400).json({ error: "Invalid audio duration" });
    }

    const perImage = audioDuration / images.length;
    const fade = 1.2; // your choice

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":");
    const out = `${dir}/out.mp4`;

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

    /* ---------- OVERLAY (HARDENED) ---------- */
    let useOverlay = false;
    const overlayRawPath = `${dir}/overlay_raw.mp4`;
    const overlayCleanPath = `${dir}/overlay_clean.mp4`;

    if (ASSET_BASE_URL) {
      const overlayFile = pickRandomOverlay();
      const overlayUrl = `${ASSET_BASE_URL}/overlays/${overlayFile}`;
      const dl = await downloadToFile(overlayUrl, overlayRawPath);

      if (dl.ok && ffprobeOk(overlayRawPath)) {
        try {
          // normalize to clean H.264
          normalizeOverlay(overlayRawPath, overlayCleanPath, W, H);
          if (ffprobeOk(overlayCleanPath)) {
            useOverlay = true;
            console.log("✨ Overlay OK (normalized):", overlayFile);
          } else {
            console.warn("⚠️ Overlay normalize failed (ffprobe):", overlayFile);
          }
        } catch (e) {
          console.warn("⚠️ Overlay normalize crashed, skipping:", overlayFile);
        }
      } else {
        console.warn("⚠️ Overlay download/ffprobe failed, skipping:", overlayFile);
      }
    }

    /* ---------- INPUTS ---------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -t ${perImage} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    // IMPORTANT:
    // - ambience can be looped
    // - overlay should NOT be stream_looped (decoder stability)
    const inputs =
      imageInputs +
      ` -i "${dir}/audio.wav"` +
      (useAmbience ? ` -stream_loop -1 -i "${ambiencePath}"` : "") +
      (useOverlay ? ` -i "${overlayCleanPath}"` : "");

    /* ---------- FILTER GRAPH ---------- */
    let filters = [];

    images.forEach((_, i) => {
      filters.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
          `crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
      );
    });

    let last = "v0";
    let offset = perImage - fade;

    for (let i = 1; i < images.length; i++) {
      filters.push(
        `[${last}][v${i}]xfade=transition=fade:duration=${fade}:offset=${offset}[vxf${i}]`
      );
      last = `vxf${i}`;
      offset += perImage;
    }

    let filter = filters.join(";");

    if (useOverlay) {
      const overlayIndex = images.length + (useAmbience ? 2 : 1);

      // loop overlay visually inside the filter graph with tpad (safe)
      filter +=
        `;[${last}]format=rgba[base]` +
        `;[${overlayIndex}:v]format=rgba,scale=${W}:${H},colorchannelmixer=aa=0.18,` +
        `tpad=stop_mode=clone:stop_duration=${Math.ceil(audioDuration)}[fx]` +
        `;[base][fx]overlay=shortest=1,format=yuv420p[v]`;
    } else {
      filter += `;[${last}]format=yuv420p[v]`;
    }

    /* ---------- AUDIO ---------- */
    if (useAmbience) {
      filter +=
        `;[${images.length + 1}:a]volume=0.2[amb]` +
        `;[${images.length}:a][amb]amix=inputs=2:duration=first[a]`;
    } else {
      filter += `;[${images.length}:a]anull[a]`;
    }

    /* ---------- EXEC ---------- */
    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" -shortest -r 30 ` +
      `-c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 128k "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, _stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg STDERR:", stderr);
        return res.status(500).json({ error: "FFmpeg failed" });
      }
      res.setHeader("Content-Type", "video/mp4");
      res.send(fs.readFileSync(out));
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0");
