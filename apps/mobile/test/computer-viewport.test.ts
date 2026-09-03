import { describe, expect, test } from "bun:test";
import {
  clampComputerViewport,
  computerPointFromScreen,
  moveComputerTrackpadPointer,
  screenPointFromComputer,
  updateComputerViewport,
} from "../src/computer-viewport";

const frame = { width: 400, height: 250 };
const computer = { width: 1280, height: 800 };
const touch = (locationX: number, locationY: number) => ({
  locationX,
  locationY,
  pageX: locationX + 20,
  pageY: locationY + 80,
});

describe("mobile computer viewport", () => {
  test("pinches around the two-finger midpoint instead of jumping to the center", () => {
    const viewport = updateComputerViewport(
      {
        zoom: 1,
        offset: { x: 0, y: 0 },
        centroid: { x: 100, y: 100 },
        distance: 50,
      },
      [touch(50, 100), touch(150, 100)],
      frame
    );

    expect(viewport).toEqual({ zoom: 2, offset: { x: 100, y: 25 } });
    expect(computerPointFromScreen({ x: 100, y: 100 }, frame, computer, viewport)).toEqual({
      x: 320,
      y: 320,
    });
  });

  test("moves a zoomed desktop with a two-finger drag and clamps its edges", () => {
    const viewport = updateComputerViewport(
      {
        zoom: 2,
        offset: { x: 0, y: 0 },
        centroid: { x: 200, y: 125 },
        distance: 100,
      },
      [touch(200, 220), touch(320, 220)],
      frame,
      false
    );

    expect(viewport).toEqual({ zoom: 2, offset: { x: 60, y: 95 } });
    expect(clampComputerViewport({ zoom: 3, offset: { x: 900, y: -900 } }, frame)).toEqual({
      zoom: 3,
      offset: { x: 400, y: -250 },
    });
    expect(clampComputerViewport({ zoom: 1, offset: { x: 20, y: 20 } }, frame)).toEqual({
      zoom: 1,
      offset: { x: 0, y: 0 },
    });
  });

  test("keeps tap coordinates aligned after zoom and pan", () => {
    const viewport = { zoom: 2.5, offset: { x: -75, y: 40 } };
    const remote = { x: 900, y: 225 };
    const local = screenPointFromComputer(remote, frame, computer, viewport);
    const roundTrip = computerPointFromScreen(local, frame, computer, viewport);

    expect(roundTrip).toEqual(remote);
  });

  test("trackpad motion stays bounded and gets more precise while zoomed", () => {
    expect(
      moveComputerTrackpadPointer({ x: 640, y: 400 }, { x: 40, y: 25 }, frame, computer, 1)
    ).toEqual({ x: 851, y: 532 });
    expect(
      moveComputerTrackpadPointer({ x: 640, y: 400 }, { x: 40, y: 25 }, frame, computer, 2)
    ).toEqual({ x: 746, y: 466 });
    expect(
      moveComputerTrackpadPointer({ x: 1270, y: 790 }, { x: 400, y: 250 }, frame, computer, 1)
    ).toEqual({ x: 1279, y: 799 });
  });
});
