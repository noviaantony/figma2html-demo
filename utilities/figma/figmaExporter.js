export async function fetchFigmaFile(fileKey) {
  console.log("Fetching Figma file JSON…");
  return fetchJson(`https://api.figma.com/v1/files/${fileKey}`);
}

// --- Core export ---
export async function extractHtmlAndCss(figma) {
  const pages = figma.document?.children || [];
  
  // Collect all unique fonts used in the document
  const fontsUsed = new Set();
  collectFonts(figma.document, fontsUsed);
  
  // Generate Google Fonts link for all fonts
  const fontFamilies = Array.from(fontsUsed).map(f => {
    const family = f.split(':')[0];
    return `family=${encodeURIComponent(family)}:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900`;
  }).join('&');
  
  const googleFontsUrl = fontsUsed.size > 0 
    ? `https://fonts.googleapis.com/css2?${fontFamilies}&display=swap`
    : 'https://fonts.googleapis.com/css2?family=Inter:wght@100;200;300;400;500;600;700;800;900&display=swap';

  let html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Figma Export</title>
  <link href="${googleFontsUrl}" rel="stylesheet">
  <link rel="stylesheet" href="styles.css"/>
</head>
<body>
<div class="page">
`;

  let css = `
:root { --page-gap: ${PAGE_MARGIN}px; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Inter, Arial, sans-serif; background: #fafafa; color: #111; }
.page { display: flex; flex-direction: column; gap: var(--page-gap); padding: var(--page-gap); }
.frame-container {
  margin: 0 auto;
}
.frame {
  position: relative;
  overflow: hidden;
  border: 1px solid #e6e6e6;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.frame-title { 
  font: 600 14px/1 Inter, system-ui, sans-serif; 
  color: #666; 
  padding: 10px 12px; 
  background: #f9f9f9;
  border-bottom: 1px solid #e6e6e6;
}
.frame-inner { position: relative; }
.text { white-space: pre-wrap; word-wrap: break-word; }
.node { position: absolute; }
`;

  for (const page of pages) {
    const frames = (page.children || []).filter(
      n => n.type === "FRAME" || n.type === "COMPONENT" || n.type === "COMPONENT_SET"
    );
    if (!frames.length) continue;

    html += `<h2 class="page-title" style="font:600 18px/1.2 Inter,system-ui,sans-serif;margin:24px 0 16px 0;color:#333;">${escapeHtml(page.name)}</h2>\n`;

    // Pre-fetch all images for this page
    const imageNodeIds = frames.flatMap(frame => collectImageNodes(frame));
    if (imageNodeIds.length > 0) {
      await fetchImages(imageNodeIds);
    }

    for (const frame of frames) {
      const fbb = frame.absoluteBoundingBox || {};
      const frameW = fbb.width || 1200;
      const frameH = fbb.height || 800;

      const scale = frameW ? TARGET_FRAME_WIDTH / frameW : 1;
      const outW = Math.round(frameW * scale);
      const outH = Math.round(frameH * scale);

      // Frame background
      let frameBg = getBackground(frame, scale);

      const frameClass = `frame-${sanitize(frame.id)}`;
      css += `.${frameClass} { width:${outW}px; height:${outH}px; ${frameBg} }\n`;

      html += `<div class="frame-container">
  <div class="frame-title">${escapeHtml(frame.name)} — ${outW}×${outH}px (${Number((scale * 100).toFixed(1))}%)</div>
  <section class="frame ${frameClass}">
    <div class="frame-inner">
`;

      // Process all children recursively
      const result = await processChildren(frame, frame, scale, 0);
      html += result.html;
      css += result.css;

      html += `    </div>
  </section>
</div>\n`;
    }
  }

  html += `</div>\n</body>\n</html>`;
  return { html, css };
}