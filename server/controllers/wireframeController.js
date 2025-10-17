// controllers/wireframeController.js
import fs from "fs";
import { fetchFigmaFile, extractHtmlAndCss } from "../utilities/figma/figmaExporter.js";



export const convertFigmaToHtml = async (req, res) => {
  try {
    // const { fileKey } = req.body;
    const fileKey = process.env.FIGMA_FILE_KEY;

    if (!fileKey) {
      return res.status(400).json({ error: "Missing required parameter: fileKey" });
    }

    const data = await fetchFigmaFile(fileKey);
    console.log("Building HTML/CSS…");

    const { html, css } = await extractHtmlAndCss(data);

    const OUTPUT_DIR = "./out";
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    fs.writeFileSync(`${OUTPUT_DIR}/index.html`, html);
    fs.writeFileSync(`${OUTPUT_DIR}/styles.css`, css);

    console.log("Export complete!");
    res.json({ html, css, message: "Figma export successful!" });
  } catch (err) {
    console.error("Error during conversion:", err);
    res.status(500).json({ error: err.message || "Something went wrong" });
  }
};
