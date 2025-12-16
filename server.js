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
      return res.status(400).json({ error: "Missing videoId, images or audio" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // Download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // Download audio
    const ar = await fetch(audioUrl);
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const out = `${dir}/out.mp4`;

    // Inputs: 6 seconds per image
    const inputs = images
      .map((_, i) => `-loop 1 -t 6 -i ${dir}/img${i}.jpg`)
      .join(" ");

    // SAFE motion using time-based crop (NO zoompan)
    const motions = [
      // left → right
      `x='(iw-ow)*(t/6)':y='(ih-oh)/2'`,
      // right → left
      `x='(iw-ow)*(1-t/6)':y='(ih-oh)/2'`,
      // top → bottom
      `x='(iw-ow)/2':y='(ih-oh)*(t/6)'`,
      // bottom → top
      `x='(iw-ow)/2':y='(ih-oh)*(1-t/6)'`
    ];

    const filters = images.map((_, i) => {
      const motion = motions[i % motions.length];
      return `
        [${i}:v]
        scale=1.15*iw:1.15*ih,
        crop=${size}:${motion},
        setpts=PTS-STARTPTS
        [v${i}]
      `;
    }).join(";");

    const concat = images.map((_, i) => `[v${i}]`).join("");
    const filterComplex = `${filters};${concat}concat=n=${images.length}:v=1:a=0[v]`;

    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-i ${dir}/audio.wav ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map ${images.length}:a ` +
      `-shortest -pix_fmt yuv420p "${out}"`;

    console.log("🎬 FFmpeg:", cmd);

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr);
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 FFmpeg service running on ${PORT}`);
});
