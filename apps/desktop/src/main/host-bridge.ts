import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, resolve } from "node:path";
import { type BrowserWindow, dialog } from "electron";
import { listenForHostBridge } from "./host-bridge-listener";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_BYTES = 100_000;

interface ShellRequest {
  command?: unknown;
  working_directory?: unknown;
  block_until_ms?: unknown;
}

interface ReadRequest {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
}

const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

const authorized = (request: IncomingMessage, token: string): boolean => {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

const body = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const imageMime = (path: string): string | null => {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
};

const approve = async (
  getWindow: () => BrowserWindow | null,
  title: string,
  message: string,
  detail: string
): Promise<boolean> => {
  const window = getWindow();
  const options = {
    type: "warning" as const,
    title,
    message,
    detail,
    buttons: ["Deny", "Allow"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
};

const pdfText = (path: string): Promise<string> =>
  new Promise((resolveText, reject) => {
    const child = spawn("pdftotext", [path, "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveText(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8") || "PDF conversion failed"));
    });
  });

const executeRead = async (input: ReadRequest) => {
  if (typeof input.path !== "string" || !isAbsolute(input.path)) {
    throw new Error("ExternalRead requires an absolute path");
  }
  const path = resolve(input.path);
  await access(path);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("ExternalRead path is not a file");
  if (metadata.size > MAX_READ_BYTES) throw new Error("ExternalRead file exceeds 10 MiB");
  const mimeType = imageMime(path);
  if (mimeType) {
    return {
      kind: "image" as const,
      path,
      mimeType,
      data: (await readFile(path)).toString("base64"),
    };
  }
  const raw =
    extname(path).toLowerCase() === ".pdf" ? await pdfText(path) : await readFile(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const offset =
    typeof input.offset === "number" && Number.isInteger(input.offset) ? input.offset : undefined;
  const limit =
    typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
      ? input.limit
      : undefined;
  const start =
    offset === undefined
      ? 0
      : offset < 0
        ? Math.max(0, lines.length + offset)
        : Math.max(0, offset - 1);
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
  const text = lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n");
  return {
    kind: "text" as const,
    path,
    text:
      text.length <= MAX_INLINE_BYTES ? text : `${text.slice(0, MAX_INLINE_BYTES)}\n… truncated`,
    lines: end - start,
  };
};

const executeShell = async (input: ShellRequest, terminalDir: string) => {
  if (typeof input.command !== "string") throw new Error("ExternalShell command is required");
  const workingDirectory =
    input.working_directory === undefined
      ? process.cwd()
      : typeof input.working_directory === "string" && isAbsolute(input.working_directory)
        ? resolve(input.working_directory)
        : (() => {
            throw new Error("ExternalShell working_directory must be absolute");
          })();
  const directory = await stat(workingDirectory);
  if (!directory.isDirectory())
    throw new Error("ExternalShell working_directory is not a directory");
  await mkdir(terminalDir, { recursive: true });
  const shellId = crypto.randomUUID();
  const outputPath = resolve(terminalDir, `${shellId}.log`);
  const outputFile = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const startedAt = Date.now();
  outputFile.write(
    `command: ${input.command}\nworking_directory: ${workingDirectory}\nstarted_at: ${new Date(startedAt).toISOString()}\n\n`
  );
  const child = spawn(input.command, {
    cwd: workingDirectory,
    env: process.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let size = 0;
  const collect = (chunk: Buffer) => {
    outputFile.write(chunk);
    if (size < MAX_INLINE_BYTES) {
      const remaining = MAX_INLINE_BYTES - size;
      chunks.push(chunk.subarray(0, remaining));
      size += Math.min(remaining, chunk.length);
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const completion = new Promise<number | null>((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      outputFile.end(
        `\n\nstatus: completed\nexit_code: ${code ?? "null"}\nelapsed_ms: ${Date.now() - startedAt}\n`
      );
      resolveCompletion(code);
    });
  });
  const requested = typeof input.block_until_ms === "number" ? input.block_until_ms : 30_000;
  const blockMs = Math.max(0, Math.min(7_140_000, requested));
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    completion.then((exitCode) => ({ done: true as const, exitCode })),
    new Promise<{ done: false }>(
      (resolveTimeout) => (timeoutId = setTimeout(() => resolveTimeout({ done: false }), blockMs))
    ),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  if (!completed.done) void completion.catch(() => undefined);
  return {
    shell_id: shellId,
    status: completed.done ? ("completed" as const) : ("running" as const),
    exit_code: completed.done ? completed.exitCode : null,
    output: Buffer.concat(chunks).toString("utf8"),
    output_path: outputPath,
    elapsed_ms: Date.now() - startedAt,
  };
};

export const startHostBridge = (options: {
  token: string;
  port: number;
  terminalDir: string;
  getWindow: () => BrowserWindow | null;
}): Promise<Server> => {
  const server = createServer(async (request, response) => {
    if (request.url === "/health" && request.method === "GET") {
      return json(response, 200, { status: "ready" });
    }
    if (!authorized(request, options.token)) return json(response, 401, { error: "unauthorized" });
    try {
      if (request.method === "POST" && request.url === "/v1/read") {
        const input = (await body(request)) as ReadRequest;
        if (typeof input.path !== "string") throw new Error("ExternalRead path is required");
        const allowed = await approve(
          options.getWindow,
          "OpenBot host file access",
          "Allow this bot to read a file on this computer?",
          input.path
        );
        if (!allowed) return json(response, 403, { error: "The user denied host file access" });
        return json(response, 200, await executeRead(input));
      }
      if (request.method === "POST" && request.url === "/v1/shell") {
        const input = (await body(request)) as ShellRequest;
        if (typeof input.command !== "string") throw new Error("ExternalShell command is required");
        const allowed = await approve(
          options.getWindow,
          "OpenBot host command",
          "Allow this bot to run a command on this computer?",
          `${input.command}\n\nWorking directory: ${String(input.working_directory ?? process.cwd())}`
        );
        if (!allowed) return json(response, 403, { error: "The user denied the host command" });
        return json(response, 200, await executeShell(input, options.terminalDir));
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return listenForHostBridge(server, options.port);
};
