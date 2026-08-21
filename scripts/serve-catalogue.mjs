import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

const host = "127.0.0.1";
const port = 4321;
const root = path.resolve(process.cwd(), "apps/design-catalogue/dist");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"]
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const candidate = path.resolve(root, relative);
    if (!candidate.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, { "content-type": contentTypes.get(path.extname(candidate)) ?? "application/octet-stream" });
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(port, host);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
