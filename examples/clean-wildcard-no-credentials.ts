// Does NOT trip corsclash: wildcard origin with no credentials at all —
// a fully public, unauthenticated API (no cookies, no
// Authorization-header-based session) that anyone can call from
// anywhere. This is a legitimate, common, and safe configuration; the
// gap only exists once `credentials: true` enters the picture.
import express from "express";
import cors from "cors";

const app = express();

app.use(
  cors({
    origin: "*",
  })
);

export default app;
