/* ---------- FILTER GRAPH (CINEMATIC ZOOM + PAN) ---------- */
    const zoomFactor = 1.2; // 20% zoom (more dramatic than 1.15)
    const totalFrames = Math.floor(perImage * fps);
    const fadeDuration = 0.5;

    // Process each image with Ken Burns zoom + pan
    let filter = images
      .map((_, i) => {
        const zoomIn = i % 2 === 0;
        
        if (zoomIn) {
          // ZOOM IN + PAN RIGHT
          // Camera starts zoomed out on left, zooms in while moving right
          return (
            `[${i}:v]scale=${W * 1.5}:${H * 1.5}:force_original_aspect_ratio=increase,` +
            `crop=${W * 1.5}:${H * 1.5},` +
            `zoompan=` +
            `z='min(1.0+on/${totalFrames}*${zoomFactor - 1.0},${zoomFactor})':` +
            `x='iw/2-(iw/zoom/2)-((1-on/${totalFrames})*iw*0.1)':` + // Pan from left to center
            `y='ih/2-(ih/zoom/2)':` +
            `d=${totalFrames}:s=${W}x${H}:fps=${fps},` +
            `trim=duration=${perImage},format=yuv420p,setpts=PTS-STARTPTS` +
            (i === 0 ? `,fade=t=in:st=0:d=${fadeDuration}[v${i}]` :
             i === images.length - 1 ? `,fade=t=out:st=${perImage - fadeDuration}:d=${fadeDuration}[v${i}]` :
             `,fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${perImage - fadeDuration}:d=${fadeDuration}[v${i}]`)
          );
        } else {
          // ZOOM OUT + PAN LEFT
          // Camera starts zoomed in on right, zooms out while moving left
          return (
            `[${i}:v]scale=${W * 1.5}:${H * 1.5}:force_original_aspect_ratio=increase,` +
            `crop=${W * 1.5}:${H * 1.5},` +
            `zoompan=` +
            `z='max(${zoomFactor}-on/${totalFrames}*${zoomFactor - 1.0},1.0)':` +
            `x='iw/2-(iw/zoom/2)+(on/${totalFrames}*iw*0.1)':` + // Pan from center to right
            `y='ih/2-(ih/zoom/2)':` +
            `d=${totalFrames}:s=${W}x${H}:fps=${fps},` +
            `trim=duration=${perImage},format=yuv420p,setpts=PTS-STARTPTS` +
            (i === 0 ? `,fade=t=in:st=0:d=${fadeDuration}[v${i}]` :
             i === images.length - 1 ? `,fade=t=out:st=${perImage - fadeDuration}:d=${fadeDuration}[v${i}]` :
             `,fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${perImage - fadeDuration}:d=${fadeDuration}[v${i}]`)
          );
        }
      })
      .join(";");

    // Concatenate all scenes (rest stays the same)
    const endCardIdx = images.length;

    if (endCardPath) {
      filter += `;[${endCardIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p,setpts=PTS-STARTPTS,fade=t=in:st=0:d=${fadeDuration}[vendcard]`;
      filter +=
        ";" +
        images.map((_, i) => `[v${i}]`).join("") +
        `[vendcard]concat=n=${images.length + 1}:v=1:a=0[vconcat];` +
        `[vconcat]trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;
    } else {
      filter +=
        ";" +
        images.map((_, i) => `[v${i}]`).join("") +
        `concat=n=${images.length}:v=1:a=0[vconcat];` +
        `[vconcat]trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;
    }
