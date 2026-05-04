# Contributing

Thanks for helping improve Recall. Keep changes focused, observable, and easy to review.

## Local Setup

```bash
npm ci
npm run build
npm link
```

## Before Opening a PR

Run the full local gate:

```bash
npm run docs:check
npm run typecheck
npm test
npm run build
```

For app changes, also run:

```bash
npm run build:app
```

## Pull Requests

- Explain the user-visible change and the verification you ran.
- Add or update tests when changing behavior.
- Keep docs current when commands, setup, release behavior, or public APIs change.
- Do not include generated local state such as `.recall/`, `dist/`, or build products.

## Project Shape

- CLI and daemon code live in [src/](src/).
- macOS app code lives in [macos/RecallApp/](macos/RecallApp/).
- Landing page and public docs live in [docs/](docs/).
- Release packaging lives in [scripts/](scripts/) and [packaging/](packaging/).
