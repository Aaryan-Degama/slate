// Must be imported before anything that calls generateClient() (e.g.
// NewRequest.tsx) — ES modules evaluate dependency-first, so a plain
// `Amplify.configure()` call sitting in main.tsx's own body runs *after*
// App.tsx (and its children) have already been evaluated, too late for
// any top-level generateClient() call in them.
import { Amplify } from 'aws-amplify'
import outputs from '../amplify_outputs.json'

Amplify.configure(outputs)
