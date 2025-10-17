// server.js
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import express from "express";
import dotenv from "dotenv";
import wireframeRouter from "./routes/wireframeRoute.js";

dotenv.config();

const app = express();
app.use(express.json());

// Basic health check
app.get("/", (req, res) => res.send("Figma2HTML API is running!"));

// Register routes
app.use("/wireframe", wireframeRouter);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
