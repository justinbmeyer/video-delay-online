# Video Delay

A web app that shows your camera feed on a delay of up to 2 minutes, so you can prop up your phone, hit start, and review your form (workouts, dance, sports, presentations).

**Live site:** https://justinbmeyer.github.io/video-delay-online/

## Features

- Adjustable delay from 1 second to 2 minutes, with presets (5s, 10s, 30s, 1m, 1:30, 2m)
- Front/back camera flip and mirror mode
- Optional live preview alongside the delayed view
- Fullscreen button (on iPhone, the delayed canvas is streamed into a `<video>` so Safari's native video fullscreen can show it)
- Installable as a PWA with offline support
- Everything runs locally in the browser; no video is uploaded anywhere

## How it works

Holding two minutes of raw video in memory is impractical, so frames are compressed on the fly. [`DelayEngine`](src/delay-engine.ts) encodes camera frames with WebCodecs (`VideoEncoder`, preferring hardware H.264) into a rolling buffer of compressed chunks, then decodes them with `VideoDecoder` onto a canvas once they are `delayMs` old.

## Requirements

A browser with WebCodecs and `requestVideoFrameCallback` support (`VideoEncoder`, `VideoDecoder`, `VideoFrame`), such as recent Chrome, Edge, or Safari. Camera access requires HTTPS.

## Development

```sh
npm install
npm run dev      # Vite dev server on the LAN, served over HTTPS
npm run build    # type-check and build to dist/
npm run preview  # preview the production build
```

The dev server uses a self-signed certificate, since phones only allow camera access over HTTPS. Open the printed network URL on your phone and accept the certificate warning.

## Deployment

Pushing to `main` triggers [the GitHub Actions workflow](.github/workflows/deploy.yml), which builds the app and publishes it to GitHub Pages. The repo's Pages source must be set to **GitHub Actions** (not "Deploy from a branch"), otherwise the unbuilt source is published. The build also generates a service worker that precaches all assets for offline use.

The short commit hash of the running build is shown on the start screen and under the controls, so you can confirm a deploy has reached your device.
