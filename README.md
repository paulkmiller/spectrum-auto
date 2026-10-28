# Spectrum Auto Wiring & Sound — website

Brochure site for a single-member car audio shop in Papillion, NE. Plain static HTML, CSS
and vanilla JavaScript: no framework, no build step, no dependencies to install. The
home-page hero is a live three.js diorama of the shop.

## Run it locally

Any static server, from this folder:

```
npx serve .
# or
python3 -m http.server
```

Use a server rather than opening files directly. The diorama's module imports and the
`content/site.json` fetch need `http://`.

## Structure

```
index.html          Home: full-screen live diorama, brochure content below
services.html
builds.html
fabrication.html
process.html
about.html
faq.html
contact.html
diorama.html        The diorama alone, full screen, with the secret effects console

css/site.css        Resets, header scroll states, hover/focus states

js/site.js          Header: current-page marker, spacer under the fixed bar, clear→solid on home
js/home.js          Home hero: copy fade-in, "Explore the shop" mode, phone video fallback
js/diorama-console.js  /diorama console (↑ ↑ ↓ ↓ ← → ← → B A, Enter)
js/diorama.js       The 3D scene (three.js), a custom element: <shop-diorama>
js/shop-env.js      Live Papillion time, sunrise/sunset and weather (Open-Meteo)
js/cms-hydrate.js   Fills [data-cms] elements from content/site.json
js/image-slot.js    <image-slot> placeholder for photos not yet supplied

content/site.json   All copy, phone numbers, links and FAQ
content/MODEL.md    Content model + how to swap site.json for Contentful
assets/             Logo (and optional diorama-loop.mp4, see below)
```

## Conventions

- **Header and footer are written into every page.** There's no include step, so a menu
  change means editing all nine files (eight for the footer, since `diorama.html` has
  neither). Search for `data-header` and `<footer`.
- **Layout styling is inline**, carried over 1:1 from the approved designs. Hover and focus
  states can't be inline, so they're small classes in `css/site.css` (`hv-…`, `fv-…`). They
  use `!important` because inline styles outrank classes. When you refactor a section,
  move its inline styles into the stylesheet and the `!important`s can go.
- **Behaviour hooks are `data-` attributes**, never classes: `data-action="explore"`,
  `data-copy`, `data-when="live"`, `data-opt="wx:rain"`, `data-header`, `data-overlay`.
- **Content.** The copy is in the HTML, so pages work without JavaScript and search engines
  see real text. Elements carry `data-cms="path.to.field"`, and `js/cms-hydrate.js`
  overwrites them from `content/site.json` at load. Edit the JSON (or the HTML; they
  should match), or follow `content/MODEL.md` to point the loader at Contentful.

## The diorama

`js/diorama.js` registers `<shop-diorama>`. It loads three.js through the import map in the
page head and reads `window.SpectrumEnv` (from `shop-env.js`) for real time and weather.
Public methods on the element:

| method | does |
|---|---|
| `setExplore(on)` | embedded mode only: hand the scene the pointer (orbit, zoom, click-to-follow) or take it back |
| `setDayPhase(0…1 \| null)` | pin the time of day; `null` follows the real clock |
| `setWeather({...} \| null)` | pin weather; `null` follows the live feed |
| `setHoliday(key \| null)` | pin holiday dressing (`'halloween'`, `'christmas'`, `'none'`…); `null` follows the date |

With the `embedded` attribute (as on the home page) it ignores the pointer, so the mouse
wheel scrolls the page, until `setExplore(true)`.

On phones, `home.js` looks for `assets/diorama-loop.mp4`. If that file exists, it plays the
video instead of running the live scene. Record a 20–30 s loop of `diorama.html` to add one.

## Deploy

**GitHub Pages:** push this folder to a repo, then Settings → Pages → Deploy from a branch →
`main` / `(root)`. `.nojekyll` makes Pages serve the files as-is. URLs work with or
without `.html` (`/about` and `/about.html`).

**Netlify (no Git):** drag the folder onto https://app.netlify.com/drop.

## External services

- three.js 0.166.1 from unpkg (import map in `index.html` and `diorama.html`)
- Google Fonts: Newsreader, Archivo, JetBrains Mono
- Open-Meteo forecast API (no key)
- Google Maps embed on `contact.html`

## To do

- Real photography for every `<image-slot>` (each says what it's waiting for)
- Sean to confirm the open questions noted in `content/site.json`
