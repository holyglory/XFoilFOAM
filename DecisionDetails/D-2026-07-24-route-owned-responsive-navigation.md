# D-2026-07-24-route-owned-responsive-navigation

## Decision

Public and admin surfaces own different navigation:

- Public desktop: the existing Browse, Search, Detail, and Compare tabs.
- Public narrow screen (below 860 px): one accessible burger menu containing
  the same four destinations.
- Admin desktop: an admin-labelled top bar with no public tabs plus the
  existing six-section sidebar.
- Admin narrow screen (below 940 px): one accessible burger menu containing
  Simulations, Solver, Health, Setup library, Catalog, and Sync API.

Menus expose `aria-expanded`/`aria-controls`, close after navigation, close on
Escape and outside click, retain existing URL-owned admin routing, and must not
create document- or navigation-shell horizontal overflow.

## Why

The reported 653 px production view showed both the public top navigation and
the admin section navigation as horizontal scroll strips. This duplicated the
page hierarchy, made the current surface unclear, and required discovering
hidden destinations by horizontal scrolling.

Materially distinct options considered:

- Keep both rows and hide their scrollbars: rejected because destinations
  would remain clipped and the public/admin hierarchy would still be
  duplicated.
- Wrap tabs onto multiple rows: rejected because it consumes the first
  viewport and still leaves two competing navigation systems on admin pages.
- Keep internal horizontal scrolling: rejected by the user and because it
  makes primary destinations less discoverable.
- Route-owned burger menus: selected because every destination remains
  reachable, the current surface becomes explicit, desktop behavior is
  preserved, and narrow layouts no longer depend on horizontal scrolling.

## Verification contract

- At 653 × 921, the public top bar displays one public burger, all four
  destinations are reachable, Escape closes it, and neither the document nor
  top bar overflows horizontally.
- At 653 × 921, `/admin` contains no public navigation, displays one admin
  burger with all six destinations, updates the URL through the existing
  shallow routing contract, and has no document/navigation-shell overflow.
- At desktop width, `/admin` keeps the sidebar, hides the mobile trigger, and
  still omits public tabs.
