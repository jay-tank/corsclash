// Does NOT trip corsclash: a real, specific allowlisted origin paired
// with credentials: true. This is exactly what the CORS spec's
// wildcard restriction is meant to push developers toward — the
// browser can safely trust a single named origin the way it can never
// trust '*' for a credentialed request.
import express from "express";
import cors from "cors";

const app = express();

const allowedOrigins = ["https://app.example.com", "https://admin.example.com"];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

export default app;
