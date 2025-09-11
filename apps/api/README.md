# fridgie-api

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

To container:

```bash
rm -rf node_modules bun.lock
bun install --production
docker build -t fridgie:0.x .
```