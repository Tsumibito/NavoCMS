import { createNoopService } from "./app.js";

const token = process.env.NAVOCMS_PLUGIN_TOKEN;
if (!token) throw new Error("NAVOCMS_PLUGIN_TOKEN is required");

const port = Number.parseInt(process.env.NAVOCMS_PLUGIN_PORT ?? "3100", 10);
const host = process.env.NAVOCMS_PLUGIN_HOST ?? "127.0.0.1";
const app = createNoopService({ token, logger: true });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
