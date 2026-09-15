import { expect, test } from "bun:test";
import { decodeDynamicArguments } from "../src/dynamic-tool-gateway";

test("repairs only a unique structural interpretation of malformed arguments", () => {
  expect(decodeDynamicArguments('{"path":"file}name"}}')).toEqual({path:"file}name"});
  expect(decodeDynamicArguments('{"q":"hello"}<parameter name="description">Find the page</parameter>')).toEqual({q:"hello"});
  expect(() => decodeDynamicArguments('{"q":"hello"}<parameter name="target">another account</parameter>')).toThrow();
  expect(() => decodeDynamicArguments('{"q":')).toThrow();
  expect(() => decodeDynamicArguments('[1,2]')).toThrow();
  expect(() => decodeDynamicArguments(null)).toThrow();
  expect(decodeDynamicArguments({a:[1,2]})).toEqual({a:[1,2]});
});
