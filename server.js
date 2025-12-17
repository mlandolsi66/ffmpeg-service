import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) throw new Error("Image download failed");
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // download audio
    const ar = await fetch(audioUrl);
    if (!ar.ok) throw new Error("Audio download failed");
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    // concat list
    const perImageSeconds = 6;
    let list = "";
    for (let i = 0; i < images.length; i++) {
      list += `file '${dir}/img${i}.jpg'\n`;
      list += `duration ${perImageSeconds}\n`;
    }
    // concat demuxer requirement: repeat last frame
    list += `file '${dir}/img${images.length - 1}.jpg'\n`;
    fs.writeFileSync(`${dir}/list.txt`, list);

    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;

    const out = `${dir}/out.mp4`;

    // IMPORTANT:
    // - scale can be W:H (use colon)
    // - crop MUST be W:H (use colon)  ✅ FIX
    const cmd = `
ffmpeg -y -hide_banner -loglevel error \
-f concat -safe 0 -i ${dir}/list.txt \
-i ${dir}/audio.wav \
-vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}" \
-r 30 -shortest -pix_fmt yuv420p \
${out}
`.replace(/\s+/g, " ").trim();

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, _stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg failed:", stderr || err.message);
        return res.status(500).json({ error: "FFmpeg failed", stderr: (stderr || "").slice(-1500) });
      }

      const buf = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(buf);
    });

  } catch (e) {
    console.error("🔥 Server crash:", e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0", () => {
  console.log("🎬 FFmpeg service running on 0.0.0.0:8080");
});
