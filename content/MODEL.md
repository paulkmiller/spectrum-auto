# Content model — Contentful (or any headless CMS) integration guide

The site ships as **plain static HTML with content baked in**, so it works with no
build step, no JS, and no network. The CMS layer is *additive*: it overlays content at
runtime (or at build time) onto nodes that are already annotated in the markup.

Three moving parts:

| Path | Role |
|---|---|
| `content/site.json` | Canonical content. Shape mirrors the Contentful model below 1:1. |
| `cms/hydrate.js` | Runtime overlay. Reads a payload, writes it into `[data-cms]` nodes, renders the announcement banner. |
| `*.dc.html` | Presentation. Every CMS-controlled node carries `data-cms="<path>"`. |

## Binding convention

Any element can be bound by adding a dotted/indexed path into `site.json`:

```html
<p data-cms="hero.sub">…baked-in copy…</p>
<a data-cms="settings.phone" data-cms-attr="href:settings.phoneHref">402-699-7400</a>
<span data-cms="services[3].title">Custom subwoofer enclosures</span>
```

- `data-cms="path"` → replaces `textContent` (or `innerHTML` if `data-cms-html` is present).
- `data-cms-attr="href:path, alt:path"` → sets attributes from paths.
- `data-cms-list="services"` → marks a repeater; `hydrate.js` clones the first child as the
  template and re-renders one per entry. Child bindings use paths relative to the item
  (`data-cms="title"`).
- `data-cms-slot="announcement"` → an empty container the banner renders into.

Because content is already in the HTML, a CMS outage or a missing key is a no-op rather
than a blank page.

## Contentful content types

### `siteSettings` (single entry)
`name` Symbol · `shortName` Symbol · `tagline` Symbol · `phone` Symbol · `email` Symbol ·
`street` Symbol · `city` Symbol · `state` Symbol · `zip` Symbol · `hours` Text ·
`bookingUrl` Symbol · `facebook` Symbol · `instagram` Symbol · `serviceArea` Text

`phoneHref` / `smsHref` are derived — generate them from `phone` in the mapper rather than
asking the editor for them twice.

### `announcement` (single entry — the site-wide banner)
`enabled` Boolean · `text` Symbol · `linkLabel` Symbol · `linkUrl` Symbol ·
`tone` Symbol (validation: `brass` | `neutral` | `alert`)

Toggling `enabled` is the "trigger a banner" mechanism. `hydrate.js` inserts it above the
header and offsets the sticky nav automatically.

### `service` (many, ordered)
`title` Symbol · `slug` Symbol (unique) · `blurb` Text · `featured` Boolean · `order` Integer

`featured` drives which five appear on the home page grid; the Services page lists all.

### `build` (many, ordered — gallery)
`title` Symbol · `slug` Symbol · `vehicle` Symbol · `summary` Text ·
`tags` Array<Symbol> · `image` Link<Asset> · `gallery` Array<Link<Asset>>

The static pages use `<image-slot id="…">` placeholders keyed by `imageId`. The mapper
should emit `{ imageId, imageUrl, imageAlt }` so `hydrate.js` can set the slot's `src`.

### `processStep` (many, ordered)
`step` Symbol · `title` Symbol · `body` Text

### `testimonial` (many)
`quote` Text · `author` Symbol · `vehicle` Symbol · `featured` Boolean

Currently an empty array — the Home and About pages hide the testimonial band when the
list is empty, so publishing the first entry is all that's needed to reveal it.

### `faqItem` (many, ordered)
`question` Symbol · `answer` Text · `order` Integer

### `page` (many — for CMS-authored new pages)
`title` Symbol · `slug` Symbol (unique) · `seoDescription` Text · `showInNav` Boolean ·
`navOrder` Integer · `sections` Array<Link<Entry>>

`sections` accepts the section types below, so a new page is composed from the same
vocabulary the built pages use — no new templates required:

- `sectionHero` — `eyebrow`, `headline`, `sub`, `primaryCtaLabel`, `primaryCtaUrl`, `image`
- `sectionProse` — `headline`, `body` (RichText), `pullQuote`
- `sectionNumberedList` — `headline`, `items` Array<Link<`processStep`>>
- `sectionCardGrid` — `headline`, `intro`, `items` Array<Link<`service`>>
- `sectionGallery` — `headline`, `items` Array<Link<`build`>>
- `sectionCta` — `headline`, `body`, `primaryCtaLabel`, `primaryCtaUrl`

`hydrate.js` exposes `window.SpectrumCMS.renderSection(type, data)` stubs for these; a
static-build integration should render them server-side instead.

## Wiring Contentful up

Runtime (zero build tooling — cheapest hosting):

```js
// cms/config.js
window.SPECTRUM_CMS = {
  source: 'contentful',
  space: 'YOUR_SPACE_ID',
  token: 'YOUR_CDA_TOKEN',   // Content Delivery API token — read-only, safe to ship
  environment: 'master'
};
```

`hydrate.js` checks for `window.SPECTRUM_CMS`; with no config it falls back to
`content/site.json`. The Contentful branch fetches
`/spaces/{space}/environments/{env}/entries?include=2`, flattens it into the same shape as
`site.json` via `mapContentful()`, and overlays identically.

Build time (preferred once there's a repo + CI): run the same `mapContentful()` in a Node
script, write the result to `content/site.json`, and let a webhook on Contentful's
`Entry.publish` event retrigger the deploy. The HTML then needs no JS at all — delete the
`hydrate.js` tag. This is why every field is baked into the markup: the runtime and
build-time paths produce byte-identical output.

## Adding a field checklist

1. Add it to the Contentful content type.
2. Add it to `mapContentful()` (and to `content/site.json` for the static fallback).
3. Add `data-cms="path"` to the element in the `.dc.html` template.

No template or component changes are needed for content-only edits.
