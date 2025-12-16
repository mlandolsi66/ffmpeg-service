import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

// PUBLIC STAR OVERLAY (black background)
const STAR_URL =
  "https://cdn.pixabay.com/video/2020/09/02/48869-460982617_large.mp4";

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format } = req.body;
    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // Images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // Audio
    const ar = await fetch(audioUrl);
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    // Try to download stars
    let hasStars = true;
    const starPath = `${dir}/stars.mp4`;
    try {
      const sr = await fetch(STAR_URL);
      const sb = await sr.arrayBuffer();
      fs.writeFileSync(starPath, Buffer.from(sb));
    } catch {
      hasStars = false;
    }

    const target = format === "9:16" ? "1080:1920" : "1920:1080";
    const big = format === "9:16" ? "1400:2500" : "2500:1400";
    const out = `${dir}/out.mp4`;

    const inputs =
      images.map((_, i) => `-loop 1 -t 6 -i ${dir}/img${i}.jpg`).join(" ") +
      (hasStars ? ` -stream_loop -1 -i ${starPath}` : "");

    const motions = [
      `x='(iw-ow)*(t/6)':y='(ih-oh)/2'`,
      `x='(iw-ow)*(1-t/6)':y='(ih-oh)/2'`,
      `x='(iw-ow)/2':y='(ih-oh)*(t/6)'`,
      `x='(iw-ow)/2':y='(ih-oh)*(1-t/6)'`
    ];

    const opacities = [0.25, 0.35, 0.30, 0.40];

    const filters = images.map((_, i) => {
      if (!hasStars) {
        return `
          [${i}:v]
          scale=${big}:force_original_aspect_ratio=increase,
          crop=${target}:${motions[i % motions.length]},
          setpts=PTS-STARTPTS
          [v${i}]
        `;
      }

      return `
        [${i}:v]
        scale=${big}:force_original_aspect_ratio=increase,
        crop=${target}:${motions[i % motions.length]},
        setpts=PTS-STARTPTS
        [base${i}];

        [${images.length}:v]
        scale=${target},
        colorchannelmixer=rr=${opacities[i % opacities.length]}:
                           gg=${opacities[i % opacities.length]}:
                           bb=${opacities[i % opacities.length]},
        setpts=PTS-STARTPTS
        [stars${i}];

        [base${i}][stars${i}]
        blend=all_mode=screen
        [v${i}]
      `;
    }).join(";");

    const concat = images.map((_, i) => `[v${i}]`).join("");
    const filterComplex =
      `${filters};${concat}concat=n=${images.length}:v=1:a=0[v]`;

    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-i ${dir}/audio.wav ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map ${hasStars ? images.length + 1 : images.length}:a ` +
      `-shortest -pix_fmt yuv420p "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err) => {
      if (err) {
        console.error("FFmpeg failed");
        return res.status(500).json({ error: "FFmpeg failed" });
      }
      const buf = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(buf);
    });

  } catch (e) {
    console.error("Server crash", e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0");
