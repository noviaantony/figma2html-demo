// routes/wireframeRoute.js
import express from "express";
import { convertFigmaToHtml } from "../controllers/wireframeController.js";

const router = express.Router();

// POST /wireframe
router.post("/", convertFigmaToHtml);

export default router;
