<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Learning Library

A reusable learning platform with a React student reader and a SQLite-backed API.

## Run locally

1. Copy `.env.example` to `.env` and set a strong `ADMIN_PASSWORD`.
2. Install dependencies with `npm install`.
3. In one terminal run `npm run server`; in another run `npm run dev`.
4. Open `http://localhost:3000`, sign in with `ADMIN_EMAIL`, and choose **Admin**.

On Windows, the current directory name contains `&`, which some npm script launchers
mis-handle. If that affects your terminal, use these equivalent direct commands:

```powershell
node .\node_modules\tsx\dist\cli.mjs server.ts
node .\node_modules\vite\bin\vite.js --port 3000 --host 0.0.0.0
```

The API uses `data/learning-platform.sqlite` and uploaded images are stored in
`data/uploads`. These are persistent application data: back them up for a deployment.
The initial thermodynamics subject is seeded only when the database has no subjects.
It is never recreated after an admin deletes or archives it.

## Content model

Subjects contain chapters; chapters contain topics; topics contain ordered blocks.
The editor supports paragraphs, headings, formatted text, lists, tables, equations,
worked examples, and accessible images. Save edits as a draft, preview the reader,
then publish when ready. To add another subject, use **Admin → Subject**, add a
chapter, then add and edit its topics.

The approved simulation registry currently includes P–V processes and the Carnot
cycle. Attach them from a topic's editor; selecting **None** renders no lab area.
Adding a new simulation means implementing and registering a React component, not
placing executable code in content.

## Migration note

The supplied `Thermodynamics-8.docx` was inspected. The initial seed preserves the
project's existing structured thermodynamics lessons, but the source has ten chapters
while the existing structured data has nine. No source chapter was silently invented
or merged: complete the remaining source-to-topic mapping in the editor after review.
The Word document contains twenty embedded diagram images; they are not automatically
assigned to topics because their anchors/captions require a content-review pass. Upload
each verified diagram via the image block editor to preserve correct placement and
alternative text.
