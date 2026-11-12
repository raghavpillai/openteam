import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutineDefinitionError } from "../src/renderer/components/openteam/routine-definition-error";

test("invalid routine definitions show an actionable paused state as escaped text", () => {
  const markup = renderToStaticMarkup(
    <RoutineDefinitionError error={'Invalid schedule: <img src=x onerror="run()">'} />
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("This routine is paused because its definition is invalid.");
  expect(markup).toContain("&lt;img");
  expect(markup).not.toContain("<img");
  expect(renderToStaticMarkup(<RoutineDefinitionError error={null} />)).toBe("");
});
