# LinkReel

Paste a link to a product page or website. Get a motion video or ad.

LinkReel reads the page, has Claude write the script, and builds the video on the
[Vidmoat developer API](https://developer.vidmoat.com/developer/docs): kinetic type,
masked picture reveals, rolling counters, scene wipes and a music bed, in the brand's
own colours and pictures. The result plays instantly in the browser and renders to MP4
on request.

## Run it

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `VIDMOAT_KEY` and `ANTHROPIC_API_KEY`, then:

```bash
node --env-file=.env server/index.js
```

Open http://localhost:3000. Tests: `npm test`.

Keys come from <https://developer.vidmoat.com/apps> (Vidmoat) and
<https://console.anthropic.com> (Claude). Both stay on the server; the page only ever
talks to this app's own `/api`.

| Key | What you get |
| --- | --- |
| Vidmoat **test** key | Real projects and real previews, free. "Render" returns Vidmoat's sample file. |
| Vidmoat **live** key | Real MP4 renders, billed to your export allowance. Needs Studio, Team or Enterprise and an approved app. |
| No Anthropic key | Still works: the script is assembled from the page's headings instead of written. |

Deploy it anywhere that runs a long-lived Node 20+ process (Render, Railway, Fly, a VPS).
The app keeps no database: every video is a project on your Vidmoat account.

## How a video is made

```
link ─▶ scrape.js ─▶ pipeline.js ─▶ creative.js ─▶ compose.js + motion.js ─▶ Vidmoat
        read page     import          Claude writes   storyboard becomes       project,
        safely        pictures        a storyboard    timeline commands        preview, MP4
```

1. **Read** (`server/scrape.js`). Fetches the page with an SSRF guard (private ranges and
   every redirect hop are refused) and extracts the name, copy, pictures, logo, colours
   and structured product data.
2. **Collect** (`server/pipeline.js`). Pictures go into the Vidmoat library with
   `POST /v1/media/import` and are measured; tiny ones, banners and slivers are dropped.
3. **Write** (`server/creative.js`). Claude returns a storyboard as structured output:
   brand, palette, and scenes (`hook`, `feature`, `stat`, `cta`). It is then sanitised in
   code: lengths clamped, colours repaired for contrast, and any counter whose number is
   not on the page is demoted, so the model cannot put an invented statistic in an ad.
4. **Compose** (`server/compose.js`, `server/motion.js`). The storyboard becomes Vidmoat
   commands. Each scene is three clips: an HTML graphic behind, the picture, an HTML
   graphic in front. The HTML graphics are animated on Vidmoat's timeline clock
   (`--vm-t`), so the same CSS scrubs in the player and exports frame for frame.
5. **Preview**. The page embeds Vidmoat's player (`/embed/player`) and sends it the
   project document. Exact frames from `GET /v1/projects/{id}/preview` are the poster
   and the fallback. Both are free.
6. **Edit**. Change any line or colour and press *Apply changes*: the timeline is cleared
   and laid out again from the edited storyboard. No model call, no re-import.
7. **Render**. `POST /v1/renders`, then a five-second poll. A render already running for
   the project is picked up rather than queued twice.

Three art directions (`LOOKS` in `server/motion.js`): **Punch** (condensed type from
behind masks, highlight blocks, slab wipes), **Sleek** (soft light on a fine grid,
blur-in type, drawn underlines) and **Playful** (round type that pops, pills, an iris
wipe). Three canvases: 9:16, 1:1 and 16:9.

## Things to know before you put it in front of people

- **You pay for what visitors make.** Every project, imported picture and render is on
  your Vidmoat account. Creation and rendering are rate limited per visitor
  (`VIDEOS_PER_HOUR`, `RENDERS_PER_HOUR`), and `ACCESS_CODE` puts the whole thing behind
  a code. The limits live in memory, so they are per instance.
- **Projects and media are never deleted by this app.** Clear old `LinkReel · …` projects
  from your Vidmoat account when you need the space.
- **A video is protected by a token**, an HMAC of its project id. Without it the API
  answers 404, so one visitor cannot read, rebuild or render another's project.
- **Pages that need a login or render only in the browser** have nothing to read, and
  the app says so instead of guessing.
- **The pictures and words belong to the page's owner.** Make ads for sites you have the
  right to advertise.

## API

| Route | Does |
| --- | --- |
| `GET /api/config` | Formats, styles, lengths, and whether the keys are set. |
| `POST /api/videos` | `{url, format, style, length, goal, music}` → newline-delimited JSON: `step` events, then `done` with the video (and its `token`) or `error`. |
| `POST /api/videos/:id/rebuild` | Re-lay the project from an edited storyboard. |
| `GET /api/videos/:id/frame?at=` | One exact frame (JPEG). |
| `POST /api/videos/:id/render` | Queue the MP4. |
| `GET /api/videos/:id/renders/:renderId` | Render status and download URL. |

Everything under `/api/videos/:id` needs the video's token (`X-Video-Token` header or `token` query).
