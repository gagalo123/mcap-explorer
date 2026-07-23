# Demo media

The screenshots in the top-level [README](../README.md)'s **Demo** section,
rendered from the bundled `examples/demo.mcap`. Regenerate with:

```bash
npm run gen-demo   # writes examples/demo.mcap + dist/demo-harness.html
```

then serve `dist/` over HTTP, open `demo-harness.html#<view>` and screenshot each
view (`#summary`, `#messages`, `#preview`, `#plot`) into `demo-<view>.png`. The
demo file uses a **PNG** camera topic so the preview renders anywhere — no
hardware video codec required.

- `demo-summary.png`, `demo-messages.png`, `demo-preview.png`, `demo-plot.png`

These PNGs are excluded from the packaged `.vsix` (see [`.vscodeignore`](../.vscodeignore));
the Marketplace loads them from their absolute raw URLs, so they never bloat the
extension. To feature motion instead, record the same views in the F5 dev host as
same-named `.gif` files and point the README links at them.
