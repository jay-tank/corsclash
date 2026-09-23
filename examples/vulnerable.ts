// Trips corsclash: wildcard origin combined with credentials: true. Per
// the Fetch/CORS spec, a browser MUST reject a credentialed response
// whose Access-Control-Allow-Origin is '*' — every non-credentialed
// request "works," but any request with cookies/Authorization headers
// and `credentials: 'include'` on the client silently fails in the
// browser console with a confusing CORS error, not a server-side one.
import express from "express";
import cors from "cors";

const app = express();

app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

export default app;
