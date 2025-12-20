import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

function pickAmbienceFilename(themeRaw) {
  const theme = String(themeRaw || "").toLowerCase();
  if (theme.includes("ocean")) return "waves.wav";
  if (theme.includes("space")) return "whitenoise-space.wav";
  if (theme.includes("dino")) return "music-box-34179.wav";
  return null;
}

function pickOverlay(format) {
  if (format === "9:16") {
    return ["bokeh.mp4", "dust.mp4", "lights.mp4"][Math.floor(Math.random() * 3)];
  }
  return ["sparkles.mp4", "magic.mp4", "dust_bokeh.mp4"][Math.floor(Math.random() * 3)];
}

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

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Download failed");
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;
    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    for (let i = 0; i < images.length; i++) {
      await download(images[i], `${dir}/img${i}.jpg`);
    }

    await download(audioUrl, `${dir}/audio.wav`);

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    if (!audioDuration || !isFinite(audioDuration)) {
      return res.status(400).json({ error: "Invalid narration audio" });
    }

    // ✅ SAFE FIX: MIN 3s PER IMAGE
    const perImage = Math.max(audioDuration / images.length, 3);

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":");

    let ambienceInput = "";
    let useAmbience = false;
    const ambienceFile = pickAmbienceFilename(theme);

    if (ambienceFile && process.env.ASSET_BASE_URL) {
      const ambPath = `${dir}/ambience.wav`;
      await download(`${process.env.ASSET_BASE_URL}/ambience/${ambienceFile}`, ambPath);
      useAmbience = true;
      ambienceInput = ` -stream_loop -1 -i "${ambPath}"`;
    }

    let overlayInput = "";
    let useOverlay = false;
    const overlayFile = pickOverlay(format);

    if (overlayFile && process.env.ASSET_BASE_URL) {
      const ovPath = `${dir}/overlay.mp4`;
      await download(
        `${process.env.ASSET_BASE_URL}/overlays/${format === "9:16" ? "9x16" : "16x9"}/${overlayFile}`,
        ovPath
      );
      useOverlay = true;
      overlayInput = ` -stream_loop -1 -i "${ovPath}"`;
    }

    const imageInputs = images
      .map((_, i) => `-loop 1 -t ${perImage} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    const inputs =
      imageInputs +
      ` -i "${dir}/audio.wav"` +
      ambienceInput +
      overlayInput;

    const filters = images.map(
      (_, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
    );

    const concat = images.map((_, i) => `[v${i}]`).join("");
    let filter = `${filters.join(";")};${concat}concat=n=${images.length}:v=1:a=0[vbase]`;

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

    const out = `${dir}/out.mp4`;
    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" -shortest -r 30 ` +
      `-c:v libx264 -preset veryfast -crf 28 ` +
      `-pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 128k "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, _, stderr) => {
      if (err) {
        console.error("❌ FFmpeg STDERR:", stderr);
        return res.status(500).json({ error: "FFmpeg failed" });
      }
      res.setHeader("Content-Type", "video/mp4");
      res.send(fs.readFileSync(out));
    });

  } catch (e) {
    console.error("🔥 Server crash:", e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0");
