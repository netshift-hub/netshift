# NETSHIFT login startup repair (E1 + E2 cumulative source)

## Root cause
`refreshDesktopIcons()` runs during initial client startup and calls the canonical inventory helpers before `NETSHIFT_CORE_FILES` and related `NETSHIFT_CORE_*` mirrors were initialized. The resulting temporal-dead-zone `ReferenceError` aborts the inline script before login/register submit listeners are attached. The browser then performs a native GET form submission, putting the named form fields into the URL.

## Repair
- Move the four canonical inventory mirror declarations above the initial desktop render.
- Add `scripts/check-auth-startup-guard.js` and wire it into `npm run check` to guard this declaration order and form fallback behaviour.
- Add `method="post" action="/" onsubmit="return false"` to login and registration forms so an early script failure cannot send credentials in a GET URL. With JavaScript operating normally, the existing submit listeners still perform the authentication fetch.

## Validation run
`npm run check` PASSED locally, including client syntax, the new startup guard, Stage 1 checks, the E1 ledger check, and the E2 transfer check. This is not a browser or live PostgreSQL integration result. The repaired candidate has not been pushed to GitHub or deployed to Render.
