import { defineDshConfig } from 'dsh-tauri-tsdown'

// Host stub (src/index.ts) + browser client bundle (src/client/index.ts)
// wrapped in the dsh-client-modules closure factory.
export default defineDshConfig()
