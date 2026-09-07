/*
 * Tuning. Flags are for what changes per-recording (size, duration, output); these are
 * for what defines the house style of the motion. New knobs go here, not into parseArgs.
 */

// --- Motion -----------------------------------------------------------------
// A pan is a slow constant drift with flicks on top of it. A flick moves a set
// distance without exceeding a speed cap, then the page rests for a set pause
// before the next one; everything else -- how long a flick takes, how many there
// are, how long the whole pan runs -- falls out of those. Distances and speeds are in viewports so a phone frame and a desktop
// frame move at the same rate to the eye rather than the same rate in pixels.

// How far one flick carries the page. 0.8 is most of a screen, which is about
// what a reader moves before stopping.
export const FLICK_DISTANCE_IN_VIEWPORTS = 0.8;

// How long the page rests between flicks, once one has landed and before the
// next sets off. Only the drift is running during it. The flick's own duration
// comes from its distance and the speed cap, so this doesn't affect it.
export const FLICK_PAUSE_IN_SECONDS = 0.9;

// Fastest the page is allowed to move, at the midpoint of a flick. This is the
// total on screen, drift included, so it is the speed you actually watch. Lower
// means a longer, gentler flick covering the same ground, since the flick's
// duration is whatever covering its distance within the cap requires.
export const FLICK_MAX_SPEED_IN_VIEWPORTS_PER_SECOND = 1.6;

// The constant creep underneath the flicks, so the page never sits completely
// still mid-pan. 0 gives dead stops between flicks.
export const DRIFT_VIEWPORTS_PER_SECOND = 0.2;

// The one speed --linear runs at, flicks and drift both switched off. Set near the
// flick model's average pace so swapping modes doesn't change how long the pan takes.
export const LINEAR_SPEED_IN_VIEWPORTS_PER_SECOND = 0.4;

// A pan whose speed model somehow never covers the page would step forward forever, so
// the frame count stops here. Ten minutes is far past any real recording.
export const MAX_PAN_SECONDS = 600;

// How long to wait on one virtual-time budget before giving up on it. Under
// pauseIfNetworkFetchesPending a single request that never settles keeps virtual time
// running forever, and the whole recording wedges at zero CPU with no error. Normal
// budgets return in milliseconds, so anything near this is already broken.
export const STALLED_BUDGET_MILLISECONDS = 10000;

// How long to wait for the compositor to answer a screenshot. Measured against a real
// site clipped at scale 2: p50 33ms, p99 65ms, max 77ms over 138 frames, and a static
// page answers just as fast. So this is pure slack for a loaded machine, ~30x the p99,
// and never a cost a healthy frame pays. Being generous is the whole point: every
// millisecond under the true answer time is a frame wrongly called still.
export const STILL_FRAME_MILLISECONDS = 2000;

// How many nudges a frame gets before the page is taken to be drawing nothing at all. A
// nudge frees a frame that was merely late every time it is tried, so a second one buys
// nothing that waiting longer would not.
export const STILL_FRAME_NUDGES = 1;

// How often the frame counter reaches stderr, in wall-clock milliseconds. Counted in real
// time and not in frames: the whole job of that line is to show a slow render moving, and
// a cadence measured in frames goes quiet exactly when the render slows down.
export const PROGRESS_INTERVAL_MILLISECONDS = 5000;

// Virtual milliseconds handed to page load before the first frame. Too short and
// the recording opens on a half-built page; too long only wastes wall time, since
// the animations are held at zero throughout the settle either way.
export const SETTLE_MILLISECONDS = 2000;

// --- Actions ----------------------------------------------------------------
// --hover and --focus are the same shot in five phases: the element sits idle, the
// action engages, it holds, it disengages, and the reaction is given time to finish on
// screen. Hover spends the engage and disengage phases walking the pointer in and out;
// focus lands and leaves instantly and spends them letting its transition play. Same
// numbers either way, which is why these are ACTION_ and not HOVER_.

export const ACTION_LEAD_IN_SECONDS = 0.3;
export const ACTION_ENGAGE_SECONDS = 0.45;
export const ACTION_DWELL_SECONDS = 0.7;
export const ACTION_DISENGAGE_SECONDS = 0.35;
export const ACTION_LEAD_OUT_SECONDS = 0.5;
export const ACTION_SECONDS = ACTION_LEAD_IN_SECONDS + ACTION_ENGAGE_SECONDS + ACTION_DWELL_SECONDS
  + ACTION_DISENGAGE_SECONDS + ACTION_LEAD_OUT_SECONDS;

// How much page to keep around the element: room for an underline to draw outside the
// text box, and for the pointer to be seen arriving rather than appearing on top of it.
export const ACTION_PADDING_PIXELS = 40;

// How far outside the crop the pointer waits before it moves in, in CSS pixels. Clears
// the tallest system cursor (40) so it starts fully out of frame whichever one is up.
export const ACTION_POINTER_CLEARANCE_PIXELS = 48;

// --- Frame ------------------------------------------------------------------
// 414 CSS px is the most common mobile viewport width worldwide, and 414x736 is the
// real visible viewport of the iPhone Plus class -- browser chrome already subtracted,
// so the frame is 9:16 rather than the absurd 1:2.2 a raw screen resolution gives. At
// 3x that is 1242x2208, which is that hardware's actual render resolution.
export const MOBILE_FRAME = { width: 414, height: 736, scale: 3 };
export const DESKTOP_FRAME = { width: 1440, height: 900, scale: 2 };
