// Revenue split for user-uploaded clips: creator keeps 2/3, admin keeps 1/3.
// This is the ONLY place these numbers should be defined - every earnings
// display (stat cards, table headers, chart legend) must import from here
// and compute its own percentage label, rather than hardcoding a fraction
// or a "(NN%)" string, so the two can never drift apart again.
export const USER_SHARE = 0.667;
export const ADMIN_SHARE = 0.333;
