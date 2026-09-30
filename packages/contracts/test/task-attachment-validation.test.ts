import { expect, test } from "bun:test";
import { Schema } from "effect";
import { TaskInput } from "../src";

const parse = Schema.decodeUnknownSync(TaskInput);
const task = { description: "Process files", prompt: "Read /workspace/input.zip using Shell" };
test("Task rejects non-media before dispatch, while shared-file prompts remain valid", () => {
  for (const file of ["/workspace/input.zip", "/workspace/report.pdf", "/workspace/a.csv", "/workspace/readme.txt", "/workspace/no-extension"]) {
    expect(() => parse({ ...task, file_attachments: [file] })).toThrow("shared filesystem path");
  }
  expect(parse(task)).toEqual(task);
  expect(parse({ ...task, file_attachments: [] }).file_attachments).toEqual([]);
});
test("Task preserves all runtime image/video types and uppercase filenames", () => {
  for (const suffix of ["gif", "jpeg", "jpg", "png", "webp", "m4v", "mkv", "mov", "mp4", "webm"]) {
    const path = `/workspace/東京 photo.${suffix.toUpperCase()}`;
    expect(parse({ ...task, file_attachments: [path] }).file_attachments).toEqual([path]);
  }
});

test("Task rejects more attachments than the worker can load before dispatch", () => {
  const paths = Array.from({ length: 9 }, (_, i) => `/workspace/image-${i}.png`);
  expect(parse({ ...task, file_attachments: paths.slice(0, 8) }).file_attachments).toHaveLength(8);
  expect(() => parse({ ...task, file_attachments: paths })).toThrow("at most 8");
});
