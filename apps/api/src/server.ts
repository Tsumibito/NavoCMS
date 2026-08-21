import { createApi } from "./app.js";

const port = Number.parseInt(process.env.NAVOCMS_PORT ?? "3000", 10);
const host = process.env.NAVOCMS_HOST ?? "127.0.0.1";
const app = createApi({ logger: true });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
