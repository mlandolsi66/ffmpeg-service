import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ------------------ HELPERS ------------------ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadWithRetry(
  url,
  dest,
  { tries = 3, minBytes = 10_000, expectType = "" } = {}
) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const buf = Buffer.from(await r.arrayBuffer());

      if (buf.length < minBytes) throw new Error(`Too small (${buf.length})`);
      if (ct.includes("text/html") || ct.includes("application/json"))
        throw new Error(`Bad content-type: ${ct}`);
      if (expectType && !ct.includes(expectType))
        throw new Error(`Unexpected content-type: ${ct}`);

      fs.writeFileSync(dest, buf);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(300 * i);
    }
  }
  throw lastErr;
}

function ffprobeOk(file) {
  try {
    execSync(`ffprobe -v error -show_entries stream=index -of csv=p=0 "${file}"`);
    return true;
  } catch {
    return false;
  }
}

function ffprobeDuration(file) {
  try {
    return parseFloat(
      execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
      )
        .toString()
        .trim()
    );
  } catch {
    return NaN;
  }
}

function runFfmpeg(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 80 }, (err, stdout, stderr) => {
      if (err) reject({ err, stderr });
      else resolve();
    });
  });
}

/* ------------------ AMBIENCE / OVERLAY ------------------ */

function pickAmbience(theme) {
  theme = String(theme || "").toLowerCase();
  if (theme.includes("ocean")) return "waves.wav";
  if (theme.includes("space")) return "whitenoise-space.wav";
  return null;
}

function pickOverlay(format) {
  return format === "9:16" ? "bokeh.mp4" : "magic.mp4";
}

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  const { videoId, images, audioUrl, format, theme } = req.body;
  if (!videoId || !images?.length || !audioUrl)
    return res.status(400).json({ error: "Missing inputs" });

  const dir = `/tmp/${videoId}`;
  fs.mkdirSync(dir, { recursive: true });

  try {
    /* ---------- DOWNLOAD IMAGES ---------- */
    for (let i = 0; i < images.length; i++) {
      await downloadWithRetry(images[i], `${dir}/img${i}.jpg`, {
        expectType: "image",
        minBytes: 8000,
      });
    }

    /* ---------- AUDIO ---------- */
    await downloadWithRetry(audioUrl, `${dir}/audio.wav`, {
      expectType: "audio",
      minBytes: 20_000,
    });
    if (!ffprobeOk(`${dir}/audio.wav`))
      throw new Error("Narration audio invalid");

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    const perImage = Math.max(audioDuration / images.length, 3);
    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":");

    /* ---------- OPTIONAL ASSETS ---------- */
    let ambienceOk = false;
    let overlayOk = false;

    const amb = pickAmbience(theme);
    if (amb && process.env.ASSET_BASE_URL) {
      try {
        await downloadWithRetry(
          `${process.env.ASSET_BASE_URL}/ambience/${amb}`,
          `${dir}/amb.wav`,
          { expectType: "audio", minBytes: 20_000 }
        );
        ambienceOk = ffprobeOk(`${dir}/amb.wav`);
      } catch {}
    }

    if (process.env.ASSET_BASE_URL) {
      try {
        await downloadWithRetry(
          `${process.env.ASSET_BASE_URL}/overlays/${pickOverlay(format)}`,
          `${dir}/overlay.mp4`,
          { expectType: "video", minBytes: 50_000 }
        );
        overlayOk = ffprobeOk(`${dir}/overlay.mp4`);
      } catch {}
    }

    /* ---------- ATTEMPT MATRIX ---------- */
    const attempts = [
      { overlay: overlayOk, ambience: ambienceOk },
      { overlay: false, ambience: ambienceOk },
      { overlay: false, ambience: false },
    ];

    for (const attempt of attempts) {
      try {
        const inputs = images
          .map(
            (_, i) =>
              `-loop 1 -t ${perImage} -i "${dir}/img${i}.jpg"`
          )
          .join(" ");

        const aud = ` -i "${dir}/audio.wav"`;
        const amb = attempt.ambience
          ? ` -stream_loop -1 -i "${dir}/amb.wav"`
          : "";
        const ov = attempt.overlay
          ? ` -stream_loop -1 -i "${dir}/overlay.mp4"`
          : "";

        let filter = images
          .map(
            (_, i) =>
              `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
          )
          .join(";");

        filter += `;${images.map((_, i) => `[v${i}]`).join("")}concat=n=${images.length}:v=1:a=0[vbase]`;

        if (attempt.overlay) {
          const idx = images.length + 1 + (attempt.ambience ? 1 : 0);
          filter += `;[vbase][${idx}:v]overlay=shortest=1[v]`;
        } else {
          filter += `;[vbase]format=yuv420p[v]`;
        }

        if (attempt.ambience) {
          filter += `;[${images.length}:a][${images.length + 1}:a]amix=inputs=2:duration=first[a]`;
        } else {
          filter += `;[${images.length}:a]anull[a]`;
        }

        const cmd =
          `ffmpeg -y ${inputs}${aud}${amb}${ov} ` +
          `-filter_complex "${filter}" ` +
          `-map "[v]" -map "[a]" -shortest ` +
          `-c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p ` +
          `-c:a aac -b:a 128k "${dir}/out.mp4"`;

        await runFfmpeg(cmd);
        res.setHeader("Content-Type", "video/mp4");
        return res.send(fs.readFileSync(`${dir}/out.mp4`));
      } catch (e) {
        console.warn("⚠️ ffmpeg attempt failed, retrying simpler pipeline");
      }
    }

    throw new Error("All ffmpeg attempts failed");

  } catch (e) {
    console.error("🔥 render failed:", e);
    res.status(500).json({ error: "Render failed", details: String(e.message || e) });
  }
});

app.listen(8080, "0.0.0.0");
