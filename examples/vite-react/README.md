# Vite + React fixture

This fixture exercises the Keymaster Vite adapter with a React entry, CSS, an SVG, and a dynamic import. Build it from the workspace root with `pnpm build`, then validate its unsigned build with:

```sh
node examples/vite-react/static-server.mjs examples/vite-react/dist --allow-unsigned --remove-manifest
```

The server imports the `DeploymentRecord` before removing `.keymaster.json`; `/fixture/` is internally rewritten to the recorded index hash and all subsequent hash URLs are served from the record.
