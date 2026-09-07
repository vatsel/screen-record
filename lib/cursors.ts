/* macOS's own cursors, read out of AppKit rather than drawn. */

import { execFileSync } from 'node:child_process';
import type { SystemCursor } from './types.ts';

// macOS keeps its cursors in AppKit, so this asks AppKit for them rather than drawing
// lookalikes: a hand-drawn arrow reads as fake however carefully it is traced, and a
// traced set is a set someone has to keep matching against the real one. Rasterized at
// the recording's own pixel ratio so it stays sharp at --scale 4.
//
// Run through swift on stdin rather than a file: this is a snippet of another language
// belonging to one function, not a program of its own. The scale rides in on the
// environment since a script read from stdin has nowhere to take an argument.
export const CURSOR_DUMPER_SWIFT = String.raw`
import AppKit

// A process that is not a GUI app gets empty images back for the cursors the window
// server owns -- the plain arrow among them -- until AppKit has been brought up.
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let scale = Int(ProcessInfo.processInfo.environment["RECORD_CURSOR_SCALE"] ?? "2") ?? 2

// The CSS keywords a page actually asks for, each paired with the cursor macOS shows
// for it. Anything not here falls back to the arrow, which is what the page would get
// from a system that has no special cursor for it either.
let cursors: [(String, NSCursor)] = [
  ("default", .arrow), ("pointer", .pointingHand), ("text", .iBeam),
  ("vertical-text", .iBeamCursorForVerticalLayout), ("crosshair", .crosshair),
  ("not-allowed", .operationNotAllowed), ("no-drop", .operationNotAllowed),
  ("grab", .openHand), ("grabbing", .closedHand), ("move", .closedHand),
  ("copy", .dragCopy), ("alias", .dragLink), ("context-menu", .contextualMenu),
  ("col-resize", .resizeLeftRight), ("ew-resize", .resizeLeftRight),
  ("row-resize", .resizeUpDown), ("ns-resize", .resizeUpDown),
]

var dumped: [String] = []
for (name, cursor) in cursors {
  let image = cursor.image
  let size = image.size
  guard size.width > 0, size.height > 0 else { continue }
  guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
    pixelsWide: Int(size.width) * scale, pixelsHigh: Int(size.height) * scale,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
  // The rep is sized in points while its backing store is in pixels, which is what
  // draws the vector artwork at scale rather than blowing up a small bitmap.
  rep.size = size
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  image.draw(in: NSRect(origin: .zero, size: size))
  NSGraphicsContext.restoreGraphicsState()
  guard let png = rep.representation(using: .png, properties: [:]) else { continue }
  dumped.append("{\"name\":\"" + name + "\",\"width\":\(size.width),\"height\":\(size.height)"
    + ",\"hotspotX\":\(cursor.hotSpot.x),\"hotspotY\":\(cursor.hotSpot.y)"
    + ",\"png\":\"data:image/png;base64," + png.base64EncodedString() + "\"}")
}
print("[" + dumped.joined(separator: ",") + "]")
`;

// Throws rather than exiting, so the caller owns the message and a test can watch it
// fail.
export function systemCursors(pixelRatio: number): Record<string, SystemCursor> {
  let dumped: string;
  try {
    dumped = execFileSync('swift', ['-'], {
      input: CURSOR_DUMPER_SWIFT,
      env: { ...process.env, RECORD_CURSOR_SCALE: String(pixelRatio) },
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (cause) {
    throw new Error(
      '--hover draws the pointer with macOS\'s own cursors, which it reads through swift\n'
      + `and AppKit; swift could not be run here: ${(cause as Error).message}`,
      { cause },
    );
  }

  const cursors: Record<string, SystemCursor> = {};
  for (const cursor of JSON.parse(dumped) as (SystemCursor & { name: string })[]) {
    cursors[cursor.name] = cursor;
  }
  return cursors;
}
