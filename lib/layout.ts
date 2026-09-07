/* Where things are: the crop an action is recorded through, and the pointer's path
 * across it. Pure. */

import { ACTION_PADDING_PIXELS, ACTION_POINTER_CLEARANCE_PIXELS } from './constants.ts';
import { engagementAt } from './motion.ts';
import type { Clip, Point, PointerPath, TargetBox } from './types.ts';

// One measurement, before any frames. The action itself changes layout -- an underline
// appears, a focus ring grows the box -- and a crop that moved with it would hand ffmpeg
// frames of different sizes, which libx264 will not take.
export function computeCrop(
  { target, width, height }: { target: TargetBox; width: number; height: number },
): PointerPath & { clip: Clip } {
  // Rounded before anything else: CDP floors the CSS rect before scaling it, so a
  // fractional edge quietly changes the size of every frame.
  const cropLeft = Math.max(Math.round(target.left) - ACTION_PADDING_PIXELS, 0);
  const cropTop = Math.max(Math.round(target.top) - ACTION_PADDING_PIXELS, 0);
  const cropRight = Math.min(Math.round(target.right) + ACTION_PADDING_PIXELS, width);
  const cropBottom = Math.min(Math.round(target.bottom) + ACTION_PADDING_PIXELS, height);

  const clip = {
    x: cropLeft + target.scrollX,
    y: cropTop + target.scrollY,
    width: cropRight - cropLeft,
    height: cropBottom - cropTop,
    // clip.scale multiplies on top of the device metrics override, which is already
    // applying --scale. Anything but 1 here applies it twice.
    scale: 1,
  };

  const pointerOnTarget = {
    x: (cropLeft + cropRight) / 2,
    y: (cropTop + cropBottom) / 2,
  };
  // The pointer waits outside the crop so it is seen arriving. Below by default, like a
  // hand coming up the page; above when the crop already reaches the bottom of the
  // viewport, since Chrome clamps mouse coordinates into the viewport and a start point
  // off-screen would read as a hover that never left.
  const roomBelowCrop = height - cropBottom > ACTION_POINTER_CLEARANCE_PIXELS;
  const restingY = roomBelowCrop
    ? cropBottom + ACTION_POINTER_CLEARANCE_PIXELS
    : cropTop - ACTION_POINTER_CLEARANCE_PIXELS;
  const pointerHome = {
    x: Math.min(Math.max(pointerOnTarget.x - ACTION_POINTER_CLEARANCE_PIXELS, 0), width - 1),
    y: Math.min(Math.max(restingY, 0), height - 1),
  };

  return { clip, pointerHome, pointerOnTarget };
}

// Where the pointer is, in viewport pixels: resting off the crop, easing onto the
// element, holding, easing back off.
export function pointerPositionAt(
  seconds: number,
  { pointerHome, pointerOnTarget }: PointerPath,
): Point {
  const engaged = engagementAt(seconds);
  return {
    x: pointerHome.x + (pointerOnTarget.x - pointerHome.x) * engaged,
    y: pointerHome.y + (pointerOnTarget.y - pointerHome.y) * engaged,
  };
}
