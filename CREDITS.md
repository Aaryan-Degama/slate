# Credits

Everything Slate uses that we didn't write during the event.

## Starter templates

| What | License | Used for |
|---|---|---|
| [Vite](https://vite.dev) `react-ts` template (`npm create vite`) | MIT | Initial React + TypeScript + Vite project layout |
| [create-amplify](https://www.npmjs.com/package/create-amplify) (`npm create amplify`) | Apache-2.0 | Initial Amplify Gen 2 backend folder |

## Libraries (npm)

| Package | Version | License |
|---|---|---|
| react, react-dom | 19.3.0 | MIT |
| vite | 8.3.0 | MIT |
| @vitejs/plugin-react | 6.1.1 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| aws-amplify | 6.20.0 | Apache-2.0 |
| @aws-amplify/ui-react (sign-in screen) | 6.15.6 | Apache-2.0 |
| @aws-amplify/backend, @aws-amplify/backend-cli | 1.25.0, 1.10.0 | Apache-2.0 |
| aws-cdk, aws-cdk-lib, constructs | 2.1142.0, 2.268.0, 10.8.1 | Apache-2.0 |
| @aws-sdk/client-s3, @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb, @aws-sdk/client-cognito-identity-provider | 3.1134.0 | Apache-2.0 |
| [@cedar-policy/cedar-wasm](https://github.com/cedar-policy/cedar) (Cedar policy engine, evaluates `policy.cedar` in the section-changes Lambda) | 4.13.0 | Apache-2.0 |
| [exceljs](https://github.com/exceljs/exceljs) (reads .xlsx/.csv, including merged cells, in the Lambdas) | 4.4.0 | MIT |
| esbuild | 0.28.2 | MIT |
| tsx | 4.23.13 | MIT |
| oxlint | 1.83.0 | MIT |
| http-proxy-agent, https-proxy-agent (local development behind a proxy only) | 9.1.0 | MIT |

## Libraries (Python, `slate/scripts/bedrock-normalize-timetable.py`)

| Package | License |
|---|---|
| boto3 | Apache-2.0 |

## Fonts

- **DM Sans** and **Playfair Display**, from Google Fonts. SIL Open Font License 1.1.

## Design

- The colour palette, typography and dashboard layout were adapted from **UniClass**, a project by our teammate Degama.
- Our research into how existing scheduling tools present timetables (Banner, PeopleSoft, Coursedog, Ad Astra, Scientia, aSc Timetables) shaped the grid and editor, but no code or assets were taken from them.

## Data

- Timetables are the official IIIT Allahabad sheets for July–December 2026 (IT and ECE departments), used as published.
- Student section data comes from lists the team provided; roll ranges come from the timetable sheets themselves where printed.
- No personal data beyond roll number → section is stored.

## AI tools

- **Claude Code** (Anthropic), using the Claude Sonnet 5 and Claude Opus 5 models. It was used throughout: designing and writing most of the backend (schema, authorization, the four Lambdas including the timetable reader, the registration matcher and the slot finder), the frontend screens, the data-audit scripts, debugging, deployment, and these docs. The team set direction, supplied and checked the real data against their own timetables, caught extraction errors, and made the product decisions.
<!-- Teammates: add any other AI tools you used (e.g. for your own parts of the frontend). The rules require every one to be listed. -->
