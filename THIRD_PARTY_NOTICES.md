# Third-party notices

## Momose Hiyori PRO

- Provider: Live2D Inc.
- Illustration: Kani Biimu
- Source: https://www.live2d.com/zh-CHS/download/sample-data/
- The original Chinese readme is retained at `miniprogram/assets/live2d/hiyori/ReadMe.txt`.
- The model is not MIT-licensed. Individuals and qualifying small businesses may use it commercially only subject to Live2D's sample model terms; other restrictions may apply.
- The original `.moc3` is retained unchanged at `assets/live2d/hiyori_pro_t11.moc3`. The Mini Program imports a lossless Base64 JavaScript module generated from those bytes, avoiding package file-system reads. The two textures are resized from 2048 to 768 pixels for the WeChat Mini Program package.

## Live2D Cubism Core

- Provider: Live2D Inc.
- Source archive: Cubism SDK for Web 5-r.3
- Runtime: `miniprogram/vendor/live2d/live2dcubismcore.min.js`
- License: Live2D Proprietary Software License.
- A small CommonJS export and Mini Program-compatible Base64 decoder are added around the official runtime. Publication and business license conditions may apply when distributing the app.

## WebRTC VAD (libfvad)

- Provider: The WebRTC project authors, distributed by Echogarden as `@echogarden/fvad-wasm` 0.2.0.
- Source: https://github.com/echogarden-project/fvad-wasm
- Bundled binary: `miniprogram/vendor/fvad/fvad.wasm` (unmodified). The project supplies a Mini Program wrapper to instantiate it.
- License: BSD-3-Clause; full copyright and license text at `miniprogram/vendor/fvad/LICENSE`.
