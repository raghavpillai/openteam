import packageJson from "../package.json";

export const CLI_VERSION = packageJson.version;
export const DEFAULT_REPOSITORY = "raghavpillai/openbot";
export const DEFAULT_IMAGE_PREFIX = "ghcr.io/raghavpillai/openbot";
export const COMPOSE_FILENAME = "compose.yaml";
export const ENV_FILENAME = ".env";
export const INSTALLATION_FILENAME = "installation.json";
export const PROJECT_NAME = "openbot";
export const API_PORT = 8787;
export const VIEWER_PORT_START = 6200;
export const VIEWER_PORT_END = 6299;
export const MINIMUM_RECOMMENDED_MEMORY_BYTES = 8 * 1024 ** 3;
export const MINIMUM_RECOMMENDED_DISK_BYTES = 8 * 1024 ** 3;
