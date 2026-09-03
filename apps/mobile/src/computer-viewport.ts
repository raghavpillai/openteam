export interface ComputerPoint {
  x: number;
  y: number;
}

export interface ComputerSize {
  width: number;
  height: number;
}

export interface ComputerTouch {
  locationX: number;
  locationY: number;
  pageX: number;
  pageY: number;
}

export interface ComputerViewport {
  zoom: number;
  offset: ComputerPoint;
}

export interface ComputerViewportGestureStart extends ComputerViewport {
  centroid: ComputerPoint;
  distance: number;
}

export const MIN_COMPUTER_ZOOM = 1;
export const MAX_COMPUTER_ZOOM = 3;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export const computerTouchDistance = (touches: ReadonlyArray<ComputerTouch>): number => {
  const [first, second] = touches;
  if (!first || !second) return 0;
  return Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY);
};

export const computerTouchCentroid = (touches: ReadonlyArray<ComputerTouch>): ComputerPoint => {
  const relevant = touches.slice(0, 2);
  if (relevant.length === 0) return { x: 0, y: 0 };
  return {
    x: relevant.reduce((total, touch) => total + touch.locationX, 0) / relevant.length,
    y: relevant.reduce((total, touch) => total + touch.locationY, 0) / relevant.length,
  };
};

export const clampComputerViewport = (
  viewport: ComputerViewport,
  frame: ComputerSize
): ComputerViewport => {
  const zoom = clamp(viewport.zoom, MIN_COMPUTER_ZOOM, MAX_COMPUTER_ZOOM);
  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);
  const maxX = (width * (zoom - 1)) / 2;
  const maxY = (height * (zoom - 1)) / 2;
  return {
    zoom,
    offset: {
      x: clamp(viewport.offset.x, -maxX, maxX),
      y: clamp(viewport.offset.y, -maxY, maxY),
    },
  };
};

export const updateComputerViewport = (
  start: ComputerViewportGestureStart,
  touches: ReadonlyArray<ComputerTouch>,
  frame: ComputerSize,
  zoomEnabled = true
): ComputerViewport => {
  const centroid = computerTouchCentroid(touches);
  const distance = computerTouchDistance(touches);
  const ratio = zoomEnabled && start.distance > 0 && distance > 0 ? distance / start.distance : 1;
  const zoom = clamp(start.zoom * ratio, MIN_COMPUTER_ZOOM, MAX_COMPUTER_ZOOM);
  const scaleChange = zoom / Math.max(MIN_COMPUTER_ZOOM, start.zoom);
  const center = { x: Math.max(1, frame.width) / 2, y: Math.max(1, frame.height) / 2 };

  // Keep the desktop point below the gesture midpoint stationary while the fingers
  // spread, and add the midpoint's movement so a two-finger drag pans naturally.
  return clampComputerViewport(
    {
      zoom,
      offset: {
        x: centroid.x - center.x - scaleChange * (start.centroid.x - center.x - start.offset.x),
        y: centroid.y - center.y - scaleChange * (start.centroid.y - center.y - start.offset.y),
      },
    },
    frame
  );
};

export const computerPointFromScreen = (
  point: ComputerPoint,
  frame: ComputerSize,
  computer: ComputerSize,
  viewport: ComputerViewport
): ComputerPoint => {
  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);
  const remoteWidth = Math.max(1, computer.width);
  const remoteHeight = Math.max(1, computer.height);
  const zoom = clamp(viewport.zoom, MIN_COMPUTER_ZOOM, MAX_COMPUTER_ZOOM);
  const normalizedX = ((point.x - width / 2 - viewport.offset.x) / zoom + width / 2) / width;
  const normalizedY = ((point.y - height / 2 - viewport.offset.y) / zoom + height / 2) / height;
  return {
    x: clamp(Math.round(normalizedX * remoteWidth), 0, remoteWidth - 1),
    y: clamp(Math.round(normalizedY * remoteHeight), 0, remoteHeight - 1),
  };
};

export const screenPointFromComputer = (
  point: ComputerPoint,
  frame: ComputerSize,
  computer: ComputerSize,
  viewport: ComputerViewport
): ComputerPoint => {
  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);
  const remoteWidth = Math.max(1, computer.width);
  const remoteHeight = Math.max(1, computer.height);
  return {
    x:
      width / 2 + viewport.offset.x + viewport.zoom * ((point.x / remoteWidth) * width - width / 2),
    y:
      height / 2 +
      viewport.offset.y +
      viewport.zoom * ((point.y / remoteHeight) * height - height / 2),
  };
};

export const moveComputerTrackpadPointer = (
  start: ComputerPoint,
  delta: ComputerPoint,
  frame: ComputerSize,
  computer: ComputerSize,
  zoom: number,
  sensitivity = 1.65
): ComputerPoint => {
  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);
  const remoteWidth = Math.max(1, computer.width);
  const remoteHeight = Math.max(1, computer.height);
  const precision = Math.max(MIN_COMPUTER_ZOOM, zoom);
  return {
    x: clamp(
      Math.round(start.x + (delta.x / width) * remoteWidth * (sensitivity / precision)),
      0,
      remoteWidth - 1
    ),
    y: clamp(
      Math.round(start.y + (delta.y / height) * remoteHeight * (sensitivity / precision)),
      0,
      remoteHeight - 1
    ),
  };
};
