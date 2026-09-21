import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Called while this profile's browser is stopped, before its permissions are applied. */
export async function prepareDownloadPreferences(
  profileDirectory: string,
  home: string
): Promise<void> {
  const directory = join(profileDirectory, "Default");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "Preferences");
  const contents = await readFile(path, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
    throw error;
  });
  const preferences = JSON.parse(contents);
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences))
    throw new Error("Invalid browser preferences");
  preferences.download = {
    ...preferences.download,
    default_directory: join(home, "Downloads"),
    prompt_for_download: false,
  };
  await writeFile(path, JSON.stringify(preferences), { mode: 0o660 });
}
