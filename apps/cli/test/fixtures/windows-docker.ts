/** Only the three preflight commands. Never pretends to start real services. */
const args = process.argv.slice(2).join(" ");
const mode = process.env.NATIVE_DOCKER_MODE;
if (args === "--version") console.log("Docker version 29.0.0, build fixture");
else if (args === "info --format {{.ServerVersion}}") {
  if (mode === "stopped") {
    console.error("Cannot connect to the Docker daemon. Is the docker daemon running?");
    process.exit(1);
  }
  console.log("29.0.0");
} else if (args === "compose version") {
  if (mode === "no-compose") {
    console.error("docker: 'compose' is not a docker command.");
    process.exit(1);
  }
  console.log(`Docker Compose version v${mode === "old-compose" ? "2.19.0" : "2.39.0"}`);
} else {
  console.error(`Unexpected Docker operation in preflight fixture: ${args}`);
  process.exit(99);
}
