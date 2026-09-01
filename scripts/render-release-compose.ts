const [sourcePath, outputPath, digestDirectory] = process.argv.slice(2);
if (!sourcePath || !outputPath || !digestDirectory) {
  throw new Error(
    "Usage: bun scripts/render-release-compose.ts <source> <output> <digest-directory>"
  );
}

const services = ["server", "worker", "migrate", "computer"] as const;
let compose = await Bun.file(sourcePath).text();
for (const service of services) {
  const digest = (await Bun.file(`${digestDirectory}/openbot-${service}.digest`).text()).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Invalid openbot-${service} digest: ${digest || "missing"}`);
  }
  const taggedImage = `\${OPENBOT_IMAGE_PREFIX:?OPENBOT_IMAGE_PREFIX is required}-${service}:\${OPENBOT_VERSION:?OPENBOT_VERSION is required}`;
  const pinnedImage = `\${OPENBOT_IMAGE_PREFIX:?OPENBOT_IMAGE_PREFIX is required}-${service}@${digest}`;
  if (!compose.includes(taggedImage)) {
    throw new Error(`Could not find the ${service} release image in ${sourcePath}`);
  }
  compose = compose.replace(taggedImage, pinnedImage);
}

if (/^\s*image:.*-(?:server|worker|migrate|computer):\$\{OPENBOT_VERSION/m.test(compose)) {
  throw new Error("The rendered release Compose file still contains mutable OpenBot image tags");
}
await Bun.write(outputPath, compose);
