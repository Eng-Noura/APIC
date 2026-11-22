# 1D nest <-> Part List

The Part List now follows **both** nests of a project, the 2D (plates) and the 1D (profiles / pipes).

## Automatic import

Opening the Part List (coming back to the browser tab, or a nest being saved from another tab — checked every 20 s by
version only) takes every part of the 2D nest and every **piece** of the 1D nest that is not in the list yet.

* 1D pieces become *Hot rolled* (profile) or *Pipe* parts of the drawing **NESTING-1D**.
* Each part keeps the piece id (`nestKind = "1D"`, `nestPartId`), so a piece is never added twice and its quantity is synced.
* Pieces that came **from** the Part List are never taken back. New pieces carry the part id (`Piece1D.partId`); pieces saved
  before that are recognised by their name (`<drawing> #<item> <description>`), which is the name the 1D tool gave them.
* A part sent from the Part List to the 1D tool is not sent back to the same nest if it came from that nest.

Left out (a warning says why, once per distinct reason):

| Piece | Why |
|---|---|
| Profile not in the weight table (`profile-weight.ts`: FB, UPN, IPE) | Part List needs kg/m and nothing is invented. Type it in *Take parts from 1D Nesting*. |
| Pipe whose profile is not `PIPE OD<od>x<wall>` | OD and wall cannot be read. Type them in *Take parts from 1D Nesting*. |
| Piece with no cut length yet / no profile | Nothing to make a part from. |
| Plate pieces | Plates are taken from the 2D nest. |

## Take parts from 1D Nesting (button)

Same idea as the 2D button: pick pieces of this project's 1D nest (or a history entry), choose the drawing, and type the
weight per metre (profiles not in the table) or OD × wall (unreadable pipes) where needed. Parts from the project's own nest
are linked; parts from a history entry are not.

## Quantity sync

`nest-sync.service.ts` runs the same rules (`calc/nest-sync.ts`) for `nestKind = "2D"` and `"1D"`:

* nest changed -> the BOQ part follows (weight recomputed);
* BOQ changed -> written into `pieces[].qty` of the 1D workspace (version-checked); the saved cutting result is dropped, as the
  1D tool does whenever a piece changes, and the tool reloads the nest;
* both changed -> conflict, listed by *Sync with nest*; piece removed -> orphan (the part is never deleted).

## Things to know

* A part deleted from the Part List comes back while its piece is still in the nest (same as 2D) — the delete dialog says so.
  Remove the piece from the nest to get rid of it.
* No database migration: `nestKind` is a plain string.
* API: `POST /api/takeoff/nest-1d-import` — `{ projectId }` (automatic) or `{ projectId, drawingId, items }` (picked pieces).
