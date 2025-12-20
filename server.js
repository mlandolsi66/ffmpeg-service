import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ------------------ THEME → AMBIENCE ------------------ */

function pickAmbienceFilename(themeRaw) {
  const theme = String(themeRaw || "").toLowerCase();
  if (theme.includes("ocean")) return "waves.wav";
  if (theme.includes("space")) return "whitenoise-space.wav";
  if (theme.includes("dino")) return "music-box-34179.wav";
  return null;
}

/* ------------------ OVERLAY PICKER ------------------ */

function pickOverlay(format) {
  if (format === "9:16") {
    return ["bokeh.mp4", "dust.mp4", "lights.mp4"][Math.floor(Math.random() * 3)];
  }
  return ["sparkles.mp4", "magic.mp4", "dust_bokeh.mp4"][Math.floor(Math.random() * 3)];
}

/* ------------------ HELPERS ------------------ */

function ffprobeDuration(file) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
    ).toString().trim();
    return parseFloat(out);
  } catch {
    return NaN;
  }
}

async function downloadWithRetry(url, dest, { tries = 3, minBytes = 10_000, expectType = "" } = {}) {
  let lastErr = null;

  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const buf = Buffer.from(await r.arrayBuffer());

      // reject obvious bad downloads (HTML error pages, tiny files)
      if (buf.length < minBytes) {
        throw new Error(`Too small (${buf.length} bytes)`);
      }
      if (ct.includes("text/html") || ct.includes("application/json")) {
        throw new Error(`Bad content-type: ${ct}`);
      }
      if (expectType && !ct.includes(expectType)) {
        // not strict, but helps catch overlay mp4 returning wrong content
        throw new Error(`Unexpected content-type: ${ct} (expected ~${expectType})`);
      }

      fs.writeFileSync(dest, buf);
      return { ok: true, bytes: buf.length, contentType: ct };
    } catch (e) {
      lastErr = e;
      // small backoff
      await new Promise((r) => setTimeout(r, 250 * i));
    }
  }

  throw new Error(`Download failed after retries: ${url} :: ${lastErr?.message || lastErr}`);
}

