import { copyFile, mkdir } from "node:fs/promises";
const target = new URL("../frontend/public/api-docs/", import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ["swagger-ui-bundle.js", "swagger-ui.css"]) {
  await copyFile(
    new URL(`../node_modules/swagger-ui-dist/${name}`, import.meta.url),
    new URL(name, target),
  );
}
