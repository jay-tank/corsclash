// Trips corsclash — and arguably worse than the plain wildcard case in
// examples/vulnerable.ts. This "fix" is a common reach when someone
// hits the wildcard+credentials browser error above and just wants it
// to go away: reflect whatever Origin header the request sent back as
// the allowed origin. It "works" for every single origin, which means
// it never breaks loudly — it just silently defeats CORS entirely,
// letting any website read credentialed responses from this API.
import express from "express";
import cors from "cors";

const app = express();

app.use(
  cors({
    origin: (origin, callback) => callback(null, true),
    credentials: true,
  })
);

export default app;