function runFfmpeg(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 80 }, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  const started = Date.now();

  try {
    const { videoId, images, audioUrl, format, theme } = req.body;

    if (!videoId || !Array.isArray(images) || images.length === 0 || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- IMAGES ---------- */
    for (let i = 0; i < images.length; i++) {
      if (!images[i]) return res.status(400).json({ error: `Missing image at index ${i}` });
      await downloadWithRetry(images[i], `${dir}/img${i}.jpg`, { tries: 3, minBytes: 8_000, expectType: "image" });
    }

    /* ---------- AUDIO ---------- */
    await downloadWithRetry(audioUrl, `${dir}/audio.wav`, { tries: 3, minBytes: 20_000, expectType: "audio" });

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    if (!audioDuration || !isFinite(audioDuration)) {
      return res.status(400).json({ error: "Invalid narration audio" });
    }

    // ✅ MIN 3 seconds per image (your request)
    const perImage = Math.max(audioDuration / images.length, 3.0);

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":");

    /* ---------- AMBIENCE ---------- */
    let ambienceInput = "";
    let useAmbience = false;

    const ambienceFile = pickAmbienceFilename(theme);
    if (ambienceFile && process.env.ASSET_BASE_URL) {
      try {
        const ambPath = `${dir}/ambience.wav`;
        await downloadWithRetry(
          `${process.env.ASSET_BASE_URL}/ambience/${ambienceFile}`,
          ambPath,
          { tries: 2, minBytes: 20_000, expectType: "audio" }
        );
        useAmbience = true;
        ambienceInput = ` -stream_loop -1 -i "${ambPath}"`;
      } catch (e) {
        console.warn("⚠️ ambience disabled:", e.message);
        useAmbience = false;
        ambienceInput = "";
      }
    }

    /* ---------- OVERLAY ---------- */
    let overlayInput = "";
    let useOverlay = false;

    const overlayFile = pickOverlay(format);
    if (overlayFile && process.env.ASSET_BASE_URL) {
      try {
        const ovPath = `${dir}/overlay.mp4`;
        await downloadWithRetry(
          `${process.env.ASSET_BASE_URL}/overlays/${format === "9:16" ? "9x16" : "16x9"}/${overlayFile}`,
          ovPath,
          { tries: 2, minBytes: 50_000, expectType: "video" } // catch HTML/garbage
        );
        useOverlay = true;
        overlayInput = ` -stream_loop -1 -i "${ovPath}"`;
      } catch (e) {
        console.warn("⚠️ overlay disabled (bad file):", e.message);
        useOverlay = false;
        overlayInput = "";
      }
    }

    /* ---------- INPUTS ---------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -t ${perImage} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    const inputs =
      imageInputs +
      ` -i "${dir}/audio.wav"` +
      ambienceInput +
      overlayInput;

    /* ---------- FILTER GRAPH ---------- */
    // NOTE: we keep your scale/crop logic
    const filters = images.map(
      (_, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
    );

    const concat = images.map((_, i) => `[v${i}]`).join("");
    let filter =
      `${filters.join(";")};` +
      `${concat}concat=n=${images.length}:v=1:a=0[vbase]`;

    if (useOverlay) {
      const overlayIndex = images.length + 1 + (useAmbience ? 1 : 0);
      filter +=
        `;[vbase]format=rgba[base]` +
        `;[${overlayIndex}:v]scale=${W}:${H},format=rgba,colorchannelmixer=aa=0.15[fx]` +
        `;[base][fx]overlay=shortest=1,format=yuv420p[v]`;
    } else {
      filter += `;[vbase]format=yuv420p[v]`;
    }

    if (useAmbience) {
      filter +=
        `;[${images.length + 1}:a]volume=0.2[amb]` +
        `;[${images.length}:a][amb]amix=inputs=2:duration=first[a]`;
    } else {
      filter += `;[${images.length}:a]anull[a]`;
    }

    /* ---------- EXEC (TRY WITH OVERLAY, FALLBACK WITHOUT) ---------- */
    const out = `${dir}/out.mp4`;

    const buildCmd = (overlayOn) => {
      let localFilter = filter;
      let localInputs = inputs;

      if (!overlayOn && useOverlay) {
        // rebuild without overlay input + overlay filter part
        // easiest: just disable by re-running whole request without overlay on first pass
        // (so here: overlayOn false means we already built cmd without overlay)
      }

      return (
        `ffmpeg -y ${localInputs} ` +
        `-filter_complex "${localFilter}" ` +
        `-map "[v]" -map "[a]" -shortest -r 30 ` +
        `-c:v libx264 -preset veryfast -crf 28 ` +
        `-pix_fmt yuv420p -movflags +faststart ` +
        `-c:a aac -b:a 128k "${out}"`
      );
    };

    // first attempt
    const cmd1 = buildCmd(true);

    try {
      await runFfmpeg(cmd1);
    } catch (e1) {
      const stderr = String(e1?.stderr || "");
      const nalCorrupt = stderr.includes("Invalid NAL unit") || stderr.includes("Error splitting the input into NAL units");

      // If overlay is enabled and looks corrupt → retry with overlay disabled
      if (useOverlay && nalCorrupt) {
        console.warn("⚠️ overlay decode corrupt, retrying without overlay");

        // rebuild inputs/filters WITHOUT overlay
        const inputsNoOverlay =
          imageInputs +
          ` -i "${dir}/audio.wav"` +
          ambienceInput; // no overlayInput

        let filterNoOverlay =
          `${filters.join(";")};` +
          `${concat}concat=n=${images.length}:v=1:a=0[vbase];` +
          `[vbase]format=yuv420p[v]`;

        if (useAmbience) {
          filterNoOverlay +=
            `;[${images.length + 1}:a]volume=0.2[amb]` +
            `;[${images.length}:a][amb]amix=inputs=2:duration=first[a]`;
        } else {
          filterNoOverlay += `;[${images.length}:a]anull[a]`;
        }

        const cmd2 =
          `ffmpeg -y ${inputsNoOverlay} ` +
          `-filter_complex "${filterNoOverlay}" ` +
          `-map "[v]" -map "[a]" -shortest -r 30 ` +
          `-c:v libx264 -preset veryfast -crf 28 ` +
          `-pix_fmt yuv420p -movflags +faststart ` +
          `-c:a aac -b:a 128k "${out}"`;

        await runFfmpeg(cmd2);
      } else {
        console.error("❌ FFmpeg failed:", stderr);
        return res.status(500).json({ error: "FFmpeg failed", details: stderr.slice(-2000) });
      }
    }

    const mp4 = fs.readFileSync(out);
    if (!mp4?.length) return res.status(500).json({ error: "Empty output video" });

    console.log("✅ render ok", { videoId, ms: Date.now() - started, perImage });

    res.setHeader("Content-Type", "video/mp4");
    res.send(mp4);

  } catch (e) {
    console.error("🔥 Server crash:", e);
    res.status(500).json({ error: "Server crash", details: String(e?.message || e) });
  }
});

app.listen(8080, "0.0.0.0");
