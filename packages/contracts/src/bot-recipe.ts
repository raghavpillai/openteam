export interface BotRecipe {
  profile: { name: string; description: string; avatarColor?: string; avatarShape?: string };
  memory: Array<{ kind?: "profile" | "log"; createdAt?: string; content: string }>;
  skills: Array<{ name: string; description?: string; content: string }>;
  routines: Array<{ slug: string; name?: string; description: string; content: string }>;
  plugins: Array<{ pluginId: string; name?: string; description?: string }>;
  gettingStarted?: { skill: string };
  visibility: "public" | "team";
}
export function parseBotRecipe(raw: unknown): BotRecipe {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || JSON.stringify(raw).length > 200_000)
    throw new Error("A recipe of at most 200000 characters is required");
  const obj = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid recipe item");
    return raw as Record<string, unknown>;
  };
  const str = (raw: unknown, maximum: number, required = true): string | undefined => {
    if (raw === undefined && !required) return undefined;
    if (typeof raw !== "string" || !raw.trim() || raw.length > maximum)
      throw new Error("Invalid recipe text");
    return raw.trim();
  };
  const input = obj(raw),
    profile = obj(input.profile);
  const list = (key: string) => {
    if (!Array.isArray(input[key]) || input[key].length > 100)
      throw new Error(`Invalid recipe ${key}`);
    return input[key].map(obj);
  };
  const recipe: BotRecipe = {
    profile: {
      name: str(profile.name, 120)!,
      description: str(profile.description, 2000)!,
      avatarColor: str(profile.avatarColor, 32, false),
      avatarShape: str(profile.avatarShape, 32, false),
    },
    memory: list("memory")
      .filter(
        (item) =>
          typeof item.content === "string" && !/^\[(?:note|episode)\]/i.test(item.content.trim())
      )
      .map((item) => {
        if (item.kind !== undefined && !["profile", "log"].includes(String(item.kind)))
          throw new Error("Only profile and log memories can be shared");
        return {
          content: str(item.content, 4000)!,
          kind: item.kind as "profile" | "log" | undefined,
          createdAt: str(item.createdAt, 40, false),
        };
      }),
    skills: list("skills")
      .filter(
        (item) =>
          typeof item.content === "string" &&
          item.content.trim() &&
          !/^---/.test(item.content.trim())
      )
      .map((item) => ({
        name: str(item.name, 80)!,
        description: str(item.description, 1000, false),
        content: str(item.content, 32000)!,
      })),
    routines: list("routines")
      .filter(
        (item) =>
          typeof item.content === "string" &&
          item.content.trim() &&
          !/^[{[]/.test(item.content.trim())
      )
      .map((item) => ({
        slug: str(item.slug, 120)!,
        name: str(item.name, 120, false),
        description: str(item.description, 1000)!,
        content: str(item.content, 32000)!,
      })),
    plugins: list("plugins").map((item) => ({ pluginId: str(item.pluginId, 200)! })),
    visibility: input.visibility === "public" ? "public" : "team",
  };
  if (input.visibility !== undefined && !["team", "public"].includes(String(input.visibility)))
    throw new Error("Choose team or public visibility");
  if (input.gettingStarted !== undefined) {
    const skill = str(obj(input.gettingStarted).skill, 120)!;
    if (!recipe.skills.some((item) => item.name === skill))
      throw new Error("gettingStarted must name an included skill");
    recipe.gettingStarted = { skill };
  }
  return recipe;
}
